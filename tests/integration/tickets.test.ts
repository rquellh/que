// The ticket queue over the real socket: the daemon polls the fake acli
// (issue file, QUE_FAKE_ACLI_FAIL), and starting a ticket makes a workspace,
// a brief, and a claude terminal in it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@shared/client'
import { DEFAULT_START_PROMPT } from '@shared/config'
import type { Events } from '@shared/protocol'
import { startTestDaemon, type TestDaemon } from '../../src/testing/daemon-harness'
import {
  fakeParentOf,
  makeFakeEpic,
  makeFakeIssue,
  readFakeLog,
  writeFakeTickets
} from '../../src/testing/fakes'
import { gitIn, makeTempRepo } from '../../src/testing/temp-repo'

let daemon: TestDaemon
let client: DaemonClient

beforeEach(async () => {
  daemon = await startTestDaemon({ config: '[jira]\npoll_minutes = 0.002\n' })
  client = daemon.client
})

afterEach(async () => {
  await daemon.close()
})

const opts = { timeout: 10_000 }
const older = makeFakeIssue({
  key: 'APP-1100',
  fields: { summary: 'Older ticket', updated: '2026-10-01T09:00:00.000+0000' }
})
const newer = makeFakeIssue()
const keys = async () => (await client.request('tickets.list', {})).tickets.map((t) => t.key)
const syncError = async () => (await client.request('tickets.list', {})).sync.error

async function addProject() {
  const repo = makeTempRepo(daemon.home)
  return client.request('project.add', { path: repo })
}

describe('syncing the queue', () => {
  it('lists the tickets in the search order and announces the sync', async () => {
    const synced: Events['tickets.synced'][] = []
    client.on('tickets.synced', (d) => synced.push(d))
    writeFakeTickets(daemon.acliTickets, [older, newer])

    await expect.poll(keys, opts).toEqual(['APP-1100', 'APP-1432'])
    const list = await client.request('tickets.list', {})
    expect(list.tickets[1]).toMatchObject({
      url: 'https://example.atlassian.net/browse/APP-1432',
      statusCategory: 'indeterminate',
      projectKey: 'APP',
      workspaceId: null
    })
    expect(list.sync).toMatchObject({ error: null, count: 2 })
    expect(list.tickets[1].updatedAt).toBeNull()
    expect(list.sync.lastSyncAt).not.toBeNull()
    expect(synced.some((s) => s.tickets.length === 2)).toBe(true)
    expect(readFakeLog(daemon.acliLog)[0].argv.slice(0, 3)).toEqual(['jira', 'workitem', 'search'])
  })

  it('keeps the search order when the keys sort differently, and takes the project from the key', async () => {
    const issue = (key: string) => makeFakeIssue({ key, fields: { summary: `Ticket ${key}` } })
    writeFakeTickets(daemon.acliTickets, [issue('APP-9'), issue('APP-1432'), issue('APP-77')])
    await expect.poll(keys, opts).toEqual(['APP-9', 'APP-1432', 'APP-77'])
    const list = await client.request('tickets.list', {})
    expect(list.sync.error).toBeNull()
    expect(list.tickets.map((t) => [t.projectKey, t.projectName])).toEqual([
      ['APP', 'APP'],
      ['APP', 'APP'],
      ['APP', 'APP']
    ])

    writeFakeTickets(daemon.acliTickets, [issue('APP-77'), issue('APP-9'), issue('APP-1432')])
    await expect.poll(keys, opts).toEqual(['APP-77', 'APP-9', 'APP-1432'])
  })

  it('drops a vanished ticket on the next poll, but not one with a workspace', async () => {
    const project = await addProject()
    writeFakeTickets(daemon.acliTickets, [older, newer])
    await expect.poll(keys, opts).toHaveLength(2)
    await client.request('tickets.start', { key: 'APP-1100', projectId: project.id })

    writeFakeTickets(daemon.acliTickets, [])
    await expect.poll(keys, opts).toEqual(['APP-1100'])
    const before = (await client.request('tickets.list', {})).sync.lastSyncAt
    await expect
      .poll(async () => (await client.request('tickets.list', {})).sync.lastSyncAt, opts)
      .not.toBe(before)
    expect(await keys()).toEqual(['APP-1100'])
  })

  it('shows a sign-in failure, keeps the list, and clears it once signed in', async () => {
    writeFakeTickets(daemon.acliTickets, [newer])
    await expect.poll(keys, opts).toEqual(['APP-1432'])

    vi.stubEnv('QUE_FAKE_ACLI_FAIL', 'auth')
    await expect.poll(syncError, opts).toMatch(/^Not authenticated/)
    expect(await keys()).toEqual(['APP-1432'])

    vi.stubEnv('QUE_FAKE_ACLI_FAIL', '')
    await expect.poll(syncError, opts).toBeNull()
  })

  it('syncs on demand', async () => {
    writeFakeTickets(daemon.acliTickets, [newer])
    const r = await client.request('tickets.sync', {})
    expect(r.tickets.map((t) => t.key)).toEqual(['APP-1432'])
  })
})

