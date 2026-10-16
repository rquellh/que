// Sidebar titles from the background summariser, over the real socket: the
// daemon runs the fake claude (`-p --model … --output-format text`) from
// QUE_HOME on a new brief workspace and after a Stop hook delivered through
// `que hook`, and announces the new title with workspace.updated. The prompt,
// tail, sanitising, and throttle rules are in src/daemon/summarizer.test.ts.
//
// "No call" is proven with a fence: summaries run one at a time in order, so
// once a later workspace's summary has landed, any call the earlier event
// would have made is already in the fake's log.
import fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@shared/client'
import type { Events } from '@shared/protocol'
import type { Workspace } from '@shared/types'
import { runCliWith } from '../../src/testing/cli'
import {
  type FakeCall,
  makeFakeIssue,
  readFakeLog,
  writeFakeTickets
} from '../../src/testing/fakes'
import {
  startTestDaemon,
  type TestDaemon,
  type TestDaemonOptions
} from '../../src/testing/daemon-harness'
import { makeHookEvent } from '../../src/testing/fixtures'
import { makeTempRepo } from '../../src/testing/temp-repo'

const RETRY_BRIEF =
  'Add retry logic to the uploader\n\nRetry failed chunk uploads three times with exponential backoff.'
const FENCE_BRIEF =
  'Document the release checklist\n\nWrite down the steps we follow to cut a release.'
const FAKE_SUMMARY = 'Fake summary of the session'
const opts = { timeout: 15_000 }

let daemon: TestDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

/** A daemon with summaries on (test daemons default them off) unless `config` says otherwise. */
async function start(o: TestDaemonOptions = {}): Promise<{ d: TestDaemon; projectId: string }> {
  const config = o.config ?? ''
  const d = await startTestDaemon({
    ...o,
    config: /^summaries\s*=/m.test(config) ? config : `summaries = true\n${config}`
  })
  daemon = d
  const project = await d.client.request('project.add', { path: makeTempRepo(d.home) })
  return { d, projectId: project.id }
}

function record<E extends keyof Events>(c: DaemonClient, event: E): Events[E][] {
  const seen: Events[E][] = []
  c.on(event, (data) => seen.push(data))
  return seen
}

/** The summariser's calls (one-shot `-p` text runs), oldest first. */
const summaryCalls = (d: TestDaemon): FakeCall[] =>
  readFakeLog(d.claudeLog).filter((c) => c.argv[0] === '-p')

const promptOf = (c: FakeCall): string => c.argv[1]

const titleOf = async (d: TestDaemon, id: string) =>
  (await d.client.request('workspace.get', { id })).title

/** A Stop hook for the workspace's session, delivered by `que hook` as the wrapper would. */
async function sendStop(d: TestDaemon, ws: Workspace, transcriptPath: string): Promise<void> {
  const payload = makeHookEvent('Stop', {
    session_id: '7d0c5b2a-0000-4000-8000-3e4f5a6b7c8d',
    cwd: ws.path,
    transcript_path: transcriptPath,
    stop_hook_active: false
  })
  const r = await runCliWith(
    { input: JSON.stringify(payload), env: { QUE_WORKSPACE_ID: ws.id, QUE_SOCKET: d.socket } },
    'hook'
  )
  expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
}

