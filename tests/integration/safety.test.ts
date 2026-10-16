// What que guarantees about the machine it runs on: an owner-only socket,
// nothing written outside QUE_HOME, and no processes left behind.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '@shared/client'
import { quePaths } from '@shared/paths'
import { type MethodName, QUIET_REFUSED_METHODS } from '@shared/protocol'
import { bundleEntry } from '../../src/testing/bundle'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { FAKES_BIN } from '../../src/testing/fakes'
import { runCliWith } from '../../src/testing/cli'
import { assertPidsGone, pidAlive } from '../../src/testing/leak-check'

// Captured before any test stubs HOME. Only ever read, never written.
const REAL_QUE_HOME = join(os.homedir(), '.que')

function statOrNull(path: string): { mtimeMs: number } | null {
  try {
    return { mtimeMs: fs.statSync(path).mtimeMs }
  } catch {
    return null
  }
}

/** Every path under `dir`, relative to it. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
}

describe('safety', () => {
  describe('in-process daemon', () => {
    let daemon: TestDaemon

    beforeEach(async () => {
      daemon = await startTestDaemon()
    })

    afterEach(async () => {
      await daemon.close()
    })

    it('creates the socket owner-only (0600)', () => {
      expect(fs.statSync(daemon.socket).mode & 0o777).toBe(0o600)
    })

    it('leaves no terminal process alive after killAll()', async () => {
      for (const name of ['uploader', 'api', 'docs']) {
        await daemon.client.request('term.create', {
          file: '/bin/sh',
          args: ['-c', 'sleep 30'],
          name,
          cols: 80,
          rows: 24
        })
      }
      const pids = (await daemon.client.request('term.list')).map((t) => t.pid)
      expect(pids).toHaveLength(3)
      expect(pids.every(pidAlive)).toBe(true)

      daemon.host.killAll()

      await expect.poll(() => pids.filter(pidAlive), { timeout: 5_000 }).toEqual([])
    }, 20_000)
  })

  describe('daemon process', () => {
    let fakeHome: string
    let queHome: string
    let configDir: string
    let realQueBefore: { mtimeMs: number } | null
    let client: DaemonClient | null
    let daemonPid: number | null

    beforeEach(async () => {
      realQueBefore = statOrNull(REAL_QUE_HOME)
      fakeHome = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-safety-home-')))
      queHome = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-safety-qh-')))
      // Never the user's config, and quiet hours off so the suite runs at any hour.
      configDir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-safety-cfg-')))
      fs.writeFileSync(join(configDir, 'config.toml'), '[quiet_hours]\nenabled = false\n')
      vi.stubEnv('QUE_CONFIG', join(configDir, 'config.toml'))
      vi.stubEnv('HOME', fakeHome)
      vi.stubEnv('QUE_HOME', queHome)
      vi.stubEnv('PATH', `${FAKES_BIN}:${process.env.PATH}`)

      client = await DaemonClient.connectOrStart({
        paths: quePaths(),
        runtime: process.execPath,
        daemonScript: bundleEntry('src/daemon/index.ts'),
        timeoutMs: 10_000
      })
      daemonPid = (await client.request('daemon.ping')).pid
    }, 20_000)

    afterEach(async () => {
      client?.close()
      // Stop a daemon a failed test left running, by its own pid only.
      if (daemonPid !== null && pidAlive(daemonPid)) process.kill(daemonPid, 'SIGTERM')
      if (daemonPid !== null) await assertPidsGone([daemonPid], 5_000)
      vi.unstubAllEnvs()
      fs.rmSync(fakeHome, { recursive: true, force: true })
      fs.rmSync(queHome, { recursive: true, force: true })
      fs.rmSync(configDir, { recursive: true, force: true })
    }, 20_000)

    it('runs as its own process and records its pid in QUE_HOME', () => {
      expect(daemonPid).not.toBe(process.pid)
      expect(fs.readFileSync(join(queHome, 'daemon.pid'), 'utf8').trim()).toBe(String(daemonPid))
    })

    it('writes nothing outside QUE_HOME', async () => {
      const c = client as DaemonClient
      const { id } = await c.request('term.create', {
        file: '/bin/sh',
        args: ['-c', 'printf QUE_SAFETY_2d9c; sleep 30'],
        cwd: queHome,
        cols: 80,
        rows: 24
      })
      await expect
        .poll(async () => (await c.request('term.snapshot', { id })).text, { timeout: 10_000 })
        .toContain('QUE_SAFETY_2d9c')

      await c.request('daemon.shutdown')
      await expect.poll(() => pidAlive(daemonPid as number), { timeout: 10_000 }).toBe(false)

      expect(walk(fakeHome)).toEqual([])
      expect(statOrNull(REAL_QUE_HOME)).toEqual(realQueBefore)
      expect(walk(queHome)).toEqual([
        'bin',
        join('bin', 'claude'),
        join('bin', 'que'),
        'hooks.json',
        'logs',
        join('logs', 'daemon.log'),
        'que.db',
        'shell',
        join('shell', 'zsh'),
        join('shell', 'zsh', '.zlogin'),
        join('shell', 'zsh', '.zprofile'),
        join('shell', 'zsh', '.zshenv'),
        join('shell', 'zsh', '.zshrc'),
        'system.md'
      ])
      expect(fs.statSync(join(queHome, 'bin', 'claude')).mode & 0o777).toBe(0o755)
      expect(fs.statSync(join(queHome, 'bin', 'que')).mode & 0o777).toBe(0o755)
    }, 30_000)

    it('is gone after daemon.shutdown, and so are its terminals', async () => {
      const c = client as DaemonClient
      await c.request('term.create', {
        file: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cols: 80,
        rows: 24
      })
      const termPids = (await c.request('term.list')).map((t) => t.pid)
      const pid = Number(fs.readFileSync(join(queHome, 'daemon.pid'), 'utf8').trim())
      expect(pidAlive(pid)).toBe(true)

      expect(await c.request('daemon.shutdown')).toEqual({ ok: true })

      await expect.poll(() => pidAlive(pid), { timeout: 10_000 }).toBe(false)
      await assertPidsGone(termPids)
      expect(fs.existsSync(join(queHome, 'daemon.pid'))).toBe(false)
      expect(fs.existsSync(join(queHome, 'daemon.sock'))).toBe(false)
    }, 30_000)
  })
})

/**
 * Every daemon method, and whether quiet hours (locked) refuse it. A Record
 * over MethodName, so a new method does not compile until it is classified.
 */
