// Quiet hours and config: `que unlock`, `que lock`, `que quiet status`,
// `que config get|set`.
import type { Command } from 'commander'
import { formatCountdown, hhmm } from '../daemon/quiet-hours'
import { describeQuietHours, parseConfigAssignment } from '../shared/config'
import type { QuietState } from '../shared/types'
import { CliError, withClient } from './common'

/** One line about quiet hours, for `que quiet status` and `que status`. */
export function describeQuietState(q: QuietState, now = Date.now()): string {
  if (!q.enabled) return 'quiet hours off'
  if (!q.inQuietHours) {
    return q.nextBoundary
      ? `work hours · quiet hours start ${hhmm(Date.parse(q.nextBoundary))}`
      : 'work hours'
  }
  const until = q.windowEnd ? hhmm(Date.parse(q.windowEnd)) : '?'
  if (q.unlockedUntil) {
    return `quiet hours until ${until} · unlocked, ${formatCountdown(Date.parse(q.unlockedUntil) - now)} left`
  }
  return `quiet hours until ${until}`
}

/** Combines two patches, keeping `null` (a removal) as a value. */
function combine(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    const table = (x: unknown): x is Record<string, unknown> =>
      typeof x === 'object' && x !== null && !Array.isArray(x)
    out[k] = table(prev) && table(v) ? combine(prev, v) : v
  }
  return out
}

function positiveMinutes(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new CliError('minutes must be a positive number')
  return n
}

export function registerQuietCommands(program: Command): void {
  program
    .command('unlock [minutes]')
    .description(
      'unlock detail during quiet hours for a while (default: quiet_hours.unlock_minutes)'
    )
    .option('--why <text>', 'why, for the unlock log')
    .option('--json', 'print the quiet state as JSON')
    .action((minutes: string | undefined, opts: { why?: string; json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.unlock', {
          ...(minutes === undefined ? {} : { minutes: positiveMinutes(minutes) }),
          ...(opts.why ? { why: opts.why } : {})
        })
        if (opts.json) console.log(JSON.stringify(q, null, 2))
        else if (!q.inQuietHours) console.log('not in quiet hours; nothing to unlock')
        else console.log(describeQuietState(q))
      })
    )

  program
    .command('lock')
    .description('end an unlock early')
    .option('--json', 'print the quiet state as JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.lock')
        if (opts.json) console.log(JSON.stringify(q, null, 2))
        else console.log(describeQuietState(q))
      })
    )

  const quiet = program.command('quiet').description('quiet hours')
  quiet
    .command('status')
    .description('whether quiet hours are on, until when, and any unlock')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const q = await c.request('quiet.state')
        if (opts.json) console.log(JSON.stringify(q, null, 2))
        else console.log(describeQuietState(q))
      })
    )

  const config = program.command('config').description('the user config')
  config
    .command('get')
    .description('print the config file path and the parsed config')
    .option('--json', 'print JSON')
    .action((opts: { json?: boolean }) =>
      withClient(async (c) => {
        const r = await c.request('config.get')
        if (opts.json) return console.log(JSON.stringify(r, null, 2))
        const cfg = r.config
        console.log(`config ${r.path}`)
        console.log(`quiet hours     ${describeQuietHours(cfg.quietHours)}`)
        console.log(
          `notifications   chime on complete ${cfg.notifications.chimeOnComplete} · chime on needs input ${cfg.notifications.chimeOnNeedsInput} · morning summary ${cfg.notifications.morningSummary}`
        )
        console.log(`concurrency     ${cfg.concurrency}`)
        console.log(`max turns       ${cfg.maxTurns}`)
        console.log(`max budget      $${cfg.maxBudgetUsd}`)
        console.log(`protected       ${cfg.protectedBranches.join(', ')}`)
        console.log(`instructions    ${cfg.instructionsFile ?? 'none'}`)
      })
    )
  config
    .command('set <assignments...>')
    .description('set keys (dotted, e.g. quiet_hours.default=19:00,07:00) and reload the daemon')
    .option('--apply-tonight', "let a change that shortens tonight's quiet hours apply now")
    .option('--json', 'print the result as JSON')
    .action((assignments: string[], opts: { applyTonight?: boolean; json?: boolean }) =>
      withClient(async (c) => {
        let patch: Record<string, unknown> = {}
        for (const a of assignments) {
          try {
            patch = combine(patch, parseConfigAssignment(a))
          } catch (err) {
            throw new CliError((err as Error).message)
          }
        }
        const r = await c.request('config.set', { patch, applyTonight: opts.applyTonight === true })
        if (opts.json) console.log(JSON.stringify(r, null, 2))
        else console.log(`updated ${r.path}`)
      })
    )
}
