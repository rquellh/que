// The subprocess fakes are test infrastructure every runner test will lean on;
// this pins their behavior to what tests/fakes/README.md promises.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FAKES_BIN, readFakeLog } from './fakes'
import { gitIn } from './temp-repo'

const CLAUDE = join(FAKES_BIN, 'claude')
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd'
]

let dir: string
let hookLog: string
let settings: string
const children: ChildProcess[] = []

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'que-fakes-')))
  hookLog = join(dir, 'hooks.jsonl')
  const recorder = join(dir, 'record-hook.cjs')
  fs.writeFileSync(
    recorder,
    "let s='';process.stdin.on('data',(c)=>(s+=c));process.stdin.on('end',()=>require('node:fs').appendFileSync(process.argv[2],JSON.stringify({marker:process.env.QUE_TEST_MARKER,payload:JSON.parse(s)})+'\\n'))\n"
  )
  const command = `'${process.execPath}' '${recorder}' '${hookLog}'`
  settings = JSON.stringify({
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, [{ matcher: '', hooks: [{ type: 'command', command }] }]])
    )
  })
})

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: dir,
        env: { ...process.env, QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(dir, 'tr'), ...env },
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout,
          stderr
        })
      }
    ).stdin?.end()
  })
}

/** Starts a fake claude that is expected to block, collecting its stdout. */
function start(args: string[], env: Record<string, string>): { proc: ChildProcess; out: string[] } {
  const proc = spawn(CLAUDE, args, {
    cwd: dir,
    env: { ...process.env, QUE_FAKE_CLAUDE_TRANSCRIPT_DIR: join(dir, 'tr'), ...env }
  })
  children.push(proc)
  const out: string[] = []
  proc.stdout?.on('data', (c: Buffer) => out.push(c.toString('utf8')))
  return { proc, out }
}

function exitCode(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
}