const QUIET_POLICY: Record<MethodName, 'refused' | 'allowed'> = {
  'term.attach': 'refused',
  'term.snapshot': 'refused',
  'term.create': 'refused',
  'workspace.openTerminal': 'refused',
  'workspace.createPr': 'refused',
  'workspace.diff': 'refused',
  'workspace.prThread': 'refused',
  'workspace.files': 'refused',
  'workspace.readFile': 'refused',
  'report.get': 'refused',
  'task.add': 'refused',
  'queue.open': 'refused',
  'daemon.ping': 'allowed',
  'daemon.shutdown': 'allowed',
  'term.list': 'allowed',
  'term.detach': 'allowed',
  'term.write': 'allowed',
  'term.resize': 'allowed',
  'term.kill': 'allowed',
  'project.add': 'allowed',
  'project.list': 'allowed',
  'project.remove': 'allowed',
  'workspace.create': 'allowed',
  'workspace.list': 'allowed',
  'workspace.get': 'allowed',
  'workspace.remove': 'allowed',
  'workspace.watch': 'allowed',
  'workspace.unwatch': 'allowed',
  'hook.event': 'allowed',
  'task.list': 'allowed',
  'task.get': 'allowed',
  'task.stop': 'allowed',
  'task.remove': 'allowed',
  'queue.close': 'allowed',
  'queue.state': 'allowed',
  'quiet.state': 'allowed',
  'quiet.unlock': 'allowed',
  'quiet.lock': 'allowed',
  'quiet.log': 'allowed',
  'config.get': 'allowed',
  'config.set': 'allowed',
  'instructions.get': 'allowed',
  'instructions.set': 'allowed',
  'tickets.list': 'allowed',
  'tickets.sync': 'allowed',
  'tickets.projectFor': 'allowed',
  'tickets.start': 'refused'
}

