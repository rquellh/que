import { useEffect, useState } from 'react'
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
import Dialog from './Dialog'
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

/** The form's problems, one line each; empty when it can be saved. */
function validate(f: Form): string[] {
  const errors: string[] = []
  const window = (label: string, start: string, end: string): void => {
    if (!HHMM.test(start) || !HHMM.test(end)) errors.push(`${label}: use 24-hour HH:MM times`)
    else if (start === end) errors.push(`${label}: start and end must differ`)
  }
  window('Quiet hours', f.start, f.end)
  for (const d of WEEK) {
    if (f.days[d].mode === 'custom') window(capital(d), f.days[d].start, f.days[d].end)
  }
  const minutes = Number(f.unlockMinutes)
  if (f.unlockMinutes.trim() === '' || !Number.isFinite(minutes) || minutes <= 0) {
    errors.push('Unlock minutes must be a positive number')
  }
  const poll = Number(f.pollMinutes)
  if (f.pollMinutes.trim() === '' || !Number.isFinite(poll) || poll <= 0) {
    errors.push('Sync minutes must be a positive number')
  }
  if (f.useStartPrompt && f.workspacePrompt.trim() === '') {
    errors.push('The workspace start prompt cannot be empty')
  }
  if (f.startPrompt.trim() === '') errors.push('The start prompt cannot be empty')
  if (f.summaryModel.trim() === '') errors.push('The summary model cannot be empty')
  const interval = Number(f.summaryInterval)
  if (f.summaryInterval.trim() === '' || !Number.isInteger(interval) || interval < 1) {
    errors.push('Summary minutes must be a whole number of at least 1')
  }
  const file = f.instructionsFile.trim()
  if (file !== '' && !file.startsWith('/') && !file.startsWith('~')) {
    errors.push('The instructions file must be an absolute path or start with ~')
  }
  return errors
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

/** The config.set patch (the file's snake_case keys); `null` removes an override. */
function patchOf(f: Form): Record<string, unknown> {
  const quiet: Record<string, unknown> = {
    enabled: f.enabled,
    default: [f.start, f.end],
    unlock_minutes: Number(f.unlockMinutes)
  }
  for (const d of WEEKDAYS) {
    const day = f.days[d]
    quiet[d] = day.mode === 'inherit' ? null : day.mode === 'none' ? 'none' : [day.start, day.end]
  }
  return {
    quiet_hours: quiet,
    notifications: {
      chime_on_complete: f.chimeComplete,
      chime_on_needs_input: f.chimeNeedsInput,
      morning_summary: f.morningSummary
    },
    jira: {
      jql: f.jql,
      site: f.site.trim() === '' ? null : f.site.trim(),
      poll_minutes: Number(f.pollMinutes),
      start_prompt: f.startPrompt
    },
    start_prompt: f.useStartPrompt ? f.workspacePrompt : null,
    summaries: f.summaries,
    summary_model: f.summaryModel.trim(),
    summary_interval_minutes: Number(f.summaryInterval),
    instructions_file: f.instructionsFile.trim() === '' ? null : f.instructionsFile.trim(),
    protected_branches: f.protectedBranches
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b !== '')
  }
}

