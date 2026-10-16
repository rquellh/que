// The claude wrapper the daemon writes to <QUE_HOME>/bin, run for real under
// /bin/sh against the fake claude: what it hands off to, what it adds inside a
// workspace, and what happens when another claude wrapper on PATH (the kind
// that looks past its own directory) hands the command straight back to it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWrapper } from '@daemon/wrapper'
import { ensureDirs, quePaths, type QuePaths } from '@shared/paths'
import { FAKE_WRAPPERS, FAKES_BIN, readFakeLog, readWrapperLog } from '../testing/fakes'

const NODE_DIR = dirname(process.execPath)
const WORKSPACE_ID = 'ws_01hzx3k9c2qf'

let home: string
let paths: QuePaths
let claudeLog: string
let wrapperLog: string

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-wrapper-')))
  vi.stubEnv('QUE_HOME', home)
  paths = ensureDirs(quePaths())
  claudeLog = join(home, 'fake-claude.log')
  wrapperLog = join(home, 'fake-wrapper.log')
  // bin/que is written too but never run here; the CLI path is only embedded.
  installWrapper({ paths, nodePath: process.execPath, cliScript: join(home, 'cli.js') })
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Runs bin/claude with an explicit environment (nothing inherited from the
 * test process). A run that is still going after 10 s has its whole process
 * group killed, so a wrapper loop fails the test instead of hanging it.
 */
function runWrapper(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(paths.binDir, 'claude'), args, {
      env: {
        HOME: home,
        PATH: [paths.binDir, FAKES_BIN, NODE_DIR, '/usr/bin', '/bin'].join(':'),
        QUE_FAKE_CLAUDE_LOG: claudeLog,
        QUE_FAKE_WRAPPER_LOG: wrapperLog,
        QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(home, 'transcripts'),
        ...env
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const watchdog = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    }, 10_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(watchdog)
      resolve({ code, stdout, stderr })
    })
  })
}

/** PATH as in a workspace terminal on a machine where another tool's wrapper sits in front of claude. */
const PATH_WITH_OTHER_WRAPPER = (): string =>
  [paths.binDir, FAKE_WRAPPERS, FAKES_BIN, NODE_DIR, '/usr/bin', '/bin'].join(':')

