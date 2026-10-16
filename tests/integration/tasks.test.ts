// The overnight queue's wiring: the runner against every fake claude
// scenario, the finisher pushing to a real bare `origin` and calling the fake
// gh, the dispatcher's cap, stop, the keep-awake, and recovery after
// a daemon restart. The transition rules themselves are in task-machine.test.ts.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@shared/client'
import type { Events } from '@shared/protocol'
import type { Task, TaskState } from '@shared/types'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { readFakeLog } from '../../src/testing/fakes'
import { pidAlive } from '../../src/testing/leak-check'
import {
  addBareOrigin,
  gitIn,
  makeTempRepo,
  type TempRepoOptions
} from '../../src/testing/temp-repo'

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

function record<E extends keyof Events>(c: DaemonClient, event: E): Events[E][] {
  const seen: Events[E][] = []
  c.on(event, (data) => seen.push(data))
  return seen
}

interface Setup {
  d: TestDaemon
  repo: string
  /** The bare repository `origin` points at. */
  origin: string
  projectId: string
}

/** A daemon and a project whose repo has a real bare `origin`. */
async function setup(opts: { config?: string; repo?: TempRepoOptions } = {}): Promise<Setup> {
  const d = await startTestDaemon({ config: opts.config })
  daemon = d
  const repo = makeTempRepo(d.home, opts.repo)
  const origin = addBareOrigin(repo)
  const { id: projectId } = await d.client.request('project.add', { path: repo })
  return { d, repo, origin, projectId }
}

async function waitFor(
  d: TestDaemon,
  id: string,
  state: TaskState,
  timeout = 20_000
): Promise<Task> {
  await expect
    .poll(async () => (await d.client.request('task.get', { id })).state, { timeout })
    .toBe(state)
  return d.client.request('task.get', { id })
}

function taskLog(d: TestDaemon, id: string): string {
  return fs.readFileSync(join(d.home, 'logs', 'tasks', `${id}.log`), 'utf8')
}

/** The `$ claude ...` lines the runner logged, one per attempt. */
function spawnLines(d: TestDaemon, id: string): string[] {
  return taskLog(d, id)
    .split('\n')
    .filter((l) => l.startsWith('[que] $ '))
}

const originBranches = (origin: string) =>
  gitIn(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)

const statesOf = (all: Events['task.status'][], id: string) =>
  all.filter((s) => s.id === id).map((s) => s.state)

