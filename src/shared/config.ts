// User config (~/.config/que/config.toml or $QUE_CONFIG) and the per-repo
// que.toml. Parsing is pure; loadConfig()/loadRepoConfig() only add file I/O.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  type JiraConfig,
  WEEKDAYS,
  type DayWindow,
  type NotificationsConfig,
  type PermissionMode,
  type QuietHoursConfig,
  type QuietWindow,
  type UserConfig,
  type Weekday
} from './types'

export type { PermissionMode, RepoEntry, UserConfig } from './types'

/** Claude Code permission modes que may pass with --permission-mode. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto'
] as const satisfies readonly PermissionMode[]

/**
 * The permission mode for a session: que.toml, else the user's default, else
 * acceptEdits. bypassPermissions needs both the repo and the user to opt in.
 */
export function resolvePermissionMode(
  repo: { permissionMode?: PermissionMode },
  config: Pick<UserConfig, 'defaultPermissionMode' | 'allowBypassPermissions'>
): { mode: PermissionMode; warning: string | null } {
  const wanted = repo.permissionMode ?? config.defaultPermissionMode ?? 'acceptEdits'
  if (wanted !== 'bypassPermissions') return { mode: wanted, warning: null }
  if (repo.permissionMode === 'bypassPermissions' && config.allowBypassPermissions) {
    return { mode: wanted, warning: null }
  }
  return {
    mode: 'acceptEdits',
    warning:
      'bypassPermissions needs permission_mode in que.toml and allow_bypass_permissions = true in the que config; running with acceptEdits'
  }
}

export interface ConfigError {
  /** Dotted key path, or '' for a syntax error. */
  key: string
  message: string
}

export type ConfigResult<T> = { ok: true; config: T } | { ok: false; errors: ConfigError[] }

export interface ConfigEnv {
  /** The resolved QUE_HOME. */
  queHome: string
}

export function defaultConfig(env: ConfigEnv): UserConfig {
  return {
    worktreeRoot: join(env.queHome, 'worktrees'),
    stallTimeoutMinutes: 5,
    statusPollSeconds: 10,
    prPollSeconds: 60,
    repos: {},
    concurrency: 2,
    maxTurns: 50,
    maxBudgetUsd: 5,
    allowBypassPermissions: false,
    protectedBranches: ['main', 'master', 'release'],
    quietHours: defaultQuietHours(),
    notifications: defaultNotifications(),
    jira: defaultJira(),
    // Empty: claude starts on the brief itself.
    startPrompt: ''
  }
}

export function defaultQuietHours(): QuietHoursConfig {
  return { enabled: true, default: { start: '19:00', end: '07:00' }, days: {}, unlockMinutes: 20 }
}

export const DEFAULT_JQL =
  'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
export const DEFAULT_START_PROMPT =
  'Read .que/ticket.md, the ticket this workspace is for. Restate the goal in a sentence, look at the code it touches, and propose a plan before changing anything.'

export function defaultJira(): JiraConfig {
  return {
    jql: DEFAULT_JQL,
    pollMinutes: 5,
    site: null,
    startPrompt: DEFAULT_START_PROMPT,
    projects: {}
  }
}

export function defaultNotifications(): NotificationsConfig {
  return { chimeOnComplete: true, chimeOnNeedsInput: false, morningSummary: false }
}

function parseTable(text: string): ConfigResult<Record<string, unknown>> {
  try {
    return { ok: true, config: parseToml(text) as Record<string, unknown> }
  } catch (err) {
    return { ok: false, errors: [{ key: '', message: (err as Error).message.split('\n')[0] }] }
  }
}

function positive(
  table: Record<string, unknown>,
  key: string,
  errors: ConfigError[]
): number | undefined {
  const v = table[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    errors.push({ key, message: 'must be a positive number' })
    return undefined
  }
  return v
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
  prefix: string,
  errors: ConfigError[]
): string | undefined {
  const v = table[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) {
    errors.push({ key: `${prefix}${key}`, message: 'must be a non-empty string' })
    return undefined
  }
  return v
}

function optionalBool(
  table: Record<string, unknown>,
  key: string,
  errors: ConfigError[]
): boolean | undefined {
  const v = table[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    errors.push({ key, message: 'must be true or false' })
    return undefined
  }
  return v
}

function stringList(
  table: Record<string, unknown>,
  key: string,
  errors: ConfigError[]
): string[] | undefined {
  const v = table[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    errors.push({ key, message: 'must be a list of strings' })
    return undefined
  }
  return v
}

