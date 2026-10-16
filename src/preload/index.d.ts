import type {
  CheckState,
  PrCheck,
  ReviewState,
  PrThreadEntry,
  PrThread,
  ConfigGetResult,
  ConfigSetParams,
  Events,
  InstructionsGetResult,
  InstructionsSetParams,
  ProjectAddParams,
  ProjectRemoveParams,
  QueueOpenParams,
  QueueState,
  QuietLogParams,
  QuietUnlockParams,
  Report,
  TicketsListResult,
  TicketsStartResult,
  TicketsStartParams,
  JiraConfig,
  TicketsSyncState,
  Ticket,
  TicketLevel,
  ReportParams,
  WorkspaceDigest,
  TaskAddParams,
  TaskListParams,
  TaskStatusEvent,
  TermAttachResult,
  TermCreateParams,
  TermInfo,
  TermListParams,
  TermSnapshotResult,
  ReportEntry,
  ReportGroup,
  WorkspaceCreateParams,
  WorkspaceCreatePrParams,
  WorkspaceDiff,
  DiffFile,
  DiffCommit,
  WorkspaceFiles,
  WorkspaceFile,
  WorkspaceCreatePrResult,
  WorkspaceListParams,
  WorkspaceOpenTerminalParams,
  WorkspaceRemoveParams,
  WorkspaceRenameParams,
  WorkspaceStartParams,
  WorkspaceStartResult,
  WorkspaceStatusEvent
} from '../shared/protocol'
import type {
  NotificationsConfig,
  Project,
  PullRequest,
  QuietHoursConfig,
  QuietState,
  QuietUnlock,
  Task,
  TaskState,
  UpdateInfo,
  UserConfig,
  Weekday,
  Workspace,
  WorkspaceStatus
} from '../shared/types'

export type {
  ConfigGetResult,
  ConfigSetParams,
  InstructionsGetResult,
  InstructionsSetParams,
  Events,
  NotificationsConfig,
  Project,
  PullRequest,
  QuietHoursConfig,
  QuietState,
  QuietUnlock,
  UserConfig,
  Weekday,
  QueueState,
  Report,
  TicketsListResult,
  TicketsStartResult,
  TicketsStartParams,
  JiraConfig,
  TicketsSyncState,
  Ticket,
  TicketLevel,
  WorkspaceDigest,
  ReportEntry,
  ReportGroup,
  Task,
  TaskAddParams,
  TaskState,
  TaskStatusEvent,
  TermAttachResult,
  TermCreateParams,
  TermInfo,
  TermSnapshotResult,
  UpdateInfo,
  Workspace,
  WorkspaceDiff,
  DiffFile,
  DiffCommit,
  WorkspaceFiles,
  WorkspaceFile,
  CheckState,
  PrCheck,
  ReviewState,
  PrThreadEntry,
  PrThread,
  WorkspaceStatus,
  WorkspaceStatusEvent
}

/** Mirrors the daemon's term.* protocol methods and events. */
export interface TermApi {
  create(params: TermCreateParams): Promise<{ id: string }>
  list(params?: TermListParams): Promise<TermInfo[]>
  attach(params: { id: string; cols: number; rows: number }): Promise<TermAttachResult>
  detach(params: { id: string }): Promise<{ ok: true }>
  write(params: { id: string; data: string }): void
  resize(params: { id: string; cols: number; rows: number }): Promise<{ ok: true }>
  kill(params: { id: string }): Promise<{ ok: true }>
  snapshot(params: { id: string }): Promise<TermSnapshotResult>
  on<E extends TermEventName>(event: E, cb: (data: Events[E]) => void): () => void
  onDisconnect(cb: () => void): () => void
}

export type TermEventName = 'term.data' | 'term.exit' | 'term.created' | 'term.killed'

export interface AppApi {
  homedir(): Promise<string>
  /** Shows a native folder picker; resolves to the chosen path or null. */
  openFolder(): Promise<string | null>
  /** Opens a folder in a new editor window (`code -n <path>`); fire-and-forget. */
  openInEditor(params: { path: string }): Promise<{ ok: true }>
  /** The menu-bar title. Answers only when the app was launched with QUE_E2E=1. */
  trayTitle(): Promise<string>
  /** A newer release, if the daily update check found one; else null. */
  update(): Promise<UpdateInfo | null>
  /** Fires when the update check finds a newer release after the window opened. */
  onUpdate(cb: (info: UpdateInfo) => void): () => void
  /** Opens the newer release's page in the browser. */
  openUpdate(): Promise<{ ok: true }>
  /** True only when the app was launched with QUE_E2E=1. */
  e2e: boolean
}

export type ProjectEventName = 'project.added' | 'project.removed'

/** Mirrors the daemon's project.* methods and events. */
export interface ProjectApi {
  add(params: ProjectAddParams): Promise<Project>
  list(): Promise<Project[]>
  remove(params: ProjectRemoveParams): Promise<{ ok: true }>
  on<E extends ProjectEventName>(event: E, cb: (data: Events[E]) => void): () => void
}

export type WorkspaceEventName =
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.removed'
  | 'workspace.status'
  | 'workspace.changed'

export type WorkspaceEvents = Pick<Events, WorkspaceEventName>