/** Quiet hours, notifications and the pull-request guard, saved to the config file. */
export default function SettingsView(): React.JSX.Element {
  const store = useStore()
  const { config, quiet, connected } = useQue()
  const [form, setForm] = useState<Form | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [saved, setSaved] = useState(false)
  const [instructions, setInstructions] = useState<InstructionsGetResult | null>(null)
  const [draft, setDraft] = useState('')
  const [instructionsSaved, setInstructionsSaved] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)
  const instructionsFile = config?.config.instructionsFile

  useEffect(() => {
    if (config && form === null) setForm(toForm(config.config))
  }, [config, form])

  // The file's text, read again whenever the configured path changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload on a new path only
  useEffect(() => {
    let live = true
    store.loadInstructions().then(
      (r) => {
        if (!live) return
        setInstructions(r)
        setDraft(r.content)
        setInstructionsError(null)
      },
      (err: unknown) => {
        if (live) setInstructionsError(err instanceof Error ? err.message : String(err))
      }
    )
    return () => {
      live = false
    }
  }, [store, instructionsFile])

  if (!form || !config) {
    return (
      <section className="settings" data-testid="settings-view" aria-label="Settings">
        <p className="empty-note">Loading…</p>
      </section>
    )
  }

  const update = (patch: Partial<Form>): void => {
    setForm({ ...form, ...patch })
    setSaved(false)
  }
  const updateDay = (d: Weekday, patch: Partial<DayForm>): void =>
    update({ days: { ...form.days, [d]: { ...form.days[d], ...patch } } })

  const save = async (applyTonight: boolean): Promise<void> => {
    setConfirming(false)
    try {
      await store.saveConfig({ patch: patchOf(form), applyTonight })
      setErrors([])
      setSaved(true)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)])
    }
  }

  const saveInstructions = async (): Promise<void> => {
    try {
      const r = await store.saveInstructions(draft)
      setInstructions(r)
      setInstructionsError(null)
      setInstructionsSaved(true)
    } catch (err) {
      setInstructionsError(err instanceof Error ? err.message : String(err))
    }
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const problems = validate(form)
    setErrors(problems)
    if (problems.length > 0) return
    // Tonight's window in progress would end sooner (or go away): ask first.
    if (quiet?.inQuietHours && quiet.windowEnd) {
      const next = currentWindow(store.now(), quietOf(form))
      if (!next || next.end.getTime() < Date.parse(quiet.windowEnd)) {
        setConfirming(true)
        return
      }
    }
    void save(false)
  }

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
      <form className="settings-body" onSubmit={submit} noValidate>
        <fieldset>
          <legend>Quiet hours</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-quiet-enabled"
              checked={form.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            Quiet hours on
          </label>
          <div className="row">
            <label>
              Start
              <input
                type="time"
                data-testid="settings-quiet-start"
                value={form.start}
                onChange={(e) => update({ start: e.target.value })}
              />
            </label>
            <label>
              End
              <input
                type="time"
                data-testid="settings-quiet-end"
                value={form.end}
                onChange={(e) => update({ end: e.target.value })}
              />
            </label>
            <label>
              Unlock minutes
              <input
                type="number"
                min="1"
                data-testid="settings-unlock-minutes"
                value={form.unlockMinutes}
                onChange={(e) => update({ unlockMinutes: e.target.value })}
              />
            </label>
          </div>
          <table className="days">
            <tbody>
              {WEEK.map((d) => {
                const day = form.days[d]
                return (
                  <tr key={d} data-testid={`settings-day-${d}`}>
                    <th scope="row">{capital(d)}</th>
                    <td>
                      <select
                        aria-label={`${capital(d)} quiet hours`}
                        data-testid={`settings-day-${d}-mode`}
                        value={day.mode}
                        onChange={(e) => updateDay(d, { mode: e.target.value as DayMode })}
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
                            onChange={(e) => updateDay(d, { start: e.target.value })}
                          />
                          <input
                            type="time"
                            aria-label={`${capital(d)} end`}
                            data-testid={`settings-day-${d}-end`}
                            value={day.end}
                            onChange={(e) => updateDay(d, { end: e.target.value })}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </fieldset>
        <fieldset>
          <legend>Notifications</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-chime-complete"
              checked={form.chimeComplete}
              onChange={(e) => update({ chimeComplete: e.target.checked })}
            />
            Chime when a session finishes a turn or a task finishes (work hours)
          </label>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-chime-needs-input"
              checked={form.chimeNeedsInput}
              onChange={(e) => update({ chimeNeedsInput: e.target.checked })}
            />
            Chime when a session needs input (work hours)
          </label>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-morning-summary"
              checked={form.morningSummary}
              onChange={(e) => update({ morningSummary: e.target.checked })}
            />
            Morning summary when quiet hours end
          </label>
        </fieldset>
        <fieldset>
          <legend>Tickets</legend>
          <label>
            Filter
            <input
              data-testid="settings-tickets-jql"
              value={form.jql}
              onChange={(e) => update({ jql: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Site
            <input
              data-testid="settings-jira-site"
              value={form.site}
              onChange={(e) => update({ site: e.target.value })}
              placeholder="team.example.net"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              The tracker host for ticket links; found from the CLI when empty
            </span>
          </label>
          <label>
            Sync every (minutes)
            <input
              type="number"
              min="1"
              data-testid="settings-tickets-poll"
              value={form.pollMinutes}
              onChange={(e) => update({ pollMinutes: e.target.value })}
            />
          </label>
          <label>
            Start prompt
            <textarea
              rows={3}
              data-testid="settings-tickets-prompt"
              value={form.startPrompt}
              onChange={(e) => update({ startPrompt: e.target.value })}
            />
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
        <fieldset>
          <legend>New workspaces</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-start-prompt-enabled"
              checked={form.useStartPrompt}
              onChange={(e) =>
                update({
                  useStartPrompt: e.target.checked,
                  ...(e.target.checked && form.workspacePrompt.trim() === ''
                    ? { workspacePrompt: SUGGESTED_START_PROMPT }
                    : {})
                })
              }
            />
            Use a start prompt instead of the brief
          </label>
          {form.useStartPrompt ? (
            <label>
              Start prompt
              <textarea
                rows={3}
                data-testid="settings-workspace-prompt"
                value={form.workspacePrompt}
                onChange={(e) => update({ workspacePrompt: e.target.value })}
              />
              <span className="hint">
                Sent to Claude instead of the brief; the brief is in .que/brief.md
              </span>
            </label>
          ) : (
            <p className="hint">Claude starts on the brief itself.</p>
          )}
        </fieldset>
        <fieldset>
          <legend>Sidebar titles</legend>
          <label className="check">
            <input
              type="checkbox"
              data-testid="settings-summaries-enabled"
              checked={form.summaries}
              onChange={(e) => update({ summaries: e.target.checked })}
            />
            Summarise what each session is doing in its sidebar title
          </label>
          <label>
            Model
            <input
              data-testid="settings-summary-model"
              value={form.summaryModel}
              onChange={(e) => update({ summaryModel: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            At most every (minutes)
            <input
              type="number"
              min="1"
              step="1"
              data-testid="settings-summary-interval"
              value={form.summaryInterval}
              onChange={(e) => update({ summaryInterval: e.target.value })}
            />
            <span className="hint">
              One short call to the model after a turn ends; renaming a workspace keeps your title
            </span>
          </label>
        </fieldset>
        <fieldset data-testid="settings-instructions">
          <legend>Instructions</legend>
          <label>
            File
            <input
              data-testid="settings-instructions-file"
              value={form.instructionsFile}
              onChange={(e) => update({ instructionsFile: e.target.value })}
              placeholder="~/.config/que/instructions.md"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              Appended to the system prompt of every session started in a workspace. New sessions
              pick up edits; a resumed one after it compacts.
            </span>
          </label>
          <label>
            Content
            <textarea
              rows={8}
              data-testid="settings-instructions-content"
              value={draft}
              disabled={!instructions?.path}
              onChange={(e) => {
                setDraft(e.target.value)
                setInstructionsSaved(false)
              }}
            />
          </label>
          {!instructions?.path && (
            <p className="hint" data-testid="settings-instructions-unset">
              Set a file above and save to edit the instructions here.
            </p>
          )}
          {instructionsError && (
            <p className="form-error" role="alert" data-testid="settings-instructions-error">
              {instructionsError}
            </p>
          )}
          <div className="actions">
            {instructionsSaved && (
              <span className="muted" role="status" data-testid="settings-instructions-saved">
                Saved
              </span>
            )}
            <button
              type="button"
              data-testid="settings-instructions-save"
              disabled={!connected || !instructions?.path}
              onClick={() => void saveInstructions()}
            >
              Save instructions
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Pull requests</legend>
          <label>
            Protected branches
            <input
              data-testid="settings-protected-branches"
              value={form.protectedBranches}
              onChange={(e) => update({ protectedBranches: e.target.value })}
            />
          </label>
          <p className="hint">
            Never pushed to by Create draft PR or by an overnight task, besides each project&apos;s
            default branch. Comma-separated.
          </p>
        </fieldset>
        {errors.length > 0 && (
          <ul className="form-error" role="alert" data-testid="settings-error">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          {saved && (
            <span className="muted" role="status" data-testid="settings-saved">
              Saved
            </span>
          )}
          <button type="submit" data-testid="settings-save" disabled={!connected}>
            Save
          </button>
        </div>
      </form>
      {confirming && (
        <Dialog
          title="Apply tonight?"
          testId="settings-apply-tonight-confirm"
          onClose={() => setConfirming(false)}
        >
          <p className="hint">
            This ends tonight&apos;s quiet hours early. Apply it tonight, or save it for tomorrow?
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              data-testid="settings-apply-tonight-no"
              onClick={() => void save(false)}
            >
              No, from tomorrow
            </button>
            <button
              type="button"
              data-testid="settings-apply-tonight-yes"
              onClick={() => void save(true)}
            >
              Yes, tonight
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