describe('runner and finisher', () => {
  it('success: runs claude in a new workspace, commits what it left, pushes, and opens a draft PR', async () => {
    const { d, origin, projectId } = await setup()
    const statuses = record(d.client, 'task.status')
    const brief = 'Add retry logic to the uploader\nUse exponential backoff.'

    const task = await d.client.request('task.add', { projectId, brief })
    await d.client.request('queue.open')

    const done = await waitFor(d, task.id, 'done')
    expect(done).toMatchObject({
      title: 'Add retry logic to the uploader',
      reason: null,
      prUrl: 'https://github.com/rquellh/que/pull/1',
      costUsd: 0.0123,
      turns: 2,
      permissionMode: 'acceptEdits',
      attempts: 1,
      pid: null
    })
    // Task workspaces get a random three-word name, which is also the branch.
    const branch = done.branch as string
    expect(branch).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
    expect(done.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(statesOf(statuses, task.id)).toEqual(['preparing', 'running', 'finishing', 'done'])
    expect(originBranches(origin)).toContain(branch)
    expect(gitIn(origin, 'log', '--format=%s', `main..${branch}`)).toBe(
      'Add retry logic to the uploader'
    )
    const ws = await d.client.request('workspace.get', { id: done.workspaceId as string })
    expect(ws).toMatchObject({
      name: branch,
      title: 'Add retry logic to the uploader',
      brief
    })
    expect(fs.readFileSync(join(ws.path, '.que', 'brief.md'), 'utf8')).toBe(brief)
    expect(gitIn(ws.path, 'status', '--porcelain')).toBe('')
    const [pr] = readFakeLog(d.ghLog)
    expect(pr.argv.slice(0, 5)).toEqual([
      'pr',
      'create',
      '--draft',
      '--title',
      'Add retry logic to the uploader'
    ])
    expect(pr.cwd).toBe(ws.path)
    const body = fs.readFileSync(pr.argv[pr.argv.indexOf('--body-file') + 1], 'utf8')
    expect(body).toMatch(/^Done: Add retry logic to the uploader/)
    expect(body).toContain(`Opened by que from workspace ${ws.name}.`)
  }, 45_000)

  it('success: pushes the commit the agent made itself, adding none', async () => {
    const { d, origin, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_COMMIT', '1')

    const task = await d.client.request('task.add', {
      projectId,
      brief: 'Document the retry policy'
    })
    await d.client.request('queue.open')

    const done = await waitFor(d, task.id, 'done')
    expect(done.prUrl).toMatch(/\/pull\/1$/)
    expect(gitIn(origin, 'log', '--format=%s', `main..${done.branch}`)).toBe(
      'Add que-fake-change.txt'
    )
  }, 45_000)

  it('success with nothing to commit: done(no_changes), nothing pushed, no gh call', async () => {
    const { d, origin, projectId } = await setup({
      repo: { ignored: { 'que-fake-change.txt': 'ignored by the repo\n' } }
    })

    const task = await d.client.request('task.add', { projectId, brief: 'Check the uploader' })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'done')).toMatchObject({ reason: 'no_changes', prUrl: null })
    expect(originBranches(origin)).toEqual(['main'])
    expect(readFakeLog(d.ghLog).filter((c) => c.argv[1] !== 'list')).toEqual([])
  }, 45_000)

  it('fails a task whose workspace setup fails', async () => {
    const { d, projectId } = await setup({ repo: { queToml: 'setup = "exit 3"\n' } })

    const task = await d.client.request('task.add', { projectId, brief: 'Add retry logic' })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'failed')).toMatchObject({ reason: 'setup_failed' })
  }, 45_000)
})

describe('runner environment', () => {
  it('starts claude as a fresh top-level session, whatever started the daemon', async () => {
    vi.stubEnv('TERM_PROGRAM', 'kitty')
    vi.stubEnv('CLAUDECODE', '1')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('CLAUDE_CODE_MAX_OUTPUT_TOKENS', '32000')
    const { d, projectId } = await setup()

    const task = await d.client.request('task.add', { projectId, brief: 'Add retry logic' })
    await d.client.request('queue.open')
    await waitFor(d, task.id, 'done', 30_000)

    const [call] = readFakeLog(d.claudeLog)
    expect(call.env).toEqual(
      expect.arrayContaining([
        'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
        'QUE_TERMINAL',
        'QUE_WORKSPACE_ID',
        'TERM'
      ])
    )
    expect(call.env).not.toEqual(
      expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'TERM_PROGRAM'])
    )
  }, 60_000)
})