/** Mirrors the daemon's workspace.* methods and events. */
export interface WorkspaceApi {
  create(params: WorkspaceCreateParams): Promise<Workspace>
  list(params?: WorkspaceListParams): Promise<Workspace[]>
  get(params: { id: string }): Promise<Workspace>
  remove(params: WorkspaceRemoveParams): Promise<{ ok: true }>
  /** Opens a terminal in the worktree with the hooks wrapper on PATH. */
  openTerminal(params: WorkspaceOpenTerminalParams): Promise<{ id: string }>
  /** Commits what is uncommitted as `title`, pushes, and opens a draft PR. */
  createPr(params: WorkspaceCreatePrParams): Promise<WorkspaceCreatePrResult>
  /** Types claude with the start prompt into the workspace's first terminal (opened when none) once setup is done. */
  start(params: WorkspaceStartParams): Promise<WorkspaceStartResult>
  /** Sets the title, and renames the branch when asked and allowed. */
  rename(params: WorkspaceRenameParams): Promise<Workspace>
  /** Whether rename may also rename the branch (it was never pushed). */
  canRenameBranch(params: { id: string }): Promise<{ allowed: boolean }>
  /** What the workspace changed against its base, file by file. Refused in quiet hours. */
  diff(params: { id: string; base?: string; commit?: string }): Promise<WorkspaceDiff>
  /** The pull request's conversation: comments, reviews, line comments. Null without a PR. Refused in quiet hours. */
  prThread(params: { id: string; refresh?: boolean }): Promise<PrThread | null>
  /** Every tracked and untracked file of the worktree, sorted; never the ignored ones. Refused in quiet hours. */
  files(params: { id: string }): Promise<WorkspaceFiles>
  /** One file of the worktree for the file view; the path is relative and must stay inside the worktree. Refused in quiet hours. */
  readFile(params: { id: string; path: string }): Promise<WorkspaceFile>
  /** Ask the daemon to watch this workspace's worktree, so `workspace.changed` names it while this window shows it. */
  watch(params: { id: string }): Promise<{ ok: true }>
  /** Stop asking for watch(); the daemon may still watch it for another window or an attached terminal. */
  unwatch(params: { id: string }): Promise<{ ok: true }>
  on<E extends WorkspaceEventName>(event: E, cb: (data: Events[E]) => void): () => void
}

export type TaskEventName = 'task.created' | 'task.status' | 'task.updated'

/** Mirrors the daemon's task.* methods and events. */
export interface TaskApi {
  add(params: TaskAddParams): Promise<Task>
  list(params?: TaskListParams): Promise<Task[]>
  get(params: { id: string }): Promise<Task>
  stop(params: { id: string }): Promise<Task>
  remove(params: { id: string }): Promise<{ ok: true }>
  on<E extends TaskEventName>(event: E, cb: (data: Events[E]) => void): () => void
}

/** Mirrors the daemon's queue.* methods and the queue.state event. */
export interface QueueApi {
  open(params?: QueueOpenParams): Promise<QueueState>
  close(): Promise<QueueState>
  state(): Promise<QueueState>
  on(event: 'queue.state', cb: (data: QueueState) => void): () => void
}

export interface ReportApi {
  get(params?: ReportParams): Promise<Report>
}

/** Mirrors the daemon's quiet.* methods and the quiet.changed event. */
export interface QuietApi {
  state(): Promise<QuietState>
  /** Unlocks detail for `minutes` (default: the configured unlock length). */
  unlock(params?: QuietUnlockParams): Promise<QuietState>
  /** Ends an unlock early. */
  lock(): Promise<QuietState>
  log(params?: QuietLogParams): Promise<QuietUnlock[]>
  on(event: 'quiet.changed', cb: (data: QuietState) => void): () => void
}

/** Mirrors the daemon's config.* methods and the config.changed event. */
export interface ConfigApi {
  get(): Promise<ConfigGetResult>
  set(params: ConfigSetParams): Promise<ConfigGetResult>
  on(event: 'config.changed', cb: (data: ConfigGetResult) => void): () => void
}

/** Mirrors the daemon's instructions.* methods: the file named by instructions_file. */
export interface InstructionsApi {
  get(): Promise<InstructionsGetResult>
  /** Rejects with code `not_configured` when instructions_file is unset. */
  set(params: InstructionsSetParams): Promise<InstructionsGetResult>
}

/** Mirrors the daemon's tickets.* methods and the tickets.synced event. */
export interface TicketsApi {
  list(): Promise<TicketsListResult>
  sync(): Promise<TicketsListResult>
  start(params: TicketsStartParams): Promise<TicketsStartResult>
  projectFor(params: { key: string }): Promise<{ projectId: string | null }>
  on(event: 'tickets.synced', cb: (data: TicketsListResult) => void): () => void
}

export interface QueApi {
  quiet: QuietApi
  config: ConfigApi
  instructions: InstructionsApi
  term: TermApi
  project: ProjectApi
  workspace: WorkspaceApi
  task: TaskApi
  queue: QueueApi
  report: ReportApi
  tickets: TicketsApi
  app: AppApi
}

/** The two chimes: a session's turn or a task finished, or a session needs input. */
export type ChimeKind = 'complete' | 'needs_input'

export interface QueTestHook {
  /** The focused pane's attached terminal, or null. */
  activeTermId(): string | null
  /** The focused pane's terminal screen. */
  screenText(): string
  /**
   * The panes on screen, in order. `activeTab` is the selected tab (a terminal id or a
   * diff tab id, `view:diff:<path>`); `activeTermId` is null while a diff tab is selected.
   */
  panes(): Array<{
    index: number
    activeTermId: string | null
    activeTab: string | null
    focused: boolean
  }>
  /** The review pane at the right of the main area: open or not, its tab, its width in px. */
  review(): { open: boolean; tab: 'changes' | 'files' | 'pr'; width: number }
  /** The screen of any attached terminal by id ('' when it is not on screen). */
  screenTextOf(termId: string): string
  /** The tray's current title, from the main process. */
  trayTitle(): Promise<string>
  /** The chimes the app would have played, in order (recorded, never played, under e2e). */
  chimes(): ChimeKind[]
}

declare global {
  interface Window {
    que: QueApi
    __que?: QueTestHook
  }
}