/** A transcript whose last assistant entry is `text`. */
function writeTranscript(d: TestDaemon, text: string): string {
  const path = join(d.home, 'session-transcript.jsonl')
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Add retry logic to the uploader' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  ]
  fs.writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

/** Creates a brief workspace and waits for its summary: every earlier call is logged by then. */
async function fence(d: TestDaemon, projectId: string): Promise<void> {
  const ws = await d.client.request('workspace.create', { projectId, brief: FENCE_BRIEF })
  await expect.poll(() => titleOf(d, ws.id), opts).toBe(FAKE_SUMMARY)
}

describe('sidebar title summaries', () => {
  describe('on create', () => {
    it('replaces a brief title with the summary from claude run outside the worktree', async () => {
      // A daemon started from inside a que terminal must not pass that workspace on.
      vi.stubEnv('QUE_WORKSPACE_ID', 'ws_01hzxouter000')
      const { d, projectId } = await start()
      const updated = record(d.client, 'workspace.updated')

      const ws = await d.client.request('workspace.create', { projectId, brief: RETRY_BRIEF })

      expect(ws).toMatchObject({ title: 'Add retry logic to the uploader', titleSource: 'brief' })
      await expect.poll(() => titleOf(d, ws.id), opts).toBe(FAKE_SUMMARY)
      expect(await d.client.request('workspace.get', { id: ws.id })).toMatchObject({
        titleSource: 'summary'
      })
      expect(updated.some((u) => u.id === ws.id && u.title === FAKE_SUMMARY)).toBe(true)
      const [call] = summaryCalls(d)
      expect(call.argv).toEqual([
        '-p',
        expect.any(String),
        '--model',
        'haiku',
        '--output-format',
        'text'
      ])
      expect(promptOf(call)).toContain(RETRY_BRIEF)
      expect(promptOf(call)).not.toContain('Latest progress:')
      expect(call.cwd).toBe(d.home)
      expect(call.cwd.startsWith(ws.path)).toBe(false)
      expect(call.env).not.toContain('QUE_WORKSPACE_ID')
    }, 30_000)
  })

  describe('task workspaces', () => {
    it('summarises the workspace of a task queued from a bare brief', async () => {
      const { d, projectId } = await start()

      const task = await d.client.request('task.add', { projectId, brief: RETRY_BRIEF })
      await d.client.request('queue.open')

      await expect
        .poll(async () => (await d.client.request('task.get', { id: task.id })).workspaceId, opts)
        .toMatch(/^ws_/)
      const { workspaceId } = await d.client.request('task.get', { id: task.id })
      await expect.poll(() => titleOf(d, workspaceId as string), opts).toBe(FAKE_SUMMARY)
      expect(promptOf(summaryCalls(d)[0])).toContain(RETRY_BRIEF)
    }, 45_000)
  })

  describe('after a turn', () => {
    it('re-summarises on Stop with the transcript tail, once per interval', async () => {
      vi.stubEnv('QUE_WORKSPACE_ID', 'ws_01hzxouter000')
      const { d, projectId } = await start({ config: 'summaries = false\n' })
      const ws = await d.client.request('workspace.create', { projectId, brief: RETRY_BRIEF })
      await d.client.request('config.set', { patch: { summaries: true } })
      vi.stubEnv('QUE_FAKE_CLAUDE_SUMMARY', '"Adding backoff to chunk uploads."')
      const transcript = writeTranscript(d, 'Backoff is in; the uploader retries each chunk.')

      await sendStop(d, ws, transcript)

      await expect.poll(() => titleOf(d, ws.id), opts).toBe('Adding backoff to chunk uploads')
      const [call, ...rest] = summaryCalls(d)
      expect(rest).toEqual([])
      expect(call.argv).toEqual([
        '-p',
        expect.stringContaining(
          `${RETRY_BRIEF}\n\nLatest progress:\nBackoff is in; the uploader retries each chunk.`
        ),
        '--model',
        'haiku',
        '--output-format',
        'text'
      ])
      expect(call.cwd).toBe(d.home)
      expect(call.env).not.toContain('QUE_WORKSPACE_ID')

      vi.stubEnv('QUE_FAKE_CLAUDE_SUMMARY', FAKE_SUMMARY)
      await sendStop(d, ws, transcript)
      await fence(d, projectId)

      const calls = summaryCalls(d)
      expect(calls.filter((c) => promptOf(c).includes(RETRY_BRIEF))).toHaveLength(1)
      expect(await titleOf(d, ws.id)).toBe('Adding backoff to chunk uploads')
    }, 45_000)

    it('leaves a renamed workspace alone', async () => {
      const { d, projectId } = await start()
      const ws = await d.client.request('workspace.create', { projectId, brief: RETRY_BRIEF })
      await expect.poll(() => titleOf(d, ws.id), opts).toBe(FAKE_SUMMARY)

      const renamed = await d.client.request('workspace.rename', {
        id: ws.id,
        title: 'Uploader retries'
      })
      expect(renamed).toMatchObject({ title: 'Uploader retries', titleSource: 'user' })
      await sendStop(d, ws, writeTranscript(d, 'Retries are wired in.'))
      await fence(d, projectId)

      expect(summaryCalls(d).filter((c) => promptOf(c).includes(RETRY_BRIEF))).toHaveLength(1)
      expect(await titleOf(d, ws.id)).toBe('Uploader retries')
    }, 45_000)
  })

  describe('unchanged input', () => {
    it('skips a Stop whose transcript has not moved on, and runs once it has', async () => {
      let ahead = 0
      const { d, projectId } = await start({
        config: 'summaries = false\n',
        now: () => Date.now() + ahead
      })
      const ws = await d.client.request('workspace.create', { projectId, brief: RETRY_BRIEF })
      await d.client.request('config.set', { patch: { summaries: true } })
      const transcript = writeTranscript(d, 'Backoff is in; the uploader retries each chunk.')
      const retryCalls = () => summaryCalls(d).filter((c) => promptOf(c).includes(RETRY_BRIEF))
      await sendStop(d, ws, transcript)
      await expect.poll(() => titleOf(d, ws.id), opts).toBe(FAKE_SUMMARY)

      // Past the interval, the same transcript: no call.
      ahead = 6 * 60_000
      await sendStop(d, ws, transcript)
      await fence(d, projectId)
      expect(retryCalls()).toHaveLength(1)

      // A new assistant entry: the next Stop calls with it.
      fs.appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The retry tests pass.' }] }
        })}\n`
      )
      vi.stubEnv('QUE_FAKE_CLAUDE_SUMMARY', 'Retry tests passing for uploads')
      await sendStop(d, ws, transcript)

      await expect.poll(() => titleOf(d, ws.id), opts).toBe('Retry tests passing for uploads')
      const calls = retryCalls()
      expect(calls).toHaveLength(2)
      expect(calls[1].argv).toEqual([
        '-p',
        expect.stringContaining('Latest progress:\nThe retry tests pass.'),
        '--model',
        'haiku',
        '--output-format',
        'text'
      ])
      expect(calls[1].cwd).toBe(d.home)
      expect(calls[1].env).not.toContain('QUE_WORKSPACE_ID')
    }, 45_000)
  })

  describe('off', () => {
    it('makes no calls while summaries is false', async () => {
      const { d, projectId } = await start({ config: 'summaries = false\n' })
      const ws = await d.client.request('workspace.create', { projectId, brief: RETRY_BRIEF })
      await sendStop(d, ws, writeTranscript(d, 'Retries are wired in.'))

      await d.client.request('config.set', { patch: { summaries: true } })
      await fence(d, projectId)

      expect(summaryCalls(d).map(promptOf)).toEqual([expect.stringContaining(FENCE_BRIEF)])
      expect(await titleOf(d, ws.id)).toBe('Add retry logic to the uploader')
    }, 45_000)

    it('never summarises a ticket workspace, even after its session completes a turn', async () => {
      const { d, projectId } = await start({ config: '[jira]\npoll_minutes = 0.002\n' })
      const statuses = record(d.client, 'workspace.status')
      writeFakeTickets(d.acliTickets, [makeFakeIssue()])
      await expect
        .poll(async () => (await d.client.request('tickets.list', {})).tickets.length, opts)
        .toBe(1)

      const r = await d.client.request('tickets.start', { key: 'APP-1432', projectId })
      if (r.kind !== 'workspace') throw new Error(`expected a workspace, got ${r.kind}`)
      expect(r.workspace.titleSource).toBe('user')
      // The started claude finishes its first turn: working, then idle on Stop.
      const idleAfterWork = () => {
        const seen = statuses.filter((s) => s.id === r.workspace.id).map((s) => s.status)
        const working = seen.indexOf('working')
        return working >= 0 && seen.lastIndexOf('idle') > working
      }
      await expect.poll(idleAfterWork, { timeout: 20_000 }).toBe(true)
      await fence(d, projectId)

      expect(summaryCalls(d).map(promptOf)).toEqual([expect.stringContaining(FENCE_BRIEF)])
      expect(await titleOf(d, r.workspace.id)).toBe('APP-1432 Add retry logic to the uploader')
    }, 45_000)
  })
})
