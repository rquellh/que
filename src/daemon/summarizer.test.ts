// The summariser's rules as pure functions: the prompt, the transcript tail,
// the reply sanitiser, which workspaces may be summarised, and the throttle
// with an injected clock. Its wiring (the fake claude, hooks, events) is in
// tests/integration/summaries.test.ts.
import { describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import {
  buildSummaryPrompt,
  SUMMARY_INSTRUCTION,
  SummaryThrottle,
  sanitizeSummary,
  summarisable,
  transcriptTail
} from './summarizer'

const BRIEF =
  'Add retry logic to the uploader\n\nRetry failed chunk uploads three times with backoff.'
const MINUTE = 60_000
const T0 = new Date(2026, 9, 16, 14, 0).getTime()

const jsonl = (...entries: unknown[]): string =>
  `${entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`

const assistant = (...texts: string[]) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      ...texts.map((text) => ({ type: 'text', text })),
      { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'src/upload.ts' } }
    ]
  }
})

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws_01hzx3k9c2qf',
    projectId: 'prj_01hzx0a1b2c3',
    name: 'amber-otter-lane',
    branch: 'amber-otter-lane',
    path: '/Users/dev/.que/worktrees/uploader/amber-otter-lane',
    baseRef: 'origin/main',
    status: 'idle',
    statusReason: null,
    statusAt: '2026-10-16T14:00:00.000Z',
    lastActivityAt: null,
    sessionId: null,
    createdAt: '2026-10-16T14:00:00.000Z',
    archivedAt: null,
    prUrl: null,
    pr: null,
    title: 'Add retry logic to the uploader',
    brief: BRIEF,
    titleSource: 'brief',
    ...overrides
  }
}

describe('buildSummaryPrompt', () => {
  it('is the instruction then the brief when there is no progress yet', () => {
    expect(buildSummaryPrompt(BRIEF, null)).toBe(`${SUMMARY_INSTRUCTION}\n\nBrief:\n${BRIEF}`)
  })

  it('adds the latest progress after the brief', () => {
    const prompt = buildSummaryPrompt(BRIEF, 'Backoff is in; writing the tests for it now.')

    expect(prompt).toBe(
      `${SUMMARY_INSTRUCTION}\n\nBrief:\n${BRIEF}\n\nLatest progress:\nBackoff is in; writing the tests for it now.`
    )
  })
})

describe('transcriptTail', () => {
  it('takes the last assistant entry, joining its text blocks and skipping malformed lines', () => {
    const text = jsonl(
      { type: 'user', message: { role: 'user', content: 'Add retry logic to the uploader' } },
      assistant("I'll read the uploader first."),
      assistant('Backoff is in.', 'Writing the tests for it now.'),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"cut off',
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }
    )

    expect(transcriptTail(text)).toBe('Backoff is in.\nWriting the tests for it now.')
  })

  it('reads an assistant entry whose content is a plain string', () => {
    const text = jsonl({ type: 'assistant', message: { role: 'assistant', content: 'Done.' } })

    expect(transcriptTail(text)).toBe('Done.')
  })

  it('keeps the end of a long reply', () => {
    const long = `${'a'.repeat(2_000)}THE END`
    expect(transcriptTail(jsonl(assistant(long)), 1_500)).toBe(long.slice(long.length - 1_500))
  })

  it('is null without an assistant text entry', () => {
    expect(transcriptTail('')).toBeNull()
    expect(
      transcriptTail(jsonl({ type: 'user', message: { content: 'hi' } }, 'not json'))
    ).toBeNull()
  })
})

describe('sanitizeSummary', () => {
  it('takes the first non-empty line without quotes or trailing punctuation', () => {
    expect(sanitizeSummary('\n  "Adding retry backoff to uploads."  \nmore text')).toBe(
      'Adding retry backoff to uploads'
    )
    expect(sanitizeSummary('“Wiring retries into the uploader”!')).toBe(
      'Wiring retries into the uploader'
    )
  })

  it('cuts a long line at 80 characters', () => {
    const title = sanitizeSummary('word '.repeat(30))
    expect(title).toBe('word '.repeat(16).trimEnd())
    expect(title?.length).toBeLessThanOrEqual(80)
  })

  it('is null when nothing is left', () => {
    expect(sanitizeSummary('')).toBeNull()
    expect(sanitizeSummary('  \n "..." \n')).toBeNull()
  })
})