describe('safety: quiet hours', () => {
  let daemon: TestDaemon

  beforeEach(async () => {
    // Wed 14 Oct 2026, 02:00 (shifted real time): inside the 19:00-07:00 window.
    const offset = new Date(2026, 9, 14, 2, 0).getTime() - Date.now()
    daemon = await startTestDaemon({
      config: '[quiet_hours]\nenabled = true\ndefault = ["19:00", "07:00"]\n',
      now: () => Date.now() + offset
    })
  })

  afterEach(async () => {
    await daemon.close()
  })

  it('refuses exactly the detail methods', () => {
    const refused = Object.entries(QUIET_POLICY)
      .filter(([, p]) => p === 'refused')
      .map(([m]) => m)

    expect([...QUIET_REFUSED_METHODS].sort()).toEqual(refused.sort())
  })

  it.each(Object.entries(QUIET_POLICY).filter(([m]) => m !== 'daemon.shutdown'))(
    '%s is %s while quiet and locked',
    async (method, policy) => {
      // Placeholder params: a refused method must fail before it looks at them.
      // Each case gets its own daemon, so an unlock here cannot leak into another.
      const outcome = await daemon.client.request(method as MethodName, {} as never).then(
        () => 'ok',
        (e: { code?: string }) => e.code ?? 'error'
      )

      expect(outcome === 'quiet_hours' ? 'refused' : 'allowed').toBe(policy)
    }
  )
})

describe('safety: hooks wrapper', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-safety-hook-')))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const hookJson = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
    cwd: '/Users/dev/.que/worktrees/uploader/app-1432-retry-logic',
    tool_name: 'Bash'
  })

  it('`que hook` exits 0 silently when no daemon is listening', async () => {
    const r = await runCliWith(
      {
        input: hookJson,
        env: {
          QUE_HOME: dir,
          QUE_WORKSPACE_ID: 'ws_a2b3c4d5e6f7',
          QUE_SOCKET: join(dir, 'none.sock')
        }
      },
      'hook'
    )

    expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(fs.readdirSync(dir)).toEqual([])
  }, 20_000)

  it('`que hook` gives up within its budget when the daemon never answers', async () => {
    const socket = join(dir, 'mute.sock')
    // Reads requests and never answers.
    const mute = net.createServer((conn) => conn.resume())
    await new Promise<void>((r) => mute.listen(socket, r))
    const started = Date.now()

    const r = await runCliWith(
      {
        input: hookJson,
        env: { QUE_HOME: dir, QUE_WORKSPACE_ID: 'ws_a2b3c4d5e6f7', QUE_SOCKET: socket }
      },
      'hook'
    )

    const elapsed = Date.now() - started
    await new Promise<void>((r) => mute.close(() => r()))
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(elapsed).toBeLessThan(5_000)
  }, 20_000)

  it('the claude wrapper refuses (127) rather than run itself when no real claude is on PATH', async () => {
    const daemon = await startTestDaemon()
    try {
      const wrapper = join(daemon.home, 'bin', 'claude')
      const r = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        execFile(
          wrapper,
          ['--version'],
          {
            env: {
              PATH: `${join(daemon.home, 'bin')}:/usr/bin:/bin`,
              QUE_WORKSPACE_ID: 'ws_a2b3c4d5e6f7'
            }
          },
          (err, _stdout, stderr) =>
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stderr })
        )
      })

      expect(r.code).toBe(127)
      expect(r.stderr).toContain('que: could not find the claude executable')
    } finally {
      await daemon.close()
    }
  }, 20_000)
})
