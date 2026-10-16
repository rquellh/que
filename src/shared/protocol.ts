// Wire protocol between the que daemon and its clients (Electron main, CLI).
// Newline-delimited JSON over a unix socket. Requests carry an id; responses
// echo it. Events are server-pushed and carry no id.

import type {
  Project,
  PullRequest,
  QuietState,
  QuietUnlock,
  PrThread,
  Task,
  TaskSource,
  TaskState,
  Ticket,
  TicketsSyncState,
  UserConfig,
  Workspace,
  WorkspaceStatus
} from './types'

export const PROTOCOL_VERSION = 1

// ---- method types ---------------------------------------------------------

export interface PingResult {
  version: string
  pid: number
  startedAt: string
  nodeVersion: string
  /** The daemon's own PATH, as its child processes see it. */
  path: string
}

export interface TermCreateParams {
  cwd?: string
  cols: number
  rows: number
  name?: string
  /** Program to run instead of the login shell. */
  file?: string
  args?: string[]
}

export interface TermInfo {
  id: string
  name: string
  cwd: string
  cols: number
  rows: number
  pid: number
  alive: boolean
  createdAt: string
  /** Set for terminals opened with workspace.openTerminal. */
  workspaceId?: string
}

export interface TermListParams {
  /** Only the terminals of this workspace. */
  workspaceId?: string
}

export interface TermIdParams {
  id: string
}

export interface TermAttachParams {
  id: string
  cols: number
  rows: number
}

export interface TermAttachResult {
  snapshot: string
  cols: number
  rows: number
}

export interface TermWriteParams {
  id: string
  data: string
}

export interface TermResizeParams {
  id: string
  cols: number
  rows: number
}

export interface TermSnapshotResult {
  /** Escape-sequence serialization suitable for writing into an xterm. */
  serialized: string
  /** Plain text of scrollback + screen, one line per row. */
  text: string
}

export interface Ok {
  ok: true
}

export interface ProjectAddParams {
  /** Any path inside the repository; the git toplevel is registered. */
  path: string
  name?: string
}

export interface ProjectRemoveParams {
  id: string
  /** Also remove its unarchived workspaces. */
  force?: boolean
}

export interface WorkspaceCreateParams {
  projectId: string
  name: string
  /** Defaults to origin/<default branch> when that ref exists, else <default branch>. */
  baseRef?: string
  /** Defaults to the slugged name. */
  branch?: string
}

export interface WorkspaceListParams {
  projectId?: string
}

export interface WorkspaceRemoveParams {
  id: string
  deleteBranch?: boolean
}

export interface WorkspaceOpenTerminalParams {
  id: string
  cols: number
  rows: number
}

/** One file a workspace changed against its base, committed or not. */
export interface DiffFile {
  path: string
  /** For a rename, where it came from. */
  from: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
  /** True while still uncommitted in the worktree. */
  dirty: boolean
  /** The unified patch against the base, or null when binary or too large. */
  patch: string | null
}

/** One commit on the branch ahead of its base. */
export interface DiffCommit {
  sha: string
  /** The first seven characters of `sha`. */
  shortSha: string
  subject: string
  author: string
  /** ISO time of the commit. */
  at: string
}

export interface WorkspaceDiff {
  workspaceId: string
  /** The ref the branch is compared against: the caller's `base`, else origin/<default> when it exists. */
  base: string
  head: string
  commitsAhead: number
  /** The commits in `base..HEAD`, newest first, at most 200. */
  commits: DiffCommit[]
  /** Refs worth comparing against: `base` first, then the default branch here and on origin, then the other branches, at most 50. */
  bases: string[]
  /** The sha the files are narrowed to (that commit's own changes), or null for the whole branch and the working tree. */
  commit: string | null
  files: DiffFile[]
  generatedAt: string
}

/** Every tracked and untracked file of a worktree, never the ignored ones. */
export interface WorkspaceFiles {
  workspaceId: string
  /** Relative paths, deduplicated and sorted; at most 20,000. */
  files: string[]
  /** True when the listing was cut at the cap. */
  truncated: boolean
  generatedAt: string
}

/** One file of a worktree, read for the file view. */
export interface WorkspaceFile {
  workspaceId: string
  path: string
  /** The text, or null for a binary file. */
  content: string | null
  /** A NUL byte in the first 8 KB marks a file binary. */
  binary: boolean
  /** Bytes on disk. */
  size: number
  /** True when `content` was cut at MAX_FILE_CHARS (500,000). */
  truncated: boolean
}

