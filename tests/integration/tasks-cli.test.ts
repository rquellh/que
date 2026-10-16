// The overnight commands of the real `que` CLI, as subprocesses against the
// in-process daemon: add, run, task, queue, report, and the launchd agent.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueueState, Report } from '@shared/protocol'
import type { Task } from '@shared/types'
import { runCli, runCliWith } from '../../src/testing/cli'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import { makeHookEvent } from '../../src/testing/fixtures'
import { addBareOrigin, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon

beforeEach(async () => {
  daemon = await startTestDaemon()
})

afterEach(async () => {
  await daemon.close()
})

describe('que add, run, task list, report', () => {
  it('queues a brief for a repo, runs it, and reports the draft PR', async () => {
    const repo = makeTempRepo(daemon.home)
    addBareOrigin(repo)

    const added = await runCli(
      'add',
      '-r',
      repo,
      '--max-turns',
      '30',
      'Add retry logic to the uploader'
    )

    expect(added.code).toBe(0)
    const [id, ...title] = added.stdout.trim().split(/\s+/)
    expect(id).toMatch(/^tsk_[a-z2-7]{12}$/)
    expect(title.join(' ')).toBe('Add retry logic to the uploader')
    const listed = JSON.parse((await runCli('task', 'list', '--json')).stdout) as Task[]
    expect(listed).toEqual([expect.objectContaining({ id, state: 'queued', maxTurns: 30 })])

    const run = await runCli('run', '-j', '1')

    expect(run.code).toBe(0)
    expect(run.stdout.trim()).toMatch(
      /^queue open · concurrency 1 · [01] running · [01] queued · 0 paused$/
    )
    await expect
      .poll(async () => (await daemon.client.request('task.get', { id })).state, {
        timeout: 30_000
      })
      .toBe('done')

    const json = await runCli('report', '--json', '--since', '1h')
    expect(json.code).toBe(0)
    const report = JSON.parse(json.stdout) as Report
    expect(report.groups.done).toEqual([
      expect.objectContaining({
        id,
        title: 'Add retry logic to the uploader',
        workspace: expect.stringMatching(/^[a-z]+-[a-z]+-[a-z]+$/),
        prUrl: 'https://github.com/rquellh/que/pull/1',
        turns: 2,
        costUsd: 0.0123
      })
    ])
    expect(report.totals).toMatchObject({ tasks: 1, prs: 1 })

    const text = await runCli('report')
    expect(text.stdout).toContain('Done (1)\n  Add retry logic to the uploader\n')
    expect(text.stdout).toContain('https://github.com/rquellh/que/pull/1')
    expect(text.stdout).toMatch(/Total: 1 tasks · 1 PRs · 2 turns · \$0\.01/)

    const closed = await runCli('queue', 'close')
    expect(closed.stdout.trim()).toBe(
      'queue closed · concurrency 2 · 0 running · 0 queued · 0 paused'
    )
  }, 60_000)

  it('reads a brief from a file for an existing workspace and shows the task', async () => {
    const repo = makeTempRepo(daemon.home)
    const project = await daemon.client.request('project.add', { path: repo })
    await daemon.client.request('workspace.create', {
      projectId: project.id,
      name: 'app-1432-retry-logic'
    })
    const brief = join(daemon.home, 'brief.md')
    fs.writeFileSync(brief, 'Cover the retry logic with tests\n\nUse the fake clock.\n')

    const added = await runCli('add', '-r', 'app-1432-retry-logic', '-f', brief, '--json')

    expect(added.code).toBe(0)
    const task = JSON.parse(added.stdout) as Task
    expect(task).toMatchObject({ source: 'file', title: 'Cover the retry logic with tests' })
    const shown = await runCli('task', 'show', task.id)
    expect(shown.stdout).toMatch(/^state\s+queued$/m)
    expect(shown.stdout).toContain(join(daemon.home, 'logs', 'tasks', `${task.id}.log`))
    const status = JSON.parse((await runCli('queue', 'status', '--json')).stdout) as QueueState
    expect(status).toMatchObject({ open: false, queued: 1 })
  }, 30_000)

  it('carries the interactive workspaces in --json and prints them as text', async () => {
    const project = await daemon.client.request('project.add', { path: makeTempRepo(daemon.home) })
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
      payload: makeHookEvent('UserPromptSubmit', { cwd: ws.path })
    })

    const json = await runCli('report', '--json', '--since', '1h')

    expect(json.code).toBe(0)
    const report = JSON.parse(json.stdout) as Report
    expect(report.workspaces).toEqual([
      expect.objectContaining({ id: ws.id, name: ws.name, status: 'working', commitsAhead: 0 })
    ])
    expect(report.totals).toMatchObject({ workspaces: 1, needsInput: 0, tasks: 0 })
    const text = await runCli('report', '--since', '1h')
    expect(text.stdout).toContain('Workspaces (1)')
    expect(text.stdout).toContain(`  ${ws.name} · ${project.name} · working`)
    expect(text.stdout).not.toContain('No tasks in this window.')
  }, 30_000)

  it('fails with a message for a bad --since and for a missing target', async () => {
    const since = await runCli('report', '--since', 'last tuesday')
    expect(since).toMatchObject({ code: 1, stderr: 'que: invalid --since last tuesday\n' })

    const target = await runCli('add', '-r', 'no-such-workspace', 'Refactor the queue')
    expect(target).toMatchObject({ code: 1, stderr: 'que: no workspace no-such-workspace\n' })
  }, 30_000)
})

describe('que daemon install / uninstall', () => {
  it('writes the launchd agent to QUE_LAUNCH_AGENTS_DIR without loading it, and removes it', async () => {
    const agents = join(daemon.home, 'LaunchAgents')
    const env = { QUE_LAUNCH_AGENTS_DIR: agents }
    const plist = join(agents, 'dev.que.daemon.plist')

    const installed = await runCliWith({ env }, 'daemon', 'install', '--no-load')

    expect(installed).toMatchObject({ code: 0, stdout: `wrote ${plist}\n` })
    const text = fs.readFileSync(plist, 'utf8')
    expect(text).toContain('<string>dev.que.daemon</string>')
    expect(text).toContain(`<key>QUE_HOME</key>\n    <string>${daemon.home}</string>`)
    expect(text).toMatch(/<string>[^<]+\/daemon\/index\.js<\/string>/)
    expect(text).toContain('<key>RunAtLoad</key>\n  <true/>')

    const removed = await runCliWith({ env }, 'daemon', 'uninstall', '--no-load')

    expect(removed).toMatchObject({ code: 0, stdout: `removed ${plist}\n` })
    expect(fs.existsSync(plist)).toBe(false)
  }, 30_000)
})