function permissionMode(
  table: Record<string, unknown>,
  key: string,
  errors: ConfigError[]
): PermissionMode | undefined {
  const v = table[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(v)) {
    errors.push({ key, message: `must be one of ${PERMISSION_MODES.join(', ')}` })
    return undefined
  }
  return v as PermissionMode
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** `["19:00", "07:00"]` → a window; reports bad times and start == end. */
function quietWindow(v: unknown, key: string, errors: ConfigError[]): QuietWindow | undefined {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string')) {
    errors.push({ key, message: 'must be ["HH:MM", "HH:MM"] (start, end)' })
    return undefined
  }
  const [start, end] = v as string[]
  const bad = [start, end].filter((t) => !HHMM.test(t))
  if (bad.length > 0) {
    errors.push({ key, message: `${bad.join(', ')} is not a 24-hour HH:MM time` })
    return undefined
  }
  if (start === end) {
    errors.push({ key, message: 'start and end must differ' })
    return undefined
  }
  return { start, end }
}

const QUIET_KEYS = new Set<string>(['enabled', 'default', 'unlock_minutes', ...WEEKDAYS])

function parseQuietHours(v: unknown, errors: ConfigError[]): QuietHoursConfig {
  const q = defaultQuietHours()
  if (v === undefined) return q
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push({ key: 'quiet_hours', message: 'must be a table' })
    return q
  }
  const t = v as Record<string, unknown>
  const sub: ConfigError[] = []
  for (const k of Object.keys(t)) {
    if (!QUIET_KEYS.has(k)) sub.push({ key: k, message: 'is not a quiet_hours key' })
  }
  q.enabled = optionalBool(t, 'enabled', sub) ?? q.enabled
  if (t.default !== undefined) q.default = quietWindow(t.default, 'default', sub) ?? q.default
  q.unlockMinutes = positive(t, 'unlock_minutes', sub) ?? q.unlockMinutes
  for (const day of WEEKDAYS) {
    const d = t[day]
    if (d === undefined) continue
    if (d === 'none') q.days[day] = 'none'
    else {
      const w = quietWindow(d, day, sub)
      if (w) q.days[day] = w
    }
  }
  for (const e of sub) errors.push({ key: `quiet_hours.${e.key}`, message: e.message })
  return q
}

function parseJira(v: unknown, errors: ConfigError[]): JiraConfig {
  const j = defaultJira()
  if (v === undefined) return j
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push({ key: 'jira', message: 'must be a table' })
    return j
  }
  const t = v as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const x = t[key]
    if (x === undefined) return undefined
    if (typeof x !== 'string' || x.trim() === '') {
      errors.push({ key: `jira.${key}`, message: 'must be a non-empty string' })
      return undefined
    }
    return x
  }
  j.jql = text('jql') ?? j.jql
  j.startPrompt = text('start_prompt') ?? j.startPrompt
  const site = text('site')
  if (site !== undefined) {
    const host = site
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    if (host) j.site = host
    else errors.push({ key: 'jira.site', message: 'must be a host like team.example.net' })
  }
  const minutes = t.poll_minutes
  if (minutes !== undefined) {
    if (typeof minutes !== 'number' || !(minutes > 0)) {
      errors.push({ key: 'jira.poll_minutes', message: 'must be a positive number' })
    } else j.pollMinutes = minutes
  }
  const projects = t.projects
  if (projects !== undefined) {
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
      errors.push({ key: 'jira.projects', message: 'must be a table of tracker key = que project' })
    } else {
      for (const [k, name] of Object.entries(projects as Record<string, unknown>)) {
        if (typeof name !== 'string' || name.trim() === '') {
          errors.push({ key: `jira.projects.${k}`, message: 'must be a que project name' })
        } else j.projects[k] = name
      }
    }
  }
  return j
}

function parseNotifications(v: unknown, errors: ConfigError[]): NotificationsConfig {
  const n = defaultNotifications()
  if (v === undefined) return n
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push({ key: 'notifications', message: 'must be a table' })
    return n
  }
  const t = v as Record<string, unknown>
  const sub: ConfigError[] = []
  n.chimeOnComplete = optionalBool(t, 'chime_on_complete', sub) ?? n.chimeOnComplete
  n.chimeOnNeedsInput = optionalBool(t, 'chime_on_needs_input', sub) ?? n.chimeOnNeedsInput
  n.morningSummary = optionalBool(t, 'morning_summary', sub) ?? n.morningSummary
  for (const e of sub) errors.push({ key: `notifications.${e.key}`, message: e.message })
  return n
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(os.homedir(), p.slice(1)) : p
}

