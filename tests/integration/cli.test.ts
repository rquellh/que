// The real `que` CLI as a subprocess against the in-process daemon.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TermInfo } from '@shared/protocol'
import type { Workspace } from '@shared/types'
import type { StatusJson } from '../../src/cli/workspaces'
import { runCli } from '../../src/testing/cli'
import { startTestDaemon, type TestDaemon, withQuietOff } from '../../src/testing/daemon-harness'
import { FAKES_BIN, readFakeLog, setFakePullRequest } from '../../src/testing/fakes'
import { makeHookEvent } from '../../src/testing/fixtures'
import { addBareOrigin, gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon

beforeEach(async () => {
  daemon = await startTestDaemon()
})

afterEach(async () => {
  await daemon.close()
})

describe('que term list', () => {
  it('prints every terminal as JSON with --json and exits 0', async () => {
    const { id } = await daemon.client.request('term.create', {
      file: '/bin/cat',
      name: 'uploader-shell',
      cwd: daemon.home,
      cols: 80,
      rows: 24
    })

    const r = await runCli('term', 'list', '--json')

    expect(r.code).toBe(0)
    const terms = JSON.parse(r.stdout) as TermInfo[]
    expect(terms).toHaveLength(1)
    expect(terms[0]).toEqual({
      id,
      name: 'uploader-shell',
      cwd: daemon.home,
      cols: 80,
      rows: 24,
      pid: expect.any(Number),
      alive: true,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    })
    expect(terms[0]).not.toHaveProperty('workspaceId')
  }, 30_000)

  it('says so when there are no terminals', async () => {
    const r = await runCli('term', 'list')

    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('no terminals')
  }, 30_000)

  it('fails with a message when the daemon is not running', async () => {
    await daemon.server.close()

    const r = await runCli('term', 'list', '--json')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('que: daemon is not running')
  }, 30_000)
})

describe('que daemon status', () => {
  it('prints the running daemon as JSON with --json, and running: false with exit 3 once it is gone', async () => {
    const ping = await daemon.client.request('daemon.ping')

    const r = await runCli('daemon', 'status', '--json')

    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      running: true,
      pid: ping.pid,
      version: ping.version,
      nodeVersion: ping.nodeVersion,
      startedAt: ping.startedAt,
      socket: daemon.socket,
      terminals: { alive: 0, total: 0 }
    })

    await daemon.server.close()
    const gone = await runCli('daemon', 'status', '--json')
    expect(gone.code).toBe(3)
    expect(JSON.parse(gone.stdout)).toEqual({ running: false, socket: daemon.socket })
  }, 30_000)
})

describe('que work and que ws', () => {
  it('creates a workspace from a repo path, waits for setup, and prints its path', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "printf ok > .setup-done"\n' })

    const r = await runCli(
      'work',
      'APP-1432 retry logic',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo
    )

    expect(r.code).toBe(0)
    const path = join(daemon.home, 'worktrees', 'uploader', 'app-1432-retry-logic')
    expect(r.stdout.trim()).toBe(path)
    expect(fs.readFileSync(join(path, '.setup-done'), 'utf8')).toBe('ok')
    expect(gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('app-1432-retry-logic')
    const listed = JSON.parse((await runCli('ws', 'list', '--json')).stdout) as Workspace[]
    expect(listed).toEqual([
      expect.objectContaining({ path, status: 'idle', title: 'APP-1432 retry logic' })
    ])
  }, 30_000)

  it('takes a multi-line brief, or a --name, and refuses neither', async () => {
    const repo = makeTempRepo(daemon.home)
    const brief = 'Raise the upload timeout\n\nThe upload test times out on slow runners.'

    const fromBrief = await runCli('work', brief, '-r', repo, '--json')
    const named = await runCli('work', brief, '--name', 'APP-1490 timeout', '-r', repo, '--json')
    const neither = await runCli('work', '-r', repo)

    expect(JSON.parse(fromBrief.stdout)).toMatchObject({
      name: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z]+$/),
      title: 'Raise the upload timeout',
      brief
    })
    expect(JSON.parse(named.stdout)).toMatchObject({
      name: 'app-1490-timeout',
      title: 'Raise the upload timeout'
    })
    expect(neither.code).toBe(2)
    expect(neither.stderr).toContain('give a brief (what you are doing) or --name')
    const table = (await runCli('ws', 'list')).stdout
    expect(table).toContain('Raise the upload timeout')
  }, 30_000)

  it('resolves -r through the config registry and fails when setup fails', async () => {
    const repo = makeTempRepo(daemon.home, { queToml: 'setup = "exit 4"\n' })
    fs.writeFileSync(daemon.configPath, withQuietOff(`[repos.uploader-api]\npath = "${repo}"\n`))

    const r = await runCli('work', '--name', 'app-1433-broken-setup', '-r', 'uploader-api')

    expect(r.code).toBe(1)
    expect(r.stderr).toContain('setup failed for app-1433-broken-setup')
    const [project] = await daemon.client.request('project.list')
    expect(project).toMatchObject({ name: 'uploader-api', path: repo })
  }, 30_000)

  it('removes a workspace by name and deletes its branch', async () => {
    const repo = makeTempRepo(daemon.home)
    await runCli('work', '--name', 'app-1470-cleanup', '-r', repo)

    const r = await runCli('ws', 'remove', 'app-1470-cleanup', '--delete-branch')

    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^removed ws_[a-z2-7]{12} \(app-1470-cleanup\)/)
    expect(await daemon.client.request('workspace.list')).toEqual([])
    expect(gitIn(repo, 'branch', '--list', 'app-1470-cleanup')).toBe('')
  }, 30_000)

  it('opens a workspace with code -n', async () => {
    const repo = makeTempRepo(daemon.home)
    const path = (await runCli('work', '--name', 'app-1480-editor', '-r', repo)).stdout.trim()

    const r = await runCli('open', 'app-1480-editor')

    expect(r.code).toBe(0)
    expect(readFakeLog(daemon.codeLog).map((c) => c.argv)).toEqual([['-n', path]])
  }, 30_000)
})