function hooks(): { marker?: string; payload: Record<string, unknown> }[] {
  if (!fs.existsSync(hookLog)) return []
  return fs
    .readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const hookNames = () => hooks().map((h) => h.payload.hook_event_name)

function stream(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const headless = (prompt: string, ...extra: string[]) => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  '--settings',
  settings,
  ...extra
]

describe('fake claude', () => {
  describe('scenarios', () => {
    it('success: streams init → assistant → result, writes the change, fires hooks in order', async () => {
      const prompt = 'Add retry logic to the uploader'
      const r = await run(
        CLAUDE,
        headless(prompt, '--session-id', 'b3c1d2e4-0000-4000-8000-1a2b3c4d5e6f'),
        {
          QUE_TEST_MARKER: 'm_51f2'
        }
      )

      expect(r.code).toBe(0)
      const msgs = stream(r.stdout)
      expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'init', cwd: dir })
      expect(msgs.at(-1)).toMatchObject({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.0123,
        session_id: 'b3c1d2e4-0000-4000-8000-1a2b3c4d5e6f',
        stop_reason: 'end_turn',
        result: `Done: ${prompt}`
      })
      expect(fs.readFileSync(join(dir, 'que-fake-change.txt'), 'utf8')).toBe(prompt)
      expect(hookNames()).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SessionEnd'
      ])
      for (const { marker, payload } of hooks()) {
        expect(marker).toBe('m_51f2')
        expect(payload).toMatchObject({
          session_id: 'b3c1d2e4-0000-4000-8000-1a2b3c4d5e6f',
          cwd: dir,
          permission_mode: 'default'
        })
        expect(fs.existsSync(payload.transcript_path as string)).toBe(true)
      }
      expect(hooks()[2].payload).toMatchObject({
        tool_name: 'Write',
        tool_input: { content: prompt }
      })
    }, 20_000)

    it('stall: stops after one assistant message and exits 143 on SIGTERM', async () => {
      const { proc, out } = start(headless('Refactor the queue'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'stall'
      })
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('"type":"assistant"')

      proc.kill('SIGTERM')

      expect(await exitCode(proc)).toBe(143)
      expect(out.join('')).not.toContain('"type":"result"')
    }, 20_000)

    it('rate_limit: reports the limit, fires StopFailure, then hangs', async () => {
      const { proc, out } = start(headless('Refactor the queue'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'rate_limit'
      })
      await expect.poll(hookNames, { timeout: 10_000 }).toContain('StopFailure')

      const msgs = stream(out.join(''))
      expect(msgs.map((m) => m.type)).toContain('rate_limit_event')
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: 'system', subtype: 'api_retry', error_status: 429 })
      )
      expect(hooks().at(-1)?.payload).toMatchObject({ error: 'rate_limit' })
      proc.kill('SIGTERM')
      expect(await exitCode(proc)).toBe(143)
    }, 20_000)

    it('rate_limit: succeeds on --resume when QUE_FAKE_CLAUDE_RESUME_OK=1', async () => {
      const r = await run(
        CLAUDE,
        headless('Refactor the queue', '--resume', '0f9e8d7c-0000-4000-8000-6b5a4c3d2e1f'),
        { QUE_FAKE_CLAUDE_SCENARIO: 'rate_limit', QUE_FAKE_CLAUDE_RESUME_OK: '1' }
      )

      expect(r.code).toBe(0)
      expect(stream(r.stdout).at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
      expect(hooks()[0].payload).toMatchObject({ source: 'resume' })
    }, 20_000)

    it('rate_limit: reports resetsAt QUE_FAKE_CLAUDE_RESET_SECONDS from now, in epoch seconds', async () => {
      const startedAt = Math.floor(Date.now() / 1000)
      const { proc, out } = start(headless('Refactor the queue'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'rate_limit',
        QUE_FAKE_CLAUDE_RESET_SECONDS: '90'
      })
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('rate_limit_event')

      const event = stream(out.join('')).find((m) => m.type === 'rate_limit_event') as {
        rate_limit_info: { status: string; resetsAt: number }
      }
      expect(event.rate_limit_info.status).toBe('rejected')
      expect(event.rate_limit_info.resetsAt).toBeGreaterThanOrEqual(startedAt + 90)
      expect(event.rate_limit_info.resetsAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 90)
      proc.kill('SIGTERM')
      await exitCode(proc)
    }, 20_000)

    it('success: commits its change when QUE_FAKE_CLAUDE_COMMIT=1, and leaves it uncommitted otherwise', async () => {
      gitIn(dir, 'init', '-b', 'main')
      gitIn(dir, 'commit', '--allow-empty', '-m', 'Initial commit')
      const identity = {
        GIT_AUTHOR_NAME: 'que test',
        GIT_AUTHOR_EMAIL: 'test@que.invalid',
        GIT_COMMITTER_NAME: 'que test',
        GIT_COMMITTER_EMAIL: 'test@que.invalid'
      }

      await run(CLAUDE, headless('Add retry logic'), { ...identity, QUE_FAKE_CLAUDE_COMMIT: '1' })

      expect(gitIn(dir, 'log', '--format=%s', '-1')).toBe('Add que-fake-change.txt')
      expect(gitIn(dir, 'status', '--porcelain', '--', 'que-fake-change.txt')).toBe('')

      await run(CLAUDE, headless('Add backoff'), identity)

      expect(gitIn(dir, 'log', '--format=%s', '-1')).toBe('Add que-fake-change.txt')
      expect(gitIn(dir, 'status', '--porcelain', '--', 'que-fake-change.txt')).toBe(
        'M que-fake-change.txt'
      )
    }, 20_000)

    it('max_turns: ends with error_max_turns at the cap and exits 1', async () => {
      const r = await run(CLAUDE, headless('Refactor the queue', '--max-turns', '7'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'max_turns'
      })

      expect(r.code).toBe(1)
      expect(stream(r.stdout).at(-1)).toMatchObject({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 7
      })
    }, 20_000)

    it('crash: exits 1 with a message and no result', async () => {
      const r = await run(CLAUDE, headless('Refactor the queue'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'crash'
      })

      expect(r.code).toBe(1)
      expect(r.stderr).toContain('fake claude: simulated crash')
      expect(r.stdout).not.toContain('"type":"result"')
      expect(hookNames()).toEqual(['SessionStart'])
    }, 20_000)

    it('takes the scenario from a [que-fake-scenario:…] marker in the prompt over the env', async () => {
      const r = await run(CLAUDE, headless('Refactor the queue [que-fake-scenario:crash]'), {
        QUE_FAKE_CLAUDE_SCENARIO: 'success'
      })

      expect(r.code).toBe(1)
      expect(r.stderr).toContain('fake claude: simulated crash')
    }, 20_000)

    it('needs_input: fires a permission_prompt Notification, then hangs', async () => {
      start(headless('Run the migrations'), { QUE_FAKE_CLAUDE_SCENARIO: 'needs_input' })

      await expect.poll(hookNames, { timeout: 10_000 }).toContain('Notification')
      expect(hooks().at(-1)?.payload).toMatchObject({
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
        title: 'Permission needed'
      })
    }, 20_000)
  })

  describe('interactive', () => {
    it('answers each line with hooks and exits on /exit', async () => {
      const { proc, out } = start(['--settings', settings], {})
      await expect.poll(() => out.join(''), { timeout: 10_000 }).toContain('> ')

      proc.stdin?.write('Explain the uploader\n')
      await expect.poll(hookNames, { timeout: 10_000 }).toContain('Stop')
      proc.stdin?.write('/exit\n')

      expect(await exitCode(proc)).toBe(0)
      expect(out.join('')).toContain('Fake reply to: Explain the uploader')
      expect(hookNames()).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SessionEnd'
      ])
    }, 20_000)
  })

  describe('cli surface', () => {
    it('prints a version and an empty agent list, and requires --verbose for stream-json', async () => {
      expect((await run(CLAUDE, ['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)/)
      expect(JSON.parse((await run(CLAUDE, ['agents', '--json'])).stdout)).toEqual([])
      const r = await run(CLAUDE, ['-p', 'hi', '--output-format', 'stream-json'])
      expect(r.code).toBe(1)
    }, 20_000)

    it('answers a one-shot text question with QUE_FAKE_CLAUDE_SUMMARY and runs no session', async () => {
      const r = await run(
        CLAUDE,
        ['-p', 'Label this session', '--output-format', 'text', '--settings', settings],
        { QUE_FAKE_CLAUDE_SUMMARY: 'Retry logic for the uploader' }
      )

      expect(r).toEqual({ code: 0, stdout: 'Retry logic for the uploader\n', stderr: '' })
      expect(fs.existsSync(hookLog)).toBe(false)
    }, 20_000)
  })
})

describe('fake gh and code', () => {
  it('logs every call and numbers the PRs it opens', async () => {
    const ghLog = join(dir, 'gh.log')
    const codeLog = join(dir, 'code.log')
    const env = { QUE_FAKE_GH_LOG: ghLog, QUE_FAKE_CODE_LOG: codeLog }

    expect((await run(join(FAKES_BIN, 'gh'), ['auth', 'status'], env)).code).toBe(0)
    const first = await run(join(FAKES_BIN, 'gh'), ['pr', 'create', '--draft', '--fill'], env)
    const second = await run(join(FAKES_BIN, 'gh'), ['pr', 'create', '--draft', '--fill'], env)
    await run(join(FAKES_BIN, 'code'), ['--new-window', dir], env)

    expect(first.stdout.trim()).toBe('https://github.com/rquellh/que/pull/1')
    expect(second.stdout.trim()).toBe('https://github.com/rquellh/que/pull/2')
    expect(readFakeLog(ghLog).map((c) => c.argv)).toEqual([
      ['auth', 'status'],
      ['pr', 'create', '--draft', '--fill'],
      ['pr', 'create', '--draft', '--fill']
    ])
    expect(readFakeLog(codeLog)).toEqual([
      { argv: ['--new-window', dir], cwd: dir, ts: expect.any(String) }
    ])
  }, 20_000)
})

describe('fake caffeinate', () => {
  it('logs its call and exits once the -w process is gone', async () => {
    const log = join(dir, 'caffeinate.log')
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(sleeper)
    const caffeinate = spawn(join(FAKES_BIN, 'caffeinate'), ['-i', '-w', String(sleeper.pid)], {
      env: { ...process.env, QUE_FAKE_CAFFEINATE_LOG: log }
    })
    children.push(caffeinate)
    await expect.poll(() => readFakeLog(log).length, { timeout: 10_000 }).toBe(1)
    expect(readFakeLog(log)[0]).toMatchObject({
      argv: ['-i', '-w', String(sleeper.pid)],
      pid: caffeinate.pid
    })

    sleeper.kill('SIGKILL')

    expect(await exitCode(caffeinate)).toBe(0)
  }, 20_000)
})