describe('runner against the failure scenarios', () => {
  it('stall: stuck(no_heartbeat) and the claude process is killed', async () => {
    const { d, projectId } = await setup({ config: 'stall_timeout_minutes = 0.02\n' })
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'stall')

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')
    await expect
      .poll(async () => (await d.client.request('task.get', { id: task.id })).pid, {
        timeout: 20_000
      })
      .toBeGreaterThan(0)
    const { pid } = await d.client.request('task.get', { id: task.id })

    expect(await waitFor(d, task.id, 'stuck')).toMatchObject({ reason: 'no_heartbeat' })
    await expect.poll(() => pidAlive(pid as number), { timeout: 10_000 }).toBe(false)
  }, 45_000)

  it('rate_limit: pauses until the reset, then resumes the session and finishes', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'rate_limit')
    vi.stubEnv('QUE_FAKE_CLAUDE_RESET_SECONDS', '1')
    vi.stubEnv('QUE_FAKE_CLAUDE_RESUME_OK', '1')
    const statuses = record(d.client, 'task.status')

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')

    const done = await waitFor(d, task.id, 'done', 30_000)
    expect(statesOf(statuses, task.id)).toEqual([
      'preparing',
      'running',
      'paused',
      'queued',
      'preparing',
      'running',
      'finishing',
      'done'
    ])
    const [first, second] = spawnLines(d, task.id)
    expect(first).toContain(`--session-id ${done.sessionId}`)
    expect(second).toContain(`--resume ${done.sessionId}`)
    expect(done.prUrl).toMatch(/\/pull\/1$/)
  }, 60_000)

  it('max_turns: stuck(max_turns) with the turns recorded', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'max_turns')

    const task = await d.client.request('task.add', {
      projectId,
      brief: 'Refactor the queue',
      maxTurns: 7,
      maxBudgetUsd: 1.5
    })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'stuck')).toMatchObject({ reason: 'max_turns', turns: 7 })
    expect(spawnLines(d, task.id)[0]).toContain('--max-turns 7 --max-budget-usd 1.5')
  }, 45_000)

  it('crash: retries once resuming the session, then fails(crashed)', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'crash')

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')

    const failed = await waitFor(d, task.id, 'failed', 30_000)
    expect(failed).toMatchObject({ reason: 'crashed', attempts: 2 })
    const spawns = spawnLines(d, task.id)
    expect(spawns).toHaveLength(2)
    expect(spawns[1]).toContain(`--resume ${failed.sessionId}`)
    expect(taskLog(d, task.id)).toContain('fake claude: simulated crash')
  }, 45_000)

  it('needs_input: the permission Notification hook makes it stuck(needs_input) and kills it', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'needs_input')

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')
    await expect
      .poll(async () => (await d.client.request('task.get', { id: task.id })).pid, {
        timeout: 20_000
      })
      .toBeGreaterThan(0)
    const { pid } = await d.client.request('task.get', { id: task.id })

    expect(await waitFor(d, task.id, 'stuck')).toMatchObject({ reason: 'needs_input' })
    await expect.poll(() => pidAlive(pid as number), { timeout: 10_000 }).toBe(false)
  }, 45_000)
})

describe('queue', () => {
  it('runs at most `concurrency` tasks at once and starts the next when one ends', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'stall')
    const ids: string[] = []
    for (const brief of ['Refactor the queue', 'Rename the uploader', 'Split the API client']) {
      ids.push((await d.client.request('task.add', { projectId, brief })).id)
    }

    expect(await d.client.request('queue.open', { concurrency: 2 })).toMatchObject({
      open: true,
      concurrency: 2
    })

    await waitFor(d, ids[0], 'running')
    await waitFor(d, ids[1], 'running')
    expect(await d.client.request('queue.state')).toMatchObject({ running: 2, queued: 1 })
    expect((await d.client.request('task.get', { id: ids[2] })).state).toBe('queued')

    await d.client.request('task.stop', { id: ids[0] })

    await waitFor(d, ids[2], 'running')
    expect(await d.client.request('queue.state')).toMatchObject({ running: 2, queued: 0 })
  }, 60_000)

  it('task.stop kills the run; the keep-awake runs only while a task does', async () => {
    const { d, projectId } = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_SCENARIO', 'stall')

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')
    await waitFor(d, task.id, 'running')
    await expect.poll(() => readFakeLog(d.caffeinateLog).length, { timeout: 10_000 }).toBe(1)
    const caffeinate = readFakeLog(d.caffeinateLog)[0] as unknown as { argv: string[]; pid: number }
    expect(caffeinate.argv).toEqual(['-i', '-w', String(process.pid)])
    expect(pidAlive(caffeinate.pid)).toBe(true)
    await expect
      .poll(async () => (await d.client.request('task.get', { id: task.id })).pid, {
        timeout: 10_000
      })
      .toBeGreaterThan(0)
    const { pid } = await d.client.request('task.get', { id: task.id })

    expect(await d.client.request('task.stop', { id: task.id })).toMatchObject({
      state: 'stopped'
    })

    await expect.poll(() => pidAlive(pid as number), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => pidAlive(caffeinate.pid), { timeout: 10_000 }).toBe(false)
  }, 45_000)

  it('does not start tasks while closed', async () => {
    const { d, projectId } = await setup()

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })

    expect(await d.client.request('queue.state')).toMatchObject({ open: false, queued: 1 })
    await d.client.request('queue.open')
    await waitFor(d, task.id, 'done')
    expect(await d.client.request('queue.close')).toMatchObject({ open: false, concurrency: 2 })
  }, 45_000)

  it('answers structured errors for bad task requests', async () => {
    const { d, projectId } = await setup()

    await expect(d.client.request('task.add', { projectId, brief: '  ' })).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      d.client.request('task.add', { projectId: 'prj_missing00000', brief: 'Refactor' })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(d.client.request('task.get', { id: 'tsk_missing00000' })).rejects.toMatchObject({
      code: 'not_found'
    })
    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await expect(d.client.request('task.remove', { id: task.id })).rejects.toMatchObject({
      code: 'conflict'
    })
    await d.client.request('task.stop', { id: task.id })
    expect(await d.client.request('task.remove', { id: task.id })).toEqual({ ok: true })
    expect(await d.client.request('task.list')).toEqual([])
  }, 30_000)
})