describe('que status', () => {
  it('reports the summary and each workspace as JSON', async () => {
    const project = await daemon.client.request('project.add', {
      path: makeTempRepo(daemon.home)
    })
    const ws = await daemon.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1432-retry-logic'
    })
    await expect
      .poll(async () => (await daemon.client.request('workspace.get', { id: ws.id })).status, {
        timeout: 10_000
      })
      .toBe('idle')
    await daemon.client.request('hook.event', {
      workspaceId: ws.id,
      payload: makeHookEvent('Notification', {
        session_id: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })
    })

    const r = await runCli('status', '--json')

    expect(r.code).toBe(0)
    const status = JSON.parse(r.stdout) as StatusJson
    expect(status.summary).toEqual({
      working: 0,
      idle: 0,
      needs_input: 1,
      stuck: 0,
      exited: 0,
      preparing: 0
    })
    expect(status.tray).toBe('● 0 ▸ 1 ✕ 0')
    expect(status.workspaces).toEqual([
      {
        id: ws.id,
        name: 'app-1432-retry-logic',
        project: 'uploader',
        projectId: project.id,
        branch: 'app-1432-retry-logic',
        path: ws.path,
        status: 'needs_input',
        reason: null,
        lastActivityAt: null,
        sessionId: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
        pr: null
      }
    ])
  }, 30_000)

  it('shows the workspace pull request in the table and as JSON', async () => {
    await daemon.close()
    daemon = await startTestDaemon({ config: 'pr_poll_seconds = 0.2\n' })
    const repo = makeTempRepo(daemon.home)
    addBareOrigin(repo)
    const project = await daemon.client.request('project.add', { path: repo })
    const ws = await daemon.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1432-retry-logic'
    })
    setFakePullRequest(daemon.ghPrs, ws.branch, {
      number: 12,
      isDraft: false,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }]
    })
    await expect
      .poll(async () => (await daemon.client.request('workspace.get', { id: ws.id })).pr?.checks, {
        timeout: 10_000
      })
      .toBe('failing')

    const json = JSON.parse((await runCli('status', '--json')).stdout) as StatusJson
    const table = (await runCli('status')).stdout

    expect(json.workspaces[0].pr).toMatchObject({ number: 12, state: 'open', checks: 'failing' })
    expect(table).toContain('#12 open·checks failing')
  }, 30_000)
})

describe('que doctor', () => {
  it('passes when the daemon, claude, gh, git, caffeinate, config, and wrapper are all there', async () => {
    const r = await runCli('doctor')

    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines.map((l) => l.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'ok daemon',
      'ok daemon', // the daemon PATH line
      'ok claude',
      'ok gh',
      'ok git',
      'ok caffeinate',
      'ok node',
      'ok config',
      'ok quiet',
      'ok wrapper'
    ])
    expect(r.stdout).toContain('2.1.0 (Claude Code)')
    expect(r.stdout).toMatch(new RegExp(`daemon PATH\\s+claude at ${FAKES_BIN}/claude`))
  }, 30_000)

  it('fails on an invalid config file and names the key', async () => {
    fs.writeFileSync(daemon.configPath, 'stall_timeout_minutes = "soon"\n')

    const r = await runCli('doctor')

    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/FAIL\s+config\s+.*stall_timeout_minutes: must be a positive number/)
  }, 30_000)
})