export interface WorkspaceCreatePrParams {
  id: string
  /** The commit message for uncommitted changes, and the pull request title. */
  title: string
}

export interface WorkspaceCreatePrResult {
  prUrl: string
}

export interface HookEventParams {
  workspaceId: string
  /** Set when the hook fired inside a headless task run (QUE_TASK_ID). */
  taskId?: string
  /** The hook JSON Claude Code wrote to the hook's stdin. */
  payload: HookEvent
}

export interface TaskAddParams {
  /** Exactly one of projectId (a new workspace per task) or workspaceId (run in it). */
  projectId?: string
  workspaceId?: string
  /** Defaults to the first line of the brief, 80 characters at most. */
  title?: string
  brief: string
  source?: TaskSource
  resumeSessionId?: string
  maxTurns?: number
  maxBudgetUsd?: number
}

export interface TaskListParams {
  state?: TaskState
}

export interface QueueOpenParams {
  /** Overrides the configured concurrency until the queue is closed. */
  concurrency?: number
}

export interface QueueState {
  open: boolean
  concurrency: number
  /** Tasks preparing, running, or finishing. */
  running: number
  queued: number
  paused: number
  /** When the queue was last opened. */
  openedAt: string | null
}

export interface TicketsStartParams {
  key: string
  /** The que project to make the workspace in; omitted means use the learned mapping. */
  projectId?: string
  /** A loose terminal with the brief instead of a workspace. */
  session?: boolean
}

export type TicketsStartResult =
  | { kind: 'workspace'; workspace: Workspace }
  | { kind: 'session'; terminalId: string }
  /** que could not tell which project; the app offers these. */
  | { kind: 'needs_project'; projects: Project[] }

export interface TicketsListResult {
  tickets: Ticket[]
  sync: TicketsSyncState
}

export interface ReportParams {
  /** ISO time; defaults to the last queue.open, else 24 hours ago. */
  since?: string
}

export type ReportGroup = 'done' | 'stuck' | 'failed' | 'stopped' | 'paused' | 'running' | 'queued'

export interface ReportEntry {
  id: string
  title: string
  state: TaskState
  reason: string | null
  workspace: string | null
  workspaceId: string | null
  branch: string | null
  prUrl: string | null
  durationMs: number | null
  turns: number
  costUsd: number
}

/** What one workspace (an interactive session in its worktree) did in the window. */
export interface WorkspaceDigest {
  id: string
  name: string
  project: string
  branch: string
  status: WorkspaceStatus
  statusReason: string | null
  /** The first and last status change in the window; null when nothing happened. */
  firstActivityAt: string | null
  lastActivityAt: string | null
  /** Time spent in `working` within the window. */
  workingMs: number
  /** How many times it asked for input in the window. */
  needsInputCount: number
  /** Since when it has been waiting, if it is waiting now. */
  waitingSince: string | null
  stuckCount: number
  /** Commits on its branch past the base; null when git could not say. */
  commitsAhead: number | null
  pr: PullRequest | null
  sessionId: string | null
}

export interface Report {
  since: string
  generatedAt: string
  groups: Record<ReportGroup, ReportEntry[]>
  /** Workspaces with activity in the window, those needing attention first. */
  workspaces: WorkspaceDigest[]
  totals: {
    tasks: number
    prs: number
    turns: number
    costUsd: number
    durationMs: number
    workspaces: number
    needsInput: number
  }
}

export interface TaskStatusEvent {
  id: string
  state: TaskState
  reason?: string
  at: string
}

export interface WorkspaceStatusEvent {
  id: string
  status: WorkspaceStatus
  reason?: string
  at: string
}

export interface QuietUnlockParams {
  /** Defaults to quiet_hours.unlock_minutes. */
  minutes?: number
  /** Why, for the unlock log. */
  why?: string
}

export interface QuietLogParams {
  /** ISO time; defaults to everything. */
  since?: string
}

export interface ConfigGetResult {
  /** The config file (QUE_CONFIG or ~/.config/que/config.toml). */
  path: string
  config: UserConfig
  /** The file as a TOML table (snake_case keys), the shape config.set patches. */
  raw: Record<string, unknown>
}

export interface ConfigSetParams {
  /** Deep-merged into the file's table; `null` removes a key. */
  patch: Record<string, unknown>
  /** Let a change that shortens or removes tonight's window apply now. */
  applyTonight?: boolean
}

/** The instructions file (instructions_file) appended to every session's system prompt. */
export interface InstructionsGetResult {
  /** The configured path, absolute; absent when instructions_file is unset. */
  path?: string
  exists: boolean
  /** The file's text; '' when it does not exist. */
  content: string
}

