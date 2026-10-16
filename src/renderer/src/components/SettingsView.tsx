import { useEffect, useRef, useState } from 'react'
import type {
  InstructionsGetResult,
  QuietHoursConfig,
  UserConfig,
  Weekday
} from '../../../preload/index.d'
import { currentWindow } from '../../../daemon/quiet-hours'
import { SUGGESTED_START_PROMPT } from '../../../shared/brief'
import { WEEKDAYS } from '../../../shared/types'
import { useQue, useStore } from '../store'
import UnlockStatus from './UnlockStatus'

type DayMode = 'inherit' | 'custom' | 'none'

interface DayForm {
  mode: DayMode
  start: string
  end: string
}

interface Form {
  enabled: boolean
  start: string
  end: string
  days: Record<Weekday, DayForm>
  unlockMinutes: string
  chimeComplete: boolean
  chimeNeedsInput: boolean
  morningSummary: boolean
  protectedBranches: string
  jql: string
  site: string
  pollMinutes: string
  startPrompt: string
  /** Send `start_prompt` to Claude instead of the brief (off: `start_prompt` is removed). */
  useStartPrompt: boolean
  /** The top-level `start_prompt`, for a workspace made from a brief. */
  workspacePrompt: string
  instructionsFile: string
  summaries: boolean
  summaryModel: string
  summaryInterval: string
}

/** Monday first, as people read a week. */
const WEEK: Weekday[] = [...WEEKDAYS.slice(1), WEEKDAYS[0]]

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** How long the Saved mark stays after a write. */
const SAVED_MS = 2_000