/** Parses config.toml text; unknown keys are ignored, bad values reported per key. */
export function parseConfig(text: string, env: ConfigEnv): ConfigResult<UserConfig> {
  const parsed = parseTable(text)
  if (!parsed.ok) return parsed
  const t = parsed.config
  const errors: ConfigError[] = []
  const config = defaultConfig(env)

  const root = optionalString(t, 'worktree_root', '', errors)
  if (root) config.worktreeRoot = expandHome(root)
  config.stallTimeoutMinutes =
    positive(t, 'stall_timeout_minutes', errors) ?? config.stallTimeoutMinutes
  config.statusPollSeconds = positive(t, 'status_poll_seconds', errors) ?? config.statusPollSeconds
  config.prPollSeconds = positive(t, 'pr_poll_seconds', errors) ?? config.prPollSeconds
  const concurrency = positive(t, 'concurrency', errors)
  if (concurrency !== undefined && !Number.isInteger(concurrency)) {
    errors.push({ key: 'concurrency', message: 'must be a whole number' })
  } else if (concurrency !== undefined) {
    config.concurrency = concurrency
  }
  config.maxTurns = positive(t, 'max_turns', errors) ?? config.maxTurns
  config.maxBudgetUsd = positive(t, 'max_budget_usd', errors) ?? config.maxBudgetUsd
  config.defaultPermissionMode = permissionMode(t, 'default_permission_mode', errors)
  config.allowBypassPermissions =
    optionalBool(t, 'allow_bypass_permissions', errors) ?? config.allowBypassPermissions
  config.protectedBranches = stringList(t, 'protected_branches', errors) ?? config.protectedBranches
  const instructions = t.instructions_file
  if (instructions !== undefined) {
    if (typeof instructions !== 'string') {
      errors.push({ key: 'instructions_file', message: 'must be a path' })
    } else if (instructions.trim() !== '') {
      config.instructionsFile = expandHome(instructions.trim())
    }
  }
  config.quietHours = parseQuietHours(t.quiet_hours, errors)
  config.notifications = parseNotifications(t.notifications, errors)
  config.jira = parseJira(t.jira, errors)
  const startPrompt = t.start_prompt
  if (startPrompt !== undefined) {
    // A blank prompt is off, like an unset one.
    if (typeof startPrompt !== 'string') {
      errors.push({ key: 'start_prompt', message: 'must be a string' })
    } else config.startPrompt = startPrompt.trim() === '' ? '' : startPrompt
  }

  if (t.repos !== undefined) {
    if (typeof t.repos !== 'object' || t.repos === null || Array.isArray(t.repos)) {
      errors.push({ key: 'repos', message: 'must be a table' })
    } else {
      for (const [name, entry] of Object.entries(t.repos as Record<string, unknown>)) {
        const prefix = `repos.${name}.`
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          errors.push({ key: `repos.${name}`, message: 'must be a table' })
          continue
        }
        const e = entry as Record<string, unknown>
        const path = optionalString(e, 'path', prefix, errors)
        if (e.path === undefined) errors.push({ key: `${prefix}path`, message: 'is required' })
        const defaultBranch = optionalString(e, 'default_branch', prefix, errors)
        if (path) config.repos[name] = { path: expandHome(path), defaultBranch }
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config }
}

export function configPath(): string {
  return process.env.QUE_CONFIG || join(os.homedir(), '.config', 'que', 'config.toml')
}

/** Reads and parses the user config; a missing file is the defaults. */
export function loadConfig(env: ConfigEnv, path: string = configPath()): ConfigResult<UserConfig> {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, config: defaultConfig(env) }
    }
    return { ok: false, errors: [{ key: '', message: (err as Error).message }] }
  }
  return parseConfig(text, env)
}

export function formatConfigErrors(errors: ConfigError[]): string {
  return errors.map((e) => (e.key ? `${e.key}: ${e.message}` : e.message)).join('; ')
}

/** The config file as a plain TOML table; a missing file is an empty table. */
export function readRawConfig(path: string = configPath()): ConfigResult<Record<string, unknown>> {
  let text: string
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, config: {} }
    return { ok: false, errors: [{ key: '', message: (err as Error).message }] }
  }
  return parseTable(text)
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)
}

/**
 * Deep-merges a patch into a TOML table without touching the input: tables
 * merge key by key, anything else replaces, and `null` removes the key.
 */
export function mergeConfigPatch(
  raw: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else if (isTable(v) && isTable(out[k])) out[k] = mergeConfigPatch(out[k], v)
    else if (isTable(v)) out[k] = mergeConfigPatch({}, v)
    else out[k] = v
  }
  return out
}