describe('bin/claude', () => {
  it('hands off to the claude on PATH with --settings inside a workspace', async () => {
    const r = await runWrapper(['--version'], { QUE_WORKSPACE_ID: WORKSPACE_ID })

    expect(r).toEqual({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' })
    expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([
      ['--settings', paths.hooksJson, '--version']
    ])
  })

  it('is transparent outside a workspace', async () => {
    const r = await runWrapper(['--version'], {})

    expect(r).toEqual({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' })
    expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([['--version']])
  })

  it('runs QUE_REAL_CLAUDE, the claude the daemon resolved, ahead of PATH order', async () => {
    const r = await runWrapper(['--version'], {
      QUE_WORKSPACE_ID: WORKSPACE_ID,
      PATH: PATH_WITH_OTHER_WRAPPER(),
      QUE_REAL_CLAUDE: join(FAKES_BIN, 'claude')
    })

    expect(r.code).toBe(0)
    expect(readFakeLog(claudeLog)).toHaveLength(1)
    expect(readWrapperLog(wrapperLog)).toEqual([])
  })

  it('reaches claude once when the wrapper ahead of it on PATH hands the command back', async () => {
    // The daemon pins QUE_REAL_CLAUDE to the first claude on its PATH: the
    // other wrapper. That wrapper skips only its own directory, so it finds
    // que's wrapper again, in the same process.
    const r = await runWrapper(['--version'], {
      QUE_WORKSPACE_ID: WORKSPACE_ID,
      PATH: PATH_WITH_OTHER_WRAPPER(),
      QUE_REAL_CLAUDE: join(FAKE_WRAPPERS, 'claude')
    })

    expect(r).toEqual({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' })
    const claudeCalls = readFakeLog(claudeLog)
    expect(claudeCalls.map((c) => c.argv)).toEqual([['--settings', paths.hooksJson, '--version']])
    expect(readWrapperLog(wrapperLog)).toEqual([
      { pid: claudeCalls[0].pid, args: `--settings ${paths.hooksJson} --version` }
    ])
  })

  it('gives up with a message instead of looping when the other wrapper spawns claude', async () => {
    const r = await runWrapper(['--version'], {
      QUE_WORKSPACE_ID: WORKSPACE_ID,
      PATH: PATH_WITH_OTHER_WRAPPER(),
      QUE_REAL_CLAUDE: join(FAKE_WRAPPERS, 'claude'),
      QUE_FAKE_WRAPPER_STYLE: 'spawn'
    })

    expect(r.code).toBe(127)
    expect(r.stderr).toMatch(
      /^que: \d+ claude wrappers have handed off to each other without reaching Claude Code; set QUE_REAL_CLAUDE to the real executable\n$/
    )
    expect(readFakeLog(claudeLog)).toEqual([])
  })

  describe('instructions and permission mode', () => {
    it('appends the instructions file and passes the permission mode inside a workspace', async () => {
      const instructions = join(home, 'instructions', 'delegation.md')
      fs.mkdirSync(dirname(instructions), { recursive: true })
      fs.writeFileSync(instructions, 'Delegate searches to a smaller model.\n')

      const r = await runWrapper(['--resume', 'sess_8c1d2e'], {
        QUE_WORKSPACE_ID: WORKSPACE_ID,
        QUE_INSTRUCTIONS: instructions,
        QUE_PERMISSION_MODE: 'acceptEdits'
      })

      expect(r.code).toBe(0)
      expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([
        [
          '--settings',
          paths.hooksJson,
          '--append-system-prompt-file',
          instructions,
          '--permission-mode',
          'acceptEdits',
          '--resume',
          'sess_8c1d2e'
        ]
      ])
    })

    it('leaves out an instructions file that does not exist yet', async () => {
      const r = await runWrapper(['--version'], {
        QUE_WORKSPACE_ID: WORKSPACE_ID,
        QUE_INSTRUCTIONS: join(home, 'missing', 'instructions.md')
      })

      expect(r.code).toBe(0)
      expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([
        ['--settings', paths.hooksJson, '--version']
      ])
    })

    it("keeps the user's own --permission-mode instead of adding a second one", async () => {
      const r = await runWrapper(['--permission-mode', 'plan', '--version'], {
        QUE_WORKSPACE_ID: WORKSPACE_ID,
        QUE_PERMISSION_MODE: 'acceptEdits'
      })

      expect(r.code).toBe(0)
      expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([
        ['--settings', paths.hooksJson, '--permission-mode', 'plan', '--version']
      ])
    })

    it('keeps --dangerously-skip-permissions without adding a permission mode', async () => {
      const r = await runWrapper(['--dangerously-skip-permissions', '--version'], {
        QUE_WORKSPACE_ID: WORKSPACE_ID,
        QUE_PERMISSION_MODE: 'acceptEdits'
      })

      expect(r.code).toBe(0)
      expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([
        ['--settings', paths.hooksJson, '--dangerously-skip-permissions', '--version']
      ])
    })

    it('adds neither outside a workspace', async () => {
      const instructions = join(home, 'instructions.md')
      fs.writeFileSync(instructions, 'Delegate searches to a smaller model.\n')

      const r = await runWrapper(['--version'], {
        QUE_INSTRUCTIONS: instructions,
        QUE_PERMISSION_MODE: 'acceptEdits'
      })

      expect(r.code).toBe(0)
      expect(readFakeLog(claudeLog).map((c) => c.argv)).toEqual([['--version']])
    })
  })

  it('reports a missing claude', async () => {
    const r = await runWrapper(['--version'], {
      PATH: [paths.binDir, NODE_DIR, '/usr/bin', '/bin'].join(':')
    })

    expect(r).toEqual({
      code: 127,
      stdout: '',
      stderr: `que: could not find the claude executable on PATH (outside ${paths.binDir})\n`
    })
  })
})