describe('daemon restart', () => {
  it('re-queues a running task and resumes its session under the next daemon', async () => {
    const first = await setup()
    vi.stubEnv('QUE_FAKE_CLAUDE_DELAY_MS', '3000')
    const task = await first.d.client.request('task.add', {
      projectId: first.projectId,
      brief: 'Refactor the queue'
    })
    await first.d.client.request('queue.open')
    await expect
      .poll(async () => (await first.d.client.request('task.get', { id: task.id })).pid, {
        timeout: 20_000
      })
      .toBeGreaterThan(0)
    const before = await first.d.client.request('task.get', { id: task.id })

    await first.d.close({ keepHome: true })
    expect(pidAlive(before.pid as number)).toBe(false)
    daemon = await startTestDaemon({ home: first.d.home })

    const done = await waitFor(daemon, task.id, 'done', 30_000)
    expect(done).toMatchObject({ attempts: 2, sessionId: before.sessionId })
    expect(spawnLines(daemon, task.id)[1]).toContain(`--resume ${before.sessionId}`)
  }, 60_000)
})

describe('safety', () => {
  it('never pushes a protected branch', async () => {
    const { d, origin, projectId } = await setup()
    const ws = await d.client.request('workspace.create', {
      projectId,
      name: 'hotfix-release',
      branch: 'release'
    })

    const task = await d.client.request('task.add', {
      workspaceId: ws.id,
      brief: 'Patch the release'
    })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'failed')).toMatchObject({
      reason: 'finisher:protected_branch'
    })
    expect(originBranches(origin)).toEqual(['main'])
    expect(readFakeLog(d.ghLog).filter((c) => c.argv[1] !== 'list')).toEqual([])
    expect(taskLog(d, task.id)).toContain('refusing to push protected branch release')
  }, 45_000)

  it("never pushes the project's default branch", async () => {
    const { d, repo, origin, projectId } = await setup({
      repo: { queToml: 'setup = "true"\ndefault_branch = "trunk"\n' }
    })
    gitIn(repo, 'push', '--quiet', 'origin', 'main:trunk')
    const trunkBefore = gitIn(origin, 'rev-parse', 'trunk')
    const ws = await d.client.request('workspace.create', {
      projectId,
      name: 'trunk-work',
      branch: 'trunk'
    })

    const task = await d.client.request('task.add', { workspaceId: ws.id, brief: 'Patch trunk' })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'failed')).toMatchObject({
      reason: 'finisher:protected_branch'
    })
    expect(gitIn(origin, 'rev-parse', 'trunk')).toBe(trunkBefore)
    expect(readFakeLog(d.ghLog).filter((c) => c.argv[1] !== 'list')).toEqual([])
  }, 45_000)

  it('downgrades bypassPermissions to acceptEdits without the config flag', async () => {
    const { d, projectId } = await setup({
      repo: { queToml: 'setup = "true"\npermission_mode = "bypassPermissions"\n' }
    })

    const task = await d.client.request('task.add', { projectId, brief: 'Refactor the queue' })
    await d.client.request('queue.open')

    expect(await waitFor(d, task.id, 'done')).toMatchObject({ permissionMode: 'acceptEdits' })
    expect(spawnLines(d, task.id)[0]).toContain('--permission-mode acceptEdits')
    expect(taskLog(d, task.id)).toContain('warning: bypassPermissions needs')
  }, 45_000)
})