/** TOML text for a table. Comments in the original file are not preserved. */
export function stringifyConfig(raw: Record<string, unknown>): string {
  return stringifyToml(raw)
}

/** Keys whose value is a list even when `que config set` is given one item. */
const LIST_KEYS = new Set(['protected_branches', 'quiet_hours.default'])

/**
 * `que config set key=value`: a dotted key into a nested patch, the value read
 * as a boolean, a number, `null` (remove), a comma list, or else a string.
 */
export function parseConfigAssignment(arg: string): Record<string, unknown> {
  const eq = arg.indexOf('=')
  if (eq <= 0) throw new Error(`expected key=value, got ${JSON.stringify(arg)}`)
  const key = arg.slice(0, eq).trim()
  const text = arg.slice(eq + 1).trim()
  const parts = key.split('.')
  if (parts.some((p) => p === '')) throw new Error(`invalid key ${JSON.stringify(key)}`)
  const scalar = (s: string): unknown => {
    if (s === 'true') return true
    if (s === 'false') return false
    if (s !== '' && Number.isFinite(Number(s))) return Number(s)
    return s
  }
  let value: unknown
  if (text === 'null') value = null
  else if (text.includes(',')) value = text.split(',').map((x) => x.trim())
  else if (LIST_KEYS.has(key)) value = [text]
  else value = scalar(text)
  const patch: Record<string, unknown> = {}
  let at = patch
  for (const p of parts.slice(0, -1)) {
    const next: Record<string, unknown> = {}
    at[p] = next
    at = next
  }
  at[parts[parts.length - 1]] = value
  return patch
}

/** A one-line summary of the quiet-hours config for `que doctor` and `que quiet status`. */
export function describeQuietHours(q: QuietHoursConfig): string {
  if (!q.enabled) return 'off'
  const days = (Object.entries(q.days) as Array<[Weekday, DayWindow]>).map(([d, w]) =>
    w === 'none' ? `${d} none` : `${d} ${w.start}-${w.end}`
  )
  return [
    `${q.default.start}-${q.default.end}`,
    ...(days.length > 0 ? [`overrides: ${days.join(', ')}`] : []),
    `unlock ${q.unlockMinutes} min`
  ].join(' · ')
}

// ---- que.toml ---------------------------------------------------------------

export interface RepoConfig {
  /** Shell command run inside a new worktree. */
  setup?: string
  /** Shell command run inside a worktree before it is removed. */
  teardown?: string
  defaultBranch?: string
  /** Gitignored paths copied from the main checkout into new worktrees. */
  worktreeInclude: string[]
  /** Permission mode for headless task runs. */
  permissionMode?: PermissionMode
  /** Extra instructions appended to every task brief for this repo. */
  instructions?: string
  /** The repo's test command, which a task must make pass. */
  test?: string
  /** Passed to claude as --allowedTools. */
  allowedTools: string[]
}

/** Parses a .worktreeinclude file: one path per line, `#` comments, blanks skipped. */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

export function parseRepoConfig(text: string, includeFile = ''): ConfigResult<RepoConfig> {
  const parsed = parseTable(text)
  if (!parsed.ok) return parsed
  const t = parsed.config
  const errors: ConfigError[] = []
  const config: RepoConfig = {
    setup: optionalString(t, 'setup', '', errors),
    teardown: optionalString(t, 'teardown', '', errors),
    defaultBranch: optionalString(t, 'default_branch', '', errors),
    worktreeInclude: [],
    permissionMode: permissionMode(t, 'permission_mode', errors),
    instructions: optionalString(t, 'instructions', '', errors),
    test: optionalString(t, 'test', '', errors),
    allowedTools: stringList(t, 'allowed_tools', errors) ?? []
  }
  const inc = t.worktree_include
  if (inc !== undefined) {
    if (!Array.isArray(inc) || !inc.every((x) => typeof x === 'string')) {
      errors.push({ key: 'worktree_include', message: 'must be a list of strings' })
    } else {
      config.worktreeInclude.push(...inc)
    }
  }
  for (const p of parseWorktreeInclude(includeFile)) {
    if (!config.worktreeInclude.includes(p)) config.worktreeInclude.push(p)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config }
}

function readOptional(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Reads `<repo>/que.toml` and `<repo>/.worktreeinclude`; both optional. */
export function loadRepoConfig(repo: string): ConfigResult<RepoConfig> {
  return parseRepoConfig(
    readOptional(join(repo, 'que.toml')),
    readOptional(join(repo, '.worktreeinclude'))
  )
}