describe('the fake acli', () => {
  it('refuses a search field the real CLI refuses, and keeps only the requested ones', () => {
    writeFakeTickets(daemon.acliTickets, [newer])
    const run = (fields: string) =>
      spawnSync('acli', ['jira', 'workitem', 'search', '--json', '--fields', fields], {
        encoding: 'utf8',
        env: process.env
      })
    const refused = run('key,project,summary,updated')
    expect(refused.status).toBe(1)
    expect(refused.stderr.trim()).toBe("✗ Error: fields 'project, updated' are not allowed")

    const ok = run('key,summary')
    expect(ok.status).toBe(0)
    const [issue] = JSON.parse(ok.stdout) as { key: string; fields: Record<string, unknown> }[]
    expect(Object.keys(issue.fields)).toEqual(['summary'])
  })
})

describe('starting a ticket', () => {
  beforeEach(async () => {
    writeFakeTickets(daemon.acliTickets, [newer])
    await expect.poll(keys, opts).toEqual(['APP-1432'])
  })

  it('asks for a project when none is known', async () => {
    const project = await addProject()
    expect(await client.request('tickets.projectFor', { key: 'APP-1432' })).toEqual({
      projectId: null
    })
    const r = await client.request('tickets.start', { key: 'APP-1432' })
    expect(r.kind).toBe('needs_project')
    if (r.kind === 'needs_project') expect(r.projects.map((p) => p.id)).toEqual([project.id])
    expect(await client.request('workspace.list', {})).toEqual([])
  })

  it('refuses an unknown ticket', async () => {
    await expect(client.request('tickets.start', { key: 'APP-9' })).rejects.toThrow(/no ticket/)
  })

  it('makes a workspace with the brief, starts claude, learns the project, then reuses both', async () => {
    const project = await addProject()
    const r = await client.request('tickets.start', { key: 'APP-1432', projectId: project.id })
    expect(r.kind).toBe('workspace')
    if (r.kind !== 'workspace') return
    const ws = r.workspace
    expect(ws).toMatchObject({
      name: 'app-1432-add-retry-logic-to-the-uploader',
      title: 'APP-1432 Add retry logic to the uploader',
      projectId: project.id
    })
    expect(ws.brief).toContain('# APP-1432 Add retry logic to the uploader')
    const briefFile = fs.readFileSync(join(ws.path, '.que', 'brief.md'), 'utf8')
    expect(briefFile.startsWith('# APP-1432 Add retry logic to the uploader\n\nhttps://')).toBe(
      true
    )
    expect(briefFile.match(/^# /gm)).toHaveLength(1)

    const brief = fs.readFileSync(join(ws.path, '.que', 'ticket.md'), 'utf8')
    expect(brief).toContain('# APP-1432 Add retry logic to the uploader')
    expect(brief).toContain('https://example.atlassian.net/browse/APP-1432')
    expect(brief).toContain('## Description')
    expect(brief).toContain('- Retry three times')
    expect(brief).toContain('```ts\nawait retry(() => upload(file))\n```')
    expect(gitIn(ws.path, 'status', '--porcelain')).not.toContain('.que')

    expect(await client.request('term.list', { workspaceId: ws.id })).toHaveLength(1)
    await expect
      .poll(
        () => readFakeLog(daemon.claudeLog).some((c) => c.argv.includes(DEFAULT_START_PROMPT)),
        opts
      )
      .toBe(true)

    expect(fs.readFileSync(daemon.configPath, 'utf8')).toMatch(
      new RegExp(`\\[jira\\.projects\\]\\s+APP = "${project.name}"`)
    )
    expect(await client.request('tickets.projectFor', { key: 'APP-1432' })).toEqual({
      projectId: project.id
    })
    expect((await client.request('tickets.list', {})).tickets[0].workspaceId).toBe(ws.id)

    const again = await client.request('tickets.start', { key: 'APP-1432' })
    expect(again.kind === 'workspace' && again.workspace.id).toBe(ws.id)
    expect(await client.request('workspace.list', {})).toHaveLength(1)
    expect(await client.request('term.list', { workspaceId: ws.id })).toHaveLength(2)
  })

  it('writes the brief under the home for a loose session', async () => {
    const r = await client.request('tickets.start', { key: 'APP-1432', session: true })
    expect(r.kind).toBe('session')
    if (r.kind !== 'session') return
    expect(r.terminalId).toMatch(/\S/)
    const file = join(daemon.home, 'tickets', 'APP-1432.md')
    expect(fs.readFileSync(file, 'utf8')).toContain('# APP-1432')
    expect(await client.request('workspace.list', {})).toEqual([])
  })
})

describe('epics and parents', () => {
  const epic = makeFakeEpic()
  const child = (key: string, summary: string) =>
    makeFakeIssue({ key, fields: { summary, parent: fakeParentOf(epic) } })
  const views = () =>
    readFakeLog(daemon.acliLog).filter((c) => c.argv[1] === 'workitem' && c.argv[2] === 'view')
  const list = async () => (await client.request('tickets.list', {})).tickets
  const find = async (key: string) => (await list()).find((t) => t.key === key)

  it("learns each ticket's parent once and leaves epics and loose tickets alone", async () => {
    writeFakeTickets(daemon.acliTickets, [
      epic,
      child('APP-1401', 'First'),
      child('APP-1402', 'Second'),
      makeFakeIssue({ key: 'APP-1500', fields: { summary: 'Loose' } })
    ])
    await expect.poll(async () => (await find('APP-1402'))?.parentKey, opts).toBe('APP-1400')
    await expect.poll(async () => views().length, opts).toBe(3)
    const tickets = await list()
    expect(tickets.map((t) => [t.key, t.level, t.parentKey, t.assigned])).toEqual([
      ['APP-1400', 'epic', null, true],
      ['APP-1401', 'standard', 'APP-1400', true],
      ['APP-1402', 'standard', 'APP-1400', true],
      ['APP-1500', 'standard', null, true]
    ])
    expect(
      views()
        .map((c) => c.argv[3])
        .sort()
    ).toEqual(['APP-1401', 'APP-1402', 'APP-1500'])

    const syncs = () => readFakeLog(daemon.acliLog).filter((c) => c.argv[2] === 'search').length
    const before = syncs()
    await expect.poll(syncs, opts).toBeGreaterThan(before + 1)
    expect(views()).toHaveLength(3)
  })

  it('synthesizes a parent the search did not return and drops it with its last child', async () => {
    writeFakeTickets(daemon.acliTickets, [
      makeFakeIssue({ key: 'APP-1100', fields: { summary: 'Before' } }),
      child('APP-1401', 'Only child')
    ])
    await expect.poll(keys, opts).toEqual(['APP-1100', 'APP-1400', 'APP-1401'])
    expect(await find('APP-1400')).toMatchObject({
      assigned: false,
      level: 'epic',
      summary: 'Uploader reliability',
      url: 'https://example.atlassian.net/browse/APP-1400',
      projectKey: 'APP',
      updatedAt: null,
      parentKey: null
    })
    // The synthesized parent keeps its place across later syncs.
    const syncs = () => readFakeLog(daemon.acliLog).filter((c) => c.argv[2] === 'search').length
    const n = syncs()
    await expect.poll(syncs, opts).toBeGreaterThan(n + 1)
    expect(await keys()).toEqual(['APP-1100', 'APP-1400', 'APP-1401'])

    writeFakeTickets(daemon.acliTickets, [
      makeFakeIssue({ key: 'APP-1100', fields: { summary: 'Before' } })
    ])
    await expect.poll(keys, opts).toEqual(['APP-1100'])
  })

  it('keeps a synthesized parent while a child with a workspace remains', async () => {
    writeFakeTickets(daemon.acliTickets, [child('APP-1401', 'Only child')])
    await expect.poll(keys, opts).toEqual(['APP-1400', 'APP-1401'])
    const project = await addProject()
    const r = await client.request('tickets.start', { key: 'APP-1401', projectId: project.id })
    expect(r.kind).toBe('workspace')
    writeFakeTickets(daemon.acliTickets, [])
    await expect.poll(syncError, opts).toBeNull()
    const n = readFakeLog(daemon.acliLog).filter((c) => c.argv[2] === 'search').length
    await expect
      .poll(() => readFakeLog(daemon.acliLog).filter((c) => c.argv[2] === 'search').length, opts)
      .toBeGreaterThan(n + 1)
    expect(await keys()).toEqual(['APP-1400', 'APP-1401'])
  })

  it("builds links from the CLI's auth status, or from [jira] site", async () => {
    writeFakeTickets(daemon.acliTickets, [newer])
    await expect.poll(keys, opts).toEqual(['APP-1432'])
    expect((await find('APP-1432'))?.url).toBe('https://example.atlassian.net/browse/APP-1432')

    await daemon.close()
    daemon = await startTestDaemon({
      config: '[jira]\npoll_minutes = 0.002\nsite = "https://tracker.example.com/"\n'
    })
    client = daemon.client
    writeFakeTickets(daemon.acliTickets, [newer])
    await expect.poll(keys, opts).toEqual(['APP-1432'])
    expect((await find('APP-1432'))?.url).toBe('https://tracker.example.com/browse/APP-1432')
  })

  it("puts the epic's overview in a started ticket's brief and refuses to start the epic", async () => {
    writeFakeTickets(daemon.acliTickets, [epic, child('APP-1401', 'First')])
    await expect.poll(async () => (await find('APP-1401'))?.parentKey, opts).toBe('APP-1400')
    const project = await addProject()
    const r = await client.request('tickets.start', { key: 'APP-1401', projectId: project.id })
    if (r.kind !== 'workspace') throw new Error(`unexpected ${r.kind}`)
    const brief = fs.readFileSync(join(r.workspace.path, '.que', 'ticket.md'), 'utf8')
    expect(brief).toContain('## Epic APP-1400: Uploader reliability')
    expect(brief).toContain('Make uploads survive flaky networks end to end.')

    await expect(client.request('tickets.start', { key: 'APP-1400' })).rejects.toThrow(
      'APP-1400 is an epic, an overview; start one of its tickets'
    )
  })
})