export interface InstructionsSetParams {
  content: string
}

/** Maps each method name to its params and result types. */
export interface Methods {
  'daemon.ping': { params: Record<string, never> | undefined; result: PingResult }
  'daemon.shutdown': { params: Record<string, never> | undefined; result: Ok }
  'term.create': { params: TermCreateParams; result: { id: string } }
  'term.list': { params: TermListParams | undefined; result: TermInfo[] }
  'term.attach': { params: TermAttachParams; result: TermAttachResult }
  'term.detach': { params: TermIdParams; result: Ok }
  'term.write': { params: TermWriteParams; result: Ok }
  'term.resize': { params: TermResizeParams; result: Ok }
  'term.kill': { params: TermIdParams; result: Ok }
  'term.snapshot': { params: TermIdParams; result: TermSnapshotResult }
  'project.add': { params: ProjectAddParams; result: Project }
  'project.list': { params: Record<string, never> | undefined; result: Project[] }
  'project.remove': { params: ProjectRemoveParams; result: Ok }
  'workspace.create': { params: WorkspaceCreateParams; result: Workspace }
  'workspace.list': { params: WorkspaceListParams | undefined; result: Workspace[] }
  'workspace.get': { params: { id: string }; result: Workspace }
  'workspace.remove': { params: WorkspaceRemoveParams; result: Ok }
  'workspace.openTerminal': { params: WorkspaceOpenTerminalParams; result: { id: string } }
  'workspace.createPr': { params: WorkspaceCreatePrParams; result: WorkspaceCreatePrResult }
  /** What the workspace changed against its base: committed and uncommitted, file by file. */
  'workspace.diff': {
    params: { id: string; base?: string; commit?: string }
    result: WorkspaceDiff
  }
  /** The pull request's conversation (comments, reviews, line comments); null without a pull request. */
  'workspace.prThread': { params: { id: string; refresh?: boolean }; result: PrThread | null }
  'workspace.files': { params: { id: string }; result: WorkspaceFiles }
  'workspace.readFile': { params: { id: string; path: string }; result: WorkspaceFile }
  /** Watch this workspace's worktree for this connection (`workspace.changed`). */
  'workspace.watch': { params: { id: string }; result: Ok }
  'workspace.unwatch': { params: { id: string }; result: Ok }
  'hook.event': { params: HookEventParams; result: Ok }
  'task.add': { params: TaskAddParams; result: Task }
  'task.list': { params: TaskListParams | undefined; result: Task[] }
  'task.get': { params: { id: string }; result: Task }
  'task.stop': { params: { id: string }; result: Task }
  'task.remove': { params: { id: string }; result: Ok }
  'queue.open': { params: QueueOpenParams | undefined; result: QueueState }
  'queue.close': { params: Record<string, never> | undefined; result: QueueState }
  'queue.state': { params: Record<string, never> | undefined; result: QueueState }
  'report.get': { params: ReportParams | undefined; result: Report }
  'quiet.state': { params: Record<string, never> | undefined; result: QuietState }
  'quiet.unlock': { params: QuietUnlockParams | undefined; result: QuietState }
  'quiet.lock': { params: Record<string, never> | undefined; result: QuietState }
  'quiet.log': { params: QuietLogParams | undefined; result: QuietUnlock[] }
  'config.get': { params: Record<string, never> | undefined; result: ConfigGetResult }
  'config.set': { params: ConfigSetParams; result: ConfigGetResult }
  'instructions.get': { params: Record<string, never> | undefined; result: InstructionsGetResult }
  /** Writes the instructions file; `not_configured` when instructions_file is unset. */
  'instructions.set': { params: InstructionsSetParams; result: InstructionsGetResult }
  'tickets.list': { params: Record<string, never> | undefined; result: TicketsListResult }
  'tickets.sync': { params: Record<string, never> | undefined; result: TicketsListResult }
  'tickets.start': { params: TicketsStartParams; result: TicketsStartResult }
  'tickets.projectFor': { params: { key: string }; result: { projectId: string | null } }
}

/**
 * Refused with `quiet_hours` while quiet hours are on and not unlocked: every
 * way to see a terminal, its output, or a report, or to start new work.
 */
export const QUIET_REFUSED_METHODS = [
  'term.attach',
  'term.snapshot',
  'term.create',
  'workspace.openTerminal',
  'workspace.createPr',
  'workspace.diff',
  'workspace.prThread',
  'workspace.files',
  'workspace.readFile',
  'report.get',
  'task.add',
  'queue.open',
  'tickets.start'
] as const satisfies readonly MethodName[]