function toForm(c: UserConfig): Form {
  const q = c.quietHours
  const days = Object.fromEntries(
    WEEKDAYS.map((d) => {
      const o = q.days[d]
      const day: DayForm =
        o === undefined
          ? { mode: 'inherit', start: q.default.start, end: q.default.end }
          : o === 'none'
            ? { mode: 'none', start: q.default.start, end: q.default.end }
            : { mode: 'custom', start: o.start, end: o.end }
      return [d, day]
    })
  ) as Record<Weekday, DayForm>
  return {
    enabled: q.enabled,
    start: q.default.start,
    end: q.default.end,
    days,
    unlockMinutes: String(q.unlockMinutes),
    chimeComplete: c.notifications.chimeOnComplete,
    chimeNeedsInput: c.notifications.chimeOnNeedsInput,
    morningSummary: c.notifications.morningSummary,
    protectedBranches: c.protectedBranches.join(', '),
    jql: c.jira.jql,
    site: c.jira.site ?? '',
    pollMinutes: String(c.jira.pollMinutes),
    startPrompt: c.jira.startPrompt,
    useStartPrompt: c.startPrompt.trim() !== '',
    workspacePrompt: c.startPrompt,
    instructionsFile: c.instructionsFile ?? '',
    summaries: c.summaries,
    summaryModel: c.summaryModel,
    summaryInterval: String(c.summaryIntervalMinutes)
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function quietOf(f: Form): QuietHoursConfig {
  const days: QuietHoursConfig['days'] = {}
  for (const d of WEEKDAYS) {
    const day = f.days[d]
    if (day.mode === 'none') days[d] = 'none'
    else if (day.mode === 'custom') days[d] = { start: day.start, end: day.end }
  }
  return {
    enabled: f.enabled,
    default: { start: f.start, end: f.end },
    days,
    unlockMinutes: Number(f.unlockMinutes)
  }
}

/** A quiet window's problem, or null. */
function windowProblem(start: string, end: string): string | null {
  if (!HHMM.test(start) || !HHMM.test(end)) return 'Use 24-hour HH:MM times'
  if (start === end) return 'Start and end must differ'
  return null
}

function positive(value: string, message: string): string | null {
  const n = Number(value)
  return value.trim() === '' || !Number.isFinite(n) || n <= 0 ? message : null
}

function filled(value: string, message: string): string | null {
  return value.trim() === '' ? message : null
}

/** One setting the view validates and writes on its own. */
interface FieldSpec {
  /** Copies this field's part of `from` over `into`. */
  take: (from: Form, into: Form) => Form
  /** What is wrong with this field's value in a form, or null. */
  check?: (f: Form) => string | null
  /** The config.set patch (the file's snake_case keys) for this field alone; `null` removes. */
  patch: (f: Form) => Record<string, unknown>
  /** A quiet-hours write, which may end tonight's window early and so asks first. */
  quiet?: true
}

const own =
  (...keys: Array<keyof Form>) =>
  (from: Form, into: Form): Form => {
    const next: Record<string, unknown> = { ...into }
    for (const k of keys) next[k] = from[k]
    return next as unknown as Form
  }

const quietPatch = (q: Record<string, unknown>): Record<string, unknown> => ({ quiet_hours: q })

function daySpec(d: Weekday): FieldSpec {
  return {
    take: (from, into) => ({ ...into, days: { ...into.days, [d]: { ...from.days[d] } } }),
    check: (f) =>
      f.days[d].mode === 'custom' ? windowProblem(f.days[d].start, f.days[d].end) : null,
    patch: (f) => {
      const day = f.days[d]
      return quietPatch({
        [d]: day.mode === 'inherit' ? null : day.mode === 'none' ? 'none' : [day.start, day.end]
      })
    },
    quiet: true
  }
}

/** The toggle and its prompt write one key: the prompt while on, removed while off. */
const startPromptSpec: FieldSpec = {
  take: own('useStartPrompt', 'workspacePrompt'),
  check: (f) =>
    f.useStartPrompt
      ? filled(f.workspacePrompt, 'The workspace start prompt cannot be empty')
      : null,
  patch: (f) => ({ start_prompt: f.useStartPrompt ? f.workspacePrompt : null })
}

const DAY_SPECS = Object.fromEntries(WEEKDAYS.map((d) => [`day-${d}`, daySpec(d)])) as Record<
  `day-${Weekday}`,
  FieldSpec
>

const SPECS = {
  'quiet-enabled': {
    take: own('enabled'),
    patch: (f) => quietPatch({ enabled: f.enabled }),
    quiet: true
  },
  'quiet-start': {
    take: own('start'),
    check: (f) => windowProblem(f.start, f.end),
    patch: (f) => quietPatch({ default: [f.start, f.end] }),
    quiet: true
  },
  'quiet-end': {
    take: own('end'),
    check: (f) => windowProblem(f.start, f.end),
    patch: (f) => quietPatch({ default: [f.start, f.end] }),
    quiet: true
  },
  'unlock-minutes': {
    take: own('unlockMinutes'),
    check: (f) => positive(f.unlockMinutes, 'Unlock minutes must be a positive number'),
    patch: (f) => quietPatch({ unlock_minutes: Number(f.unlockMinutes) }),
    quiet: true
  },
  ...DAY_SPECS,
  'chime-complete': {
    take: own('chimeComplete'),
    patch: (f) => ({ notifications: { chime_on_complete: f.chimeComplete } })
  },
  'chime-needs-input': {
    take: own('chimeNeedsInput'),
    patch: (f) => ({ notifications: { chime_on_needs_input: f.chimeNeedsInput } })
  },
  'morning-summary': {
    take: own('morningSummary'),
    patch: (f) => ({ notifications: { morning_summary: f.morningSummary } })
  },
  'tickets-jql': {
    take: own('jql'),
    patch: (f) => ({ jira: { jql: f.jql } })
  },
  'jira-site': {
    take: own('site'),
    patch: (f) => ({ jira: { site: f.site.trim() === '' ? null : f.site.trim() } })
  },
  'tickets-poll': {
    take: own('pollMinutes'),
    check: (f) => positive(f.pollMinutes, 'Sync minutes must be a positive number'),
    patch: (f) => ({ jira: { poll_minutes: Number(f.pollMinutes) } })
  },
  'tickets-prompt': {
    take: own('startPrompt'),
    check: (f) => filled(f.startPrompt, 'The start prompt cannot be empty'),
    patch: (f) => ({ jira: { start_prompt: f.startPrompt } })
  },
  'start-prompt-enabled': startPromptSpec,
  'workspace-prompt': startPromptSpec,
  'summaries-enabled': {
    take: own('summaries'),
    patch: (f) => ({ summaries: f.summaries })
  },
  'summary-model': {
    take: own('summaryModel'),
    check: (f) => filled(f.summaryModel, 'The summary model cannot be empty'),
    patch: (f) => ({ summary_model: f.summaryModel.trim() })
  },
  'summary-interval': {
    take: own('summaryInterval'),
    check: (f) => {
      const n = Number(f.summaryInterval)
      return f.summaryInterval.trim() === '' || !Number.isInteger(n) || n < 1
        ? 'Summary minutes must be a whole number of at least 1'
        : null
    },
    patch: (f) => ({ summary_interval_minutes: Number(f.summaryInterval) })
  },
  'instructions-file': {
    take: own('instructionsFile'),
    check: (f) => {
      const file = f.instructionsFile.trim()
      return file !== '' && !file.startsWith('/') && !file.startsWith('~')
        ? 'The instructions file must be an absolute path or start with ~'
        : null
    },
    patch: (f) => ({
      instructions_file: f.instructionsFile.trim() === '' ? null : f.instructionsFile.trim()
    })
  },
  'protected-branches': {
    take: own('protectedBranches'),
    patch: (f) => ({
      protected_branches: f.protectedBranches
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b !== '')
    })
  }
} satisfies Record<string, FieldSpec>

type Field = keyof typeof SPECS

/** The instructions file's text, written through instructions.set rather than config.set. */
const CONTENT = 'instructions-content'
type Mark = Field | typeof CONTENT

/** A brief "Saved" after a write: a polite live region, the mark fading as it goes. */
function SavedMark({ field, shown }: { field: Mark; shown: boolean }): React.JSX.Element {
  return (
    <span className="saved-slot" role="status">
      {shown && (
        <span className="saved-mark" data-testid={`settings-${field}-saved`}>
          Saved
        </span>
      )}
    </span>
  )
}

/** A field's own problem: a value it refuses, or the daemon's refusal of the write. */
function FieldError({ field, error }: { field: Mark; error?: string }): React.JSX.Element | null {
  if (!error) return null
  return (
    <span className="form-error" role="alert" data-testid={`settings-${field}-error`}>
      {error}
    </span>
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A number field's change from its stepper (or arrow keys) rather than from typing. */
function stepped(e: React.ChangeEvent<HTMLInputElement>): boolean {
  return !(e.nativeEvent as InputEvent).inputType
}

/**
 * Quiet hours, notifications and the rest of the config file. Each field writes on its own:
 * toggles, selects and steppers as they change, text on blur or Enter (Escape reverts), each
 * followed by a brief Saved mark or its own error.
 */
export default function SettingsView(): React.JSX.Element {
  const store = useStore()
  const { config, quiet, connected } = useQue()
  const [form, setForm] = useState<Form | null>(null)
  const formRef = useRef<Form | null>(null)
  formRef.current = form
  /** What the daemon last accepted, field by field: the base of every write and of Escape. */
  const saved = useRef<Form | null>(null)
  /** Each field's writes run one after another, so a slow answer never lands after a newer one. */
  const chains = useRef(new Map<Mark, Promise<void>>())
  const quietRef = useRef(quiet)
  quietRef.current = quiet
  const live = useRef(true)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const stamp = useRef(0)
  const [errors, setErrors] = useState<Partial<Record<Mark, string>>>({})
  const [marks, setMarks] = useState<Partial<Record<Mark, number>>>({})
  /** Quiet-hours writes waiting on "apply tonight?", answered in order. */
  const asks = useRef<Array<(tonight: boolean) => void>>([])
  const [asking, setAsking] = useState(false)
  const [instructions, setInstructions] = useState<InstructionsGetResult | null>(null)
  const [draft, setDraft] = useState('')
  const draftRef = useRef('')
  draftRef.current = draft
  const savedContent = useRef('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const instructionsFile = config?.config.instructionsFile

  useEffect(() => {
    if (config && form === null) {
      const f = toForm(config.config)
      saved.current = f
      setForm(f)
    }
  }, [config, form])

  useEffect(() => {
    live.current = true
    const pending = timers.current
    return () => {
      live.current = false
      for (const t of pending) clearTimeout(t)
      pending.clear()
    }
  }, [])

  // The file's text, read again whenever the configured path changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on a new path only
  useEffect(() => {
    let current = true
    store.loadInstructions().then(
      (r) => {
        if (!current) return
        setInstructions(r)
        setDraft(r.content)
        savedContent.current = r.content
        setLoadError(null)
      },
      (err: unknown) => {
        if (current) setLoadError(messageOf(err))
      }
    )
    return () => {
      current = false
    }
  }, [store, instructionsFile])

  if (!form || !config) {
    return (
      <section className="settings" data-testid="settings-view" aria-label="Settings">
        <p className="empty-note">Loading…</p>
      </section>
    )
  }

  const setError = (field: Mark, error: string | null): void =>
    setErrors((e) => {
      if ((e[field] ?? null) === error) return e
      const next = { ...e }
      if (error === null) delete next[field]
      else next[field] = error
      return next
    })

  const flash = (field: Mark): void => {
    stamp.current += 1
    const mine = stamp.current
    setMarks((m) => ({ ...m, [field]: mine }))
    const t = setTimeout(() => {
      timers.current.delete(t)
      setMarks((m) => {
        if (m[field] !== mine) return m
        const next = { ...m }
        delete next[field]
        return next
      })
    }, SAVED_MS)
    timers.current.add(t)
  }

  const enqueue = (field: Mark, job: () => Promise<void>): void => {
    const prev = chains.current.get(field) ?? Promise.resolve()
    chains.current.set(
      field,
      prev.then(job).catch(() => {})
    )
  }

  const ask = (): Promise<boolean> =>
    new Promise((resolve) => {
      asks.current.push(resolve)
      setAsking(true)
    })

  const answer = (tonight: boolean): void => {
    const resolve = asks.current.shift()
    setAsking(asks.current.length > 0)
    resolve?.(tonight)
  }

  /** Tonight's window in progress would end sooner (or go away) under this config. */
  const endsTonightEarly = (candidate: Form): boolean => {
    const q = quietRef.current
    if (!q?.inQuietHours || !q.windowEnd) return false
    const next = currentWindow(store.now(), quietOf(candidate))
    return !next || next.end.getTime() < Date.parse(q.windowEnd)
  }

  /** Validates one field's value in `next` and, when it is fine and changed, writes it alone. */
  const commit = (field: Field, next: Form | null): void => {
    const base = saved.current
    if (!next || !base) return
    const spec: FieldSpec = SPECS[field]
    const problem = spec.check?.(spec.take(next, base)) ?? null
    setError(field, problem)
    if (problem) return
    enqueue(field, async () => {
      const before = saved.current ?? base
      const candidate = spec.take(next, before)
      const patch = spec.patch(candidate)
      if (JSON.stringify(patch) === JSON.stringify(spec.patch(before))) return
      const applyTonight = spec.quiet && endsTonightEarly(candidate) ? await ask() : false
      try {
        await store.saveConfig({ patch, applyTonight })
        saved.current = spec.take(next, saved.current ?? before)
        if (!live.current) return
        setError(field, null)
        flash(field)
      } catch (err) {
        if (live.current) setError(field, messageOf(err))
      }
    })
  }

  const revert = (field: Field): void => {
    const base = saved.current
    if (base) setForm((f) => (f ? SPECS[field].take(base, f) : f))
    setError(field, null)
  }

  const commitContent = (): void => {
    const text = draftRef.current
    enqueue(CONTENT, async () => {
      if (text === savedContent.current) return
      try {
        const r = await store.saveInstructions(text)
        savedContent.current = r.content
        if (!live.current) return
        setInstructions(r)
        setError(CONTENT, null)
        flash(CONTENT)
      } catch (err) {
        if (live.current) setError(CONTENT, messageOf(err))
      }
    })
  }

  /** A text field: written on blur, or on Enter in a one-line input; Escape reverts it. */
  const text = (field: Field) => ({
    onBlur: () => commit(field, formRef.current),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && e.currentTarget instanceof HTMLInputElement) {
        e.preventDefault()
        commit(field, formRef.current)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        revert(field)
      }
    }
  })

  /** A toggle or select: written as it changes. */
  const now = (field: Field, patch: Partial<Form>): void => {
    const next = { ...form, ...patch }
    setForm(next)
    commit(field, next)
  }

  const update = (patch: Partial<Form>): void => setForm({ ...form, ...patch })

  /** A number field: a stepper writes at once, typing waits for blur or Enter. */
  const number =
    (field: Field, key: 'unlockMinutes' | 'pollMinutes' | 'summaryInterval') =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const next = { ...form, [key]: e.target.value }
      setForm(next)
      if (stepped(e)) commit(field, next)
    }

  const dayOf = (d: Weekday, patch: Partial<DayForm>): Form => ({
    ...form,
    days: { ...form.days, [d]: { ...form.days[d], ...patch } }
  })

  const head = (label: string, field: Mark): React.JSX.Element => (
    <span className="field-head">
      {label}
      <SavedMark field={field} shown={marks[field] !== undefined} />
    </span>
  )
  const mark = (field: Mark): React.JSX.Element => (
    <SavedMark field={field} shown={marks[field] !== undefined} />
  )
  const error = (field: Mark): React.JSX.Element => (
    <FieldError field={field} error={errors[field]} />
  )
  const off = !connected

  return (
    <section className="settings" data-testid="settings-view" aria-labelledby="settings-title">
      <header className="topbar">
        <h1 className="title" id="settings-title">
          Settings
        </h1>
        <span className="cwd muted" data-testid="settings-path" title={config.path}>
          {config.path}
        </span>
        <UnlockStatus />
      </header>
      <form className="settings-body" onSubmit={(e) => e.preventDefault()} noValidate>
        <fieldset disabled={off}>
          <legend>Quiet hours</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-quiet-enabled"
              checked={form.enabled}
              onChange={(e) => now('quiet-enabled', { enabled: e.target.checked })}
            />
            Quiet hours on
            {mark('quiet-enabled')}
          </label>
          {error('quiet-enabled')}
          <div className="row">
            <label>
              {head('Start', 'quiet-start')}
              <input
                type="time"
                data-testid="settings-quiet-start"
                value={form.start}
                onChange={(e) => update({ start: e.target.value })}
                {...text('quiet-start')}
              />
              {error('quiet-start')}
            </label>
            <label>
              {head('End', 'quiet-end')}
              <input
                type="time"
                data-testid="settings-quiet-end"
                value={form.end}
                onChange={(e) => update({ end: e.target.value })}
                {...text('quiet-end')}
              />
              {error('quiet-end')}
            </label>
            <label>
              {head('Unlock minutes', 'unlock-minutes')}
              <input
                type="number"
                min="1"
                data-testid="settings-unlock-minutes"
                value={form.unlockMinutes}
                onChange={number('unlock-minutes', 'unlockMinutes')}
                {...text('unlock-minutes')}
              />
              {error('unlock-minutes')}
            </label>
          </div>
          <table className="days">
            <tbody>
              {WEEK.map((d) => {
                const day = form.days[d]
                const field = `day-${d}` as const
                const times = text(field)
                return (
                  <tr key={d} data-testid={`settings-day-${d}`}>
                    <th scope="row">{capital(d)}</th>
                    <td>
                      <select
                        aria-label={`${capital(d)} quiet hours`}
                        data-testid={`settings-day-${d}-mode`}
                        value={day.mode}
                        onChange={(e) => {
                          const next = dayOf(d, { mode: e.target.value as DayMode })
                          setForm(next)
                          commit(field, next)
                        }}
                      >
                        <option value="inherit">Default</option>
                        <option value="custom">Custom</option>
                        <option value="none">None</option>
                      </select>
                    </td>
                    <td>
                      {day.mode === 'custom' && (
                        <span className="row">
                          <input
                            type="time"
                            aria-label={`${capital(d)} start`}
                            data-testid={`settings-day-${d}-start`}
                            value={day.start}
                            onChange={(e) => setForm(dayOf(d, { start: e.target.value }))}
                            {...times}
                          />
                          <input
                            type="time"
                            aria-label={`${capital(d)} end`}
                            data-testid={`settings-day-${d}-end`}
                            value={day.end}
                            onChange={(e) => setForm(dayOf(d, { end: e.target.value }))}
                            {...times}
                          />
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="day-status">
                        {mark(field)}
                        {error(field)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {asking && (
            <section
              className="apply-tonight"
              aria-labelledby="settings-apply-tonight-title"
              data-testid="settings-apply-tonight-confirm"
            >
              <p className="hint">
                <strong id="settings-apply-tonight-title">Apply tonight?</strong> This ends
                tonight&apos;s quiet hours early. Apply it tonight, or save it for tomorrow?
              </p>
              <div className="dialog-actions">
                <button
                  type="button"
                  data-testid="settings-apply-tonight-no"
                  onClick={() => answer(false)}
                >
                  No, from tomorrow
                </button>
                <button
                  type="button"
                  data-testid="settings-apply-tonight-yes"
                  onClick={() => answer(true)}
                >
                  Yes, tonight
                </button>
              </div>
            </section>
          )}
        </fieldset>
        <fieldset disabled={off}>
          <legend>Notifications</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-chime-complete"
              checked={form.chimeComplete}
              onChange={(e) => now('chime-complete', { chimeComplete: e.target.checked })}
            />
            Chime when a session finishes a turn or a task finishes (work hours)
            {mark('chime-complete')}
          </label>
          {error('chime-complete')}
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-chime-needs-input"
              checked={form.chimeNeedsInput}
              onChange={(e) => now('chime-needs-input', { chimeNeedsInput: e.target.checked })}
            />
            Chime when a session needs input (work hours)
            {mark('chime-needs-input')}
          </label>
          {error('chime-needs-input')}
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-morning-summary"
              checked={form.morningSummary}
              onChange={(e) => now('morning-summary', { morningSummary: e.target.checked })}
            />
            Morning summary when quiet hours end
            {mark('morning-summary')}
          </label>
          {error('morning-summary')}
        </fieldset>
        <fieldset disabled={off}>
          <legend>Tickets</legend>
          <label>
            {head('Filter', 'tickets-jql')}
            <input
              data-testid="settings-tickets-jql"
              value={form.jql}
              onChange={(e) => update({ jql: e.target.value })}
              {...text('tickets-jql')}
              autoComplete="off"
              spellCheck={false}
            />
            {error('tickets-jql')}
          </label>
          <label>
            {head('Site', 'jira-site')}
            <input
              data-testid="settings-jira-site"
              value={form.site}
              onChange={(e) => update({ site: e.target.value })}
              {...text('jira-site')}
              placeholder="team.example.net"
              autoComplete="off"
              spellCheck={false}
            />
            {error('jira-site')}
            <span className="hint">
              The tracker host for ticket links; found from the CLI when empty
            </span>
          </label>
          <label>
            {head('Sync every (minutes)', 'tickets-poll')}
            <input
              type="number"
              min="1"
              data-testid="settings-tickets-poll"
              value={form.pollMinutes}
              onChange={number('tickets-poll', 'pollMinutes')}
              {...text('tickets-poll')}
            />
            {error('tickets-poll')}
          </label>
          <label>
            {head('Start prompt', 'tickets-prompt')}
            <textarea
              rows={3}
              data-testid="settings-tickets-prompt"
              value={form.startPrompt}
              onChange={(e) => update({ startPrompt: e.target.value })}
              {...text('tickets-prompt')}
            />
            {error('tickets-prompt')}
          </label>
          <div data-testid="settings-tickets-projects" className="projects-learned">
            {Object.keys(config.config.jira.projects).length === 0 ? (
              <p className="hint">No projects learned yet.</p>
            ) : (
              Object.entries(config.config.jira.projects).map(([key, name]) => (
                <div key={key}>
                  {key} → {name}
                </div>
              ))
            )}
          </div>
        </fieldset>
        <fieldset disabled={off}>
          <legend>New workspaces</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-start-prompt-enabled"
              checked={form.useStartPrompt}
              onChange={(e) =>
                now('start-prompt-enabled', {
                  useStartPrompt: e.target.checked,
                  ...(e.target.checked && form.workspacePrompt.trim() === ''
                    ? { workspacePrompt: SUGGESTED_START_PROMPT }
                    : {})
                })
              }
            />
            Use a start prompt instead of the brief
            {mark('start-prompt-enabled')}
          </label>
          {error('start-prompt-enabled')}
          {form.useStartPrompt ? (
            <label>
              {head('Start prompt', 'workspace-prompt')}
              <textarea
                rows={3}
                data-testid="settings-workspace-prompt"
                value={form.workspacePrompt}
                onChange={(e) => update({ workspacePrompt: e.target.value })}
                {...text('workspace-prompt')}
              />
              {error('workspace-prompt')}
              <span className="hint">
                Sent to Claude instead of the brief; the brief is in .que/brief.md
              </span>
            </label>
          ) : (
            <p className="hint">Claude starts on the brief itself.</p>
          )}
        </fieldset>
        <fieldset disabled={off}>
          <legend>Sidebar titles</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-summaries-enabled"
              checked={form.summaries}
              onChange={(e) => now('summaries-enabled', { summaries: e.target.checked })}
            />
            Summarise what each session is doing in its sidebar title
            {mark('summaries-enabled')}
          </label>
          {error('summaries-enabled')}
          <label>
            {head('Model', 'summary-model')}
            <input
              data-testid="settings-summary-model"
              value={form.summaryModel}
              onChange={(e) => update({ summaryModel: e.target.value })}
              {...text('summary-model')}
              autoComplete="off"
              spellCheck={false}
            />
            {error('summary-model')}
          </label>
          <label>
            {head('At most every (minutes)', 'summary-interval')}
            <input
              type="number"
              min="1"
              step="1"
              data-testid="settings-summary-interval"
              value={form.summaryInterval}
              onChange={number('summary-interval', 'summaryInterval')}
              {...text('summary-interval')}
            />
            {error('summary-interval')}
            <span className="hint">
              One short call to the model after a turn ends; renaming a workspace keeps your title
            </span>
          </label>
        </fieldset>
        <fieldset data-testid="settings-instructions" disabled={off}>
          <legend>Instructions</legend>
          <label>
            {head('File', 'instructions-file')}
            <input
              data-testid="settings-instructions-file"
              value={form.instructionsFile}
              onChange={(e) => update({ instructionsFile: e.target.value })}
              {...text('instructions-file')}
              placeholder="~/.config/que/instructions.md"
              autoComplete="off"
              spellCheck={false}
            />
            {error('instructions-file')}
            <span className="hint">
              Appended to the system prompt of every session started in a workspace. New sessions
              pick up edits; a resumed one after it compacts.
            </span>
          </label>
          <label>
            {head('Content', CONTENT)}
            <textarea
              rows={8}
              data-testid="settings-instructions-content"
              value={draft}
              disabled={!instructions?.path}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitContent}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                e.stopPropagation()
                setDraft(savedContent.current)
                setError(CONTENT, null)
              }}
            />
            {error(CONTENT)}
          </label>
          {!instructions?.path && (
            <p className="hint" data-testid="settings-instructions-unset">
              Set a file above to edit the instructions here.
            </p>
          )}
          {loadError && (
            <p className="form-error" role="alert" data-testid="settings-instructions-error">
              {loadError}
            </p>
          )}
        </fieldset>
        <fieldset disabled={off}>
          <legend>Pull requests</legend>
          <label>
            {head('Protected branches', 'protected-branches')}
            <input
              data-testid="settings-protected-branches"
              value={form.protectedBranches}
              onChange={(e) => update({ protectedBranches: e.target.value })}
              {...text('protected-branches')}
            />
            {error('protected-branches')}
          </label>
          <p className="hint">
            Never pushed to by Create draft PR or by an overnight task, besides each project&apos;s
            default branch. Comma-separated.
          </p>
        </fieldset>
      </form>
    </section>
  )
}
