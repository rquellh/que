// The in-process daemon for integration tests (vitest-testing skill, 5a): a
// fresh temp QUE_HOME, the fakes first on PATH, the real DaemonServer on the
// home's socket, and a connected DaemonClient. close() tears it all down and
// runs the leak check. The hooks wrapper's bin/que runs the CLI bundled from
// source, and the user config lives at <home>/config.toml (QUE_CONFIG). Git
// gets a fixed identity from <home>/gitconfig (GIT_CONFIG_GLOBAL), so commits
// made by the finisher or the fake claude never depend on the machine's config.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { DaemonServer } from '@daemon/server'
import { DaemonClient } from '@shared/client'
import { ensureDirs, quePaths } from '@shared/paths'
import { bundleEntry } from './bundle'
import { FAKES_BIN } from './fakes'
import { assertPidsGone, LeakCheckedPtyHost } from './leak-check'

export interface TestDaemon {
  /** The temp QUE_HOME; removed by close(). */
  home: string
  /** The daemon socket inside `home`. */
  socket: string
  host: LeakCheckedPtyHost
  server: DaemonServer
  client: DaemonClient
  /** Where the fakes record their calls (read with readFakeLog / readWrapperLog). */
  claudeLog: string
  ghLog: string
  /** The fake gh's pull requests (QUE_FAKE_GH_PRS), keyed by branch; see setFakePullRequest. */
  ghPrs: string
  /** The fake acli's call log and issue file (QUE_FAKE_ACLI_LOG / QUE_FAKE_ACLI_TICKETS). */
  acliLog: string
  acliTickets: string
  codeLog: string
  caffeinateLog: string
  wrapperLog: string
  /** QUE_CONFIG for this daemon (always written; see withQuietOff). */
  configPath: string
  /**
   * Tears down client, terminals, task runs, server, env, and home; fails on
   * leaked pids. `keepHome` leaves QUE_HOME for a second daemon (restart tests).
   */
  close(opts?: { keepHome?: boolean }): Promise<void>
}

/**
 * Quiet hours default to on (19:00-07:00), which would refuse terminal detail
 * whenever a suite runs in the evening. Test daemons turn them off unless a
 * test's own config has a [quiet_hours] table.
 */
export const QUIET_OFF = '\n[quiet_hours]\nenabled = false\n'

/**
 * Sidebar-title summaries default to on, which would run the fake claude in the
 * background and replace every brief title while a test reads it. Test daemons
 * turn them off unless a test's own config sets `summaries`.
 */
export const SUMMARIES_OFF = 'summaries = false\n'

/**
 * A test config with quiet hours off unless it sets its own [quiet_hours], and
 * summaries off unless it sets `summaries` (top-level keys go first, before any table).
 */
export function withQuietOff(config = ''): string {
  const summaries = /^summaries\s*=/m.test(config) ? '' : SUMMARIES_OFF
  return `${summaries}${config.includes('[quiet_hours]') ? config : `${config}${QUIET_OFF}`}`
}

export interface TestDaemonOptions {
  /** Called after daemon.shutdown's response is flushed. */
  onShutdown?: () => void
  /** config.toml contents, written before the daemon starts (quiet hours and summaries off unless set). */
  config?: string
  /** The clock quiet hours and the summary throttle read (e.g. real time shifted ahead). */
  now?: () => number
  /** Quiet-hours re-evaluation interval. Default 200 ms (the daemon's is 15 s). */
  quietTickMs?: number
  /** Status engine stall-check interval. Default 200 ms (the daemon's is 5 s). */
  statusTickMs?: number
  /** Reuse this QUE_HOME (from a daemon closed with keepHome) instead of a fresh one. */
  home?: string
  /** Directories put ahead of the fakes on the daemon's PATH (e.g. FAKE_WRAPPERS). */
  pathPrefix?: string[]
  /** Draws the names of workspaces created without one (e.g. scripted, to force clashes). */
  randomWorkspaceName?: () => string
}

export async function startTestDaemon(opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const home = opts.home ?? fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-it-')))
  const claudeLog = join(home, 'fake-claude.log')
  const ghLog = join(home, 'fake-gh.log')
  const ghPrs = join(home, 'fake-gh-prs.json')
  const acliLog = join(home, 'fake-acli.log')
  const acliTickets = join(home, 'fake-acli-tickets.json')
  const codeLog = join(home, 'fake-code.log')
  const caffeinateLog = join(home, 'fake-caffeinate.log')
  const wrapperLog = join(home, 'fake-wrapper.log')
  const gitconfig = join(home, 'gitconfig')
  fs.writeFileSync(
    gitconfig,
    '[user]\n\tname = que test\n\temail = test@que.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n'
  )
  vi.stubEnv('QUE_HOME', home)
  vi.stubEnv('PATH', [...(opts.pathPrefix ?? []), FAKES_BIN, process.env.PATH].join(':'))
  vi.stubEnv('QUE_FAKE_CLAUDE_LOG', claudeLog)
  vi.stubEnv('QUE_FAKE_GH_LOG', ghLog)
  vi.stubEnv('QUE_FAKE_GH_PRS', ghPrs)
  vi.stubEnv('QUE_FAKE_ACLI_LOG', acliLog)
  vi.stubEnv('QUE_FAKE_ACLI_TICKETS', acliTickets)
  vi.stubEnv('QUE_FAKE_CODE_LOG', codeLog)
  vi.stubEnv('QUE_FAKE_CAFFEINATE_LOG', caffeinateLog)
  vi.stubEnv('QUE_FAKE_WRAPPER_LOG', wrapperLog)
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('QUE_FAKE_CLAUDE_TRANSCRIPT_DIR', join(home, 'transcripts'))
  const configPath = join(home, 'config.toml')
  vi.stubEnv('QUE_CONFIG', configPath)
  vi.stubEnv('QUE_NODE', process.execPath)
  fs.writeFileSync(configPath, withQuietOff(opts.config))

  const paths = ensureDirs(quePaths())
  const host = new LeakCheckedPtyHost()
  const server = new DaemonServer({
    host,
    version: 'test',
    onShutdown: opts.onShutdown,
    cliScript: bundleEntry('src/cli/index.ts'),
    statusTickMs: opts.statusTickMs ?? 200,
    queueTickMs: 100,
    dispatchMs: 100,
    quietTickMs: opts.quietTickMs ?? 200,
    now: opts.now,
    randomWorkspaceName: opts.randomWorkspaceName
  })
  await server.listen(paths.socket)
  const client = new DaemonClient(paths.socket)
  await client.connect()

  let closed = false
  return {
    home,
    socket: paths.socket,
    host,
    server,
    client,
    claudeLog,
    ghLog,
    ghPrs,
    acliLog,
    acliTickets,
    codeLog,
    caffeinateLog,
    wrapperLog,
    configPath,
    async close(closeOpts = {}) {
      if (closed) return
      closed = true
      const taskPids = server.tasks.pids()
      client.close()
      host.killAll()
      await server.close()
      vi.unstubAllEnvs()
      try {
        await assertPidsGone([...host.pids, ...taskPids])
      } finally {
        if (!closeOpts.keepHome) fs.rmSync(home, { recursive: true, force: true })
      }
    }
  }
}