export type MethodName = keyof Methods
export type ParamsOf<M extends MethodName> = Methods[M]['params']
export type ResultOf<M extends MethodName> = Methods[M]['result']

// ---- event types ----------------------------------------------------------

export interface Events {
  'term.data': { id: string; data: string }
  'term.exit': { id: string; exitCode: number; signal?: number }
  'term.created': { id: string }
  'term.killed': { id: string }
  'workspace.created': Workspace
  /** Its pull request (prUrl) changed. */
  'workspace.updated': Workspace
  'workspace.removed': { id: string }
  'workspace.status': WorkspaceStatusEvent
  /** Its worktree changed on disk (a write, a commit): the daemon computes nothing until asked. */
  'workspace.changed': { id: string }
  'task.created': Task
  'task.status': TaskStatusEvent
  /** Cost, turns, session, branch, or PR changed. */
  'task.updated': Task
  'queue.state': QueueState
  'project.added': Project
  'project.removed': { id: string }
  'quiet.changed': QuietState
  /** Once, when a quiet window ends and notifications.morning_summary is on. */
  'quiet.morningSummary': { report: Report }
  'config.changed': ConfigGetResult
  /** After every ticket sync, and when a ticket's workspace changes. */
  'tickets.synced': TicketsListResult
}

export type EventName = keyof Events
export type EventData<E extends EventName> = Events[E]

// ---- envelopes ------------------------------------------------------------

export interface Request {
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface ResponseError {
  code: string
  message: string
}

export type Response = { id: number; result: unknown } | { id: number; error: ResponseError }

export interface EventMessage {
  event: string
  data: Record<string, unknown>
}

export type ServerMessage = Response | EventMessage

export const ErrorCodes = {
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  NotFound: 'not_found',
  Conflict: 'conflict',
  Internal: 'internal',
  QuietHours: 'quiet_hours',
  /** The method needs a config key that is not set (instructions.set without instructions_file). */
  NotConfigured: 'not_configured'
} as const

// ---- framing --------------------------------------------------------------

export function encode(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

/**
 * Splits a byte stream into complete lines. Feed it chunks in arrival order;
 * a partial trailing line is kept until its newline arrives.
 */
export class LineSplitter {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    return parts.filter((l) => l.trim().length > 0)
  }

  /** Bytes received after the last newline. */
  get pending(): string {
    return this.buf
  }
}

/** Decodes buffered chunks into parsed JSON messages; bad lines go to onError. */
export class MessageDecoder<T = unknown> {
  private lines = new LineSplitter()
  private decoder = new TextDecoder('utf-8')

  constructor(private onError?: (line: string, err: unknown) => void) {}

  push(chunk: string | Uint8Array): T[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const out: T[] = []
    for (const line of this.lines.push(text)) {
      try {
        out.push(JSON.parse(line) as T)
      } catch (err) {
        this.onError?.(line, err)
      }
    }
    return out
  }
}

export function isEvent(msg: ServerMessage): msg is EventMessage {
  return typeof (msg as EventMessage).event === 'string'
}

// ---- Claude Code payloads -------------------------------------------------
// Shapes que receives from Claude Code: hook JSON on stdin and the final
// stream-json `result` line of a headless run.

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
  'PreCompact',
  'SubagentStart',
  'SubagentStop'
] as const

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

export interface HookEvent {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  transcript_path: string
  permission_mode?: string
  /** Set when the event comes from a subagent rather than the main session. */
  agent_id?: string
  agent_type?: string
  /** SessionStart */
  source?: 'startup' | 'resume' | 'clear' | 'compact'
  /** UserPromptSubmit */
  prompt?: string
  prompt_id?: string
  /** PreToolUse / PostToolUse */
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  tool_use_id?: string
  /** Notification */
  notification_type?: string
  message?: string
  title?: string
  /** Stop */
  last_assistant_message?: string
  stop_hook_active?: boolean
  /** StopFailure */
  error?: string
  error_details?: string
  /** SessionEnd */
  reason?: string
}

// A type alias (not an interface) so it is assignable to a generic stream message.
export type StreamResult = {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd'
  is_error: boolean
  num_turns: number
  total_cost_usd: number
  duration_ms: number
  session_id: string
  stop_reason: string | null
  result?: string
  /** Set on error_during_execution when the session could not start (e.g. worktree refused). */
  startup_failure_reason?: string
}