describe('summarisable', () => {
  it('takes a title from the brief or an earlier summary', () => {
    expect(summarisable(workspace())).toBe(true)
    expect(summarisable(workspace({ titleSource: 'summary', title: 'Retrying uploads' }))).toBe(
      true
    )
  })

  it('never touches a title the user set, an archived workspace, or one without a brief', () => {
    expect(summarisable(workspace({ titleSource: 'user', title: 'APP-1432 Retry logic' }))).toBe(
      false
    )
    expect(summarisable(workspace({ archivedAt: '2026-10-16T15:00:00.000Z' }))).toBe(false)
    expect(
      summarisable(workspace({ brief: undefined, title: undefined, titleSource: undefined }))
    ).toBe(false)
  })

  it('reads a row from before title sources by whether its title is the brief line', () => {
    expect(summarisable(workspace({ titleSource: undefined }))).toBe(true)
    expect(summarisable(workspace({ titleSource: undefined, title: 'APP-1432 Retry' }))).toBe(false)
  })
})

describe('SummaryThrottle', () => {
  function throttle(intervalMinutes = 5) {
    let now = T0
    const t = new SummaryThrottle(
      () => intervalMinutes * MINUTE,
      () => now
    )
    return { t, at: (ms: number) => (now = ms) }
  }

  describe('clock', () => {
    it('runs the first request at once', () => {
      const { t } = throttle()
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
    })

    it('leaves one refresh pending for a request inside the interval, due when it ends', () => {
      const { t, at } = throttle()
      t.request('ws_a')
      t.begin('ws_a')
      at(T0 + 10_000)
      expect(t.done('ws_a')).toBeNull()

      at(T0 + 2 * MINUTE)
      expect(t.request('ws_a')).toEqual({ kind: 'later', at: T0 + 10_000 + 5 * MINUTE })
      at(T0 + 3 * MINUTE)
      expect(t.request('ws_a')).toEqual({ kind: 'pending' })

      t.due('ws_a')
      t.begin('ws_a')
      at(T0 + 6 * MINUTE)
      expect(t.done('ws_a')).toBeNull()
    })

    it('runs again once the interval since the last completed call has passed', () => {
      const { t, at } = throttle()
      t.begin('ws_a')
      t.done('ws_a')

      at(T0 + 5 * MINUTE)
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
    })

    it('follows a call in flight with one refresh an interval after it ends', () => {
      const { t, at } = throttle()
      t.begin('ws_a')
      expect(t.request('ws_a')).toEqual({ kind: 'pending' })
      expect(t.request('ws_a')).toEqual({ kind: 'pending' })

      at(T0 + 20_000)
      expect(t.done('ws_a')).toBe(T0 + 20_000 + 5 * MINUTE)
    })

    it('keeps workspaces apart and starts over after forget', () => {
      const { t } = throttle()
      t.begin('ws_a')
      t.done('ws_a')

      expect(t.request('ws_b')).toEqual({ kind: 'now' })
      expect(t.request('ws_a')).toMatchObject({ kind: 'later' })
      t.forget('ws_a')
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
    })
  })

  describe('unchanged input', () => {
    const PROMPT = buildSummaryPrompt(BRIEF, 'Backoff is in.')
    const NEWER = buildSummaryPrompt(BRIEF, 'Backoff is in; the tests pass.')

    it('knows the prompt of the last answered call, and nothing before the first', () => {
      const { t } = throttle()
      expect(t.unchanged('ws_a', PROMPT)).toBe(false)

      t.begin('ws_a')
      t.done('ws_a', PROMPT)

      expect(t.unchanged('ws_a', PROMPT)).toBe(true)
      expect(t.unchanged('ws_a', NEWER)).toBe(false)
      expect(t.unchanged('ws_b', PROMPT)).toBe(false)
    })

    it('does not remember the prompt of a call that got no answer', () => {
      const { t } = throttle()
      t.begin('ws_a')
      t.done('ws_a')

      expect(t.unchanged('ws_a', PROMPT)).toBe(false)
    })

    it('leaves the last call time standing when a run is skipped', () => {
      const { t, at } = throttle()
      t.begin('ws_a')
      t.done('ws_a', PROMPT)

      at(T0 + 6 * MINUTE)
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
      t.begin('ws_a')
      expect(t.skipped('ws_a')).toBeNull()

      at(T0 + 6 * MINUTE + 10_000)
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
    })

    it('keeps a refresh that arrived during a skipped run pending', () => {
      const { t, at } = throttle()
      t.begin('ws_a')
      t.done('ws_a', PROMPT)
      at(T0 + 6 * MINUTE)
      t.begin('ws_a')
      expect(t.request('ws_a')).toEqual({ kind: 'pending' })

      expect(t.skipped('ws_a')).toBe(T0 + 5 * MINUTE)
    })
    it('reads the interval at each request', () => {
      let minutes = 5
      let now = T0
      const t = new SummaryThrottle(
        () => minutes * MINUTE,
        () => now
      )
      t.begin('ws_a')
      t.done('ws_a')

      now = T0 + 2 * MINUTE
      minutes = 1
      expect(t.request('ws_a')).toEqual({ kind: 'now' })
    })
  })
})
