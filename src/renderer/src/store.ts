// The renderer's single store: loads projects, workspaces, terminals, and
// tasks at boot, applies every daemon event, and holds the UI's selection. Components read it with useQue() and call its actions; nothing
// else talks to window.que except Terminal.tsx's attach/detach.
import { createContext, useContext, useSyncExternalStore } from 'react'
import type {
  ConfigGetResult,
  ConfigSetParams,
  InstructionsGetResult,
  PrThread,
  Project,
  QueApi,
  QuietState,
  QuietUnlock,
  Report,
  Task,
  TermInfo,
  Ticket,
  TicketsSyncState,
  UpdateInfo,
  Workspace,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceFiles
} from '../../preload/index.d'
import type { SidebarSort } from './sidebar-order'
import {
  clampRatio,
  isRemembered,
  NO_SPLIT,
  type PaneLayout,
  parseLayout,
  RATIO_DEFAULT,
  reconcileLayout,
  diffId,
  fileId,
  filePathOf,
  isViewId
} from './layout'
import { buildTree, newlyChanged } from './files'
import { isLiveTask, latestTasks } from './format'
import { chime, shouldChime } from './sound'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** The loose terminals (not in any workspace) share this key. */
export const SCRATCH = ''

export interface TermTab {
  id: string
  name: string
  cwd: string
  alive: boolean
  /** Was already running in the daemon when this app instance launched. */
  reattached: boolean
  /** Workspace id, or SCRATCH. */
  key: string
  createdAt: string
}

export {
  diffId,
  diffPathOf,
  fileId,
  filePathOf,
  isViewId,
  RATIO_DEFAULT,
  RATIO_MAX,
  RATIO_MIN
} from './layout'
export type { PaneLayout } from './layout'

const LAYOUT_PREFIX = 'que.layout.'

/** The review pane's tabs. */
export type ReviewTab = 'changes' | 'files' | 'pr'

const REVIEW_TABS: readonly ReviewTab[] = ['changes', 'files', 'pr']

/** The review pane at the right of the main area; one for the app, remembered. */
export interface ReviewState {
  open: boolean
  tab: ReviewTab
  width: number
}

export const REVIEW_MIN = 240
export const REVIEW_MAX = 520
export const REVIEW_DEFAULT = 320
const REVIEW_KEY = 'que.review'

export function clampReviewWidth(w: number): number {
  const n = Number.isFinite(w) ? w : REVIEW_DEFAULT
  return Math.min(REVIEW_MAX, Math.max(REVIEW_MIN, Math.round(n)))
}

/** The remembered review pane, or the defaults (closed, on Changes, 320px) for anything unreadable. */
function loadReview(): ReviewState {
  const fallback: ReviewState = { open: false, tab: 'changes', width: REVIEW_DEFAULT }
  try {
    const raw = localStorage.getItem(REVIEW_KEY)
    if (!raw) return fallback
    const v = JSON.parse(raw) as Partial<ReviewState> | null
    if (!v || typeof v !== 'object') return fallback
    return {
      open: v.open === true,
      tab: REVIEW_TABS.find((t) => t === v.tab) ?? 'changes',
      width: typeof v.width === 'number' ? clampReviewWidth(v.width) : REVIEW_DEFAULT
    }
  } catch {
    return fallback
  }
}

/** What a workspace's diff is narrowed to: the ref it compares against, and one commit. Null: the daemon's choice, every commit. */
export interface DiffScope {
  base: string | null
  commit: string | null
}

const NO_SCOPE: DiffScope = { base: null, commit: null }
const DIFF_BASES_KEY = 'que.diffBases'

/** The remembered base per workspace id; anything unreadable is dropped. */
function loadDiffBases(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DIFF_BASES_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(
      Object.entries(v).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''
      )
    )
  } catch {
    return {}
  }
}

/** Remembers (or, for null, forgets) a workspace's base across launches. */
function rememberDiffBase(id: string, base: string | null): void {
  try {
    const bases = loadDiffBases()
    if (base === null) delete bases[id]
    else bases[id] = base
    if (Object.keys(bases).length > 0) localStorage.setItem(DIFF_BASES_KEY, JSON.stringify(bases))
    else localStorage.removeItem(DIFF_BASES_KEY)
  } catch {
    // Nothing to remember into; the base still applies for this session.
  }
}

function initialDiffScopes(): Record<string, DiffScope> {
  return Object.fromEntries(
    Object.entries(loadDiffBases()).map(([id, base]) => [id, { base, commit: null }])
  )
}

export type View =
  | { kind: 'terminals'; key: string }
  | { kind: 'report' }
  | { kind: 'tickets' }
  | { kind: 'settings' }

export type DialogState =
  | { kind: 'new-workspace'; projectId: string }
  | { kind: 'remove-project'; projectId: string }
  | { kind: 'create-pr'; workspaceId: string }
  | { kind: 'remove-workspace'; workspaceId: string }
  | { kind: 'rename-workspace'; workspaceId: string }
  | { kind: 'start-ticket'; key: string; projects: Project[] }

export interface QueState {
  loaded: boolean
  connected: boolean
  error: string | null
  projects: Project[]
  /** Unarchived workspaces by id. */
  workspaces: Record<string, Workspace>
  terminals: TermTab[]
  tasks: Record<string, Task>
  /** The tickets assigned to the user, as last synced, in the daemon's order. */
  tickets: Ticket[]
  ticketsSync: TicketsSyncState
  view: View
  /** The pane layout per terminal key; a key without one has a single pane. */
  layouts: Record<string, PaneLayout>
  /** Per workspace: its pull request's conversation as last fetched (null: no pull request). */
  prThreads: Record<string, PrThread | null>
  /** Per workspace: why the last conversation fetch failed, or null. */
  prThreadErrors: Record<string, string | null>
  /** Per workspace: its diff against its base as last fetched. */
  diffs: Record<string, WorkspaceDiff>
  /** Per workspace: why the last diff fetch failed, or null. */
  diffErrors: Record<string, string | null>
  /** Per workspace: the base and commit its diff is narrowed to (none: the daemon's base, every commit). The base is remembered. */
  diffScopes: Record<string, DiffScope>
  /** Per workspace: its worktree's files as last listed. */
  fileLists: Record<string, WorkspaceFiles>
  /** Per workspace: why the last listing failed, or null. */
  fileListErrors: Record<string, string | null>
  /** Per workspace, per path: a file as last read for its file tab; null when the path is gone. */
  fileContents: Record<string, Record<string, WorkspaceFile | null>>
  /** Per workspace, per path: why the last read failed, or null. */
  fileErrors: Record<string, Record<string, string | null>>
  /** Per workspace: the Files tree's open directories, for the session; none until its files first load. */
  filesExpanded: Record<string, ReadonlySet<string>>
  /** The review pane: open or not, on which tab, how wide. Remembered. */
  review: ReviewState
  dialog: DialogState | null
  /** The daemon's quiet-hours state; null until loaded. */
  quiet: QuietState | null
  /** The user config (config.get); null until loaded. */
  config: ConfigGetResult | null
  /** The sidebar filter text; empty shows everything. Not remembered. */
  filter: string
  /** Whether the sidebar search field is shown. */
  searchOpen: boolean
  /** Bumped each time the search is asked for, so the field focuses and selects again. */
  searchFocusNonce: number
  /** How projects and workspaces are ordered; remembered. */
  sort: SidebarSort
}

export interface StoreOptions {
  /** The quiet board window: never opens terminals, never chimes. */
  board?: boolean
  /** The clock for ages, countdowns and windows. Default Date.now. */
  now?: () => number
}

/** Quiet hours are on and detail is not unlocked: terminals and reports are refused. */
export function isLocked(q: QuietState | null): boolean {
  return Boolean(q?.inQuietHours && !q.unlockedUntil)
}

const SORT_KEY = 'que.sidebarSort'

function loadSort(): SidebarSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'activity' ? 'activity' : 'name'
  } catch {
    return 'name'
  }
}

function toTab(t: TermInfo, reattached: boolean): TermTab {
  return {
    id: t.id,
    name: t.name,
    cwd: t.cwd,
    alive: t.alive,
    reattached,
    key: t.workspaceId ?? SCRATCH,
    createdAt: t.createdAt
  }
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]))
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = rec
  return rest
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class QueStore {
  private state: QueState = {
    loaded: false,
    connected: true,
    error: null,
    projects: [],
    workspaces: {},
    terminals: [],
    tasks: {},
    tickets: [],
    ticketsSync: { lastSyncAt: null, error: null, count: 0 },
    view: { kind: 'terminals', key: SCRATCH },
    layouts: {},
    prThreads: {},
    prThreadErrors: {},
    diffs: {},
    diffErrors: {},
    diffScopes: initialDiffScopes(),
    fileLists: {},
    fileListErrors: {},
    fileContents: {},
    fileErrors: {},
    filesExpanded: {},
    review: loadReview(),
    dialog: null,
    quiet: null,
    config: null,
    filter: '',
    searchOpen: false,
    searchFocusNonce: 0,
    sort: loadSort()
  }
  private listeners = new Set<() => void>()
  private offs: Array<() => void> = []
  private boot: Promise<void> | null = null
  /** Terminal keys that already had their first-visit terminal opened. */
  private autoOpened = new Set<string>()
  /** Terminals being created by this store, which place them themselves. */
  private creating = 0
  private createdMeanwhile = new Set<string>()
  /** Fetches in flight, so a pane and a list asking at once share one request. */
  private diffLoads = new Map<string, Promise<void>>()
  /** The latest diff fetch per workspace; an older one's answer is dropped. */
  private diffSeq = new Map<string, number>()
  private prThreadLoads = new Map<string, Promise<void>>()
  private fileListLoads = new Map<string, Promise<void>>()
  /** The latest listing per workspace; an older one's answer is dropped. */
  private fileListSeq = new Map<string, number>()
  /** Workspaces whose worktree change is being followed, and those with another change waiting. */
  private following = new Set<string>()
  /** The workspace this store asked the daemon to watch, if any. */
  private watchedKey: string | null = null
  private followAgain = new Set<string>()
  /** File reads in flight, keyed by workspace and path. */
  private fileLoads = new Map<string, Promise<void>>()

  constructor(
    private api: QueApi,
    private options: StoreOptions = {}
  ) {}

  // ---- external store plumbing ----------------------------------------------

  getState = (): QueState => this.state

  /** The current time, from the injected clock. */
  now = (): number => (this.options.now ?? Date.now)()

  // ---- app update ----------------------------------------------------------

  /** A newer release, if the main process's daily check found one. */
  fetchUpdate = (): Promise<UpdateInfo | null> => this.api.app.update()

  onUpdate = (cb: (info: UpdateInfo) => void): (() => void) => this.api.app.onUpdate(cb)

  /** Opens the newer release's page in the browser. */
  openUpdate = (): void => {
    void this.api.app.openUpdate().catch(() => {})
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(update: Partial<QueState> | ((s: QueState) => Partial<QueState>)): void {
    const patch = typeof update === 'function' ? update(this.state) : update
    this.state = { ...this.state, ...patch }
    if (patch.view) this.watchShown()
    for (const cb of this.listeners) cb()
  }

  /**
   * Asks the daemon to watch the worktree of the workspace this window shows, and no other, so
   * `workspace.changed` names it whatever the pane shows (a terminal, a diff, a file). Failures
   * are dropped: the Refresh button still works without the watch.
   */
  private watchShown(): void {
    const key = this.currentKey()
    const want = key !== null && key !== SCRATCH && !this.options.board ? key : null
    if (want === this.watchedKey) return
    const was = this.watchedKey
    this.watchedKey = want
    if (was !== null) void this.api.workspace.unwatch({ id: was }).catch(() => {})
    if (want !== null) void this.api.workspace.watch({ id: want }).catch(() => {})
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Subscribes to daemon events and loads everything once. Safe to call again after stop(). */
  start(): void {
    this.subscribeEvents()
    this.boot ??= this.load()
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
  }

  private async load(): Promise<void> {
    try {
      const [projects, workspaces, terms, tasks, quiet, config, tickets] = await Promise.all([
        this.api.project.list(),
        this.api.workspace.list(),
        this.api.term.list(),
        this.api.task.list(),
        this.api.quiet.state(),
        this.api.config.get(),
        this.api.tickets.list()
      ])
      const live = terms.filter((t) => t.alive)
      this.set((s) => ({
        loaded: true,
        quiet: s.quiet ?? quiet,
        config: s.config ?? config,
        tickets: tickets.tickets,
        ticketsSync: tickets.sync,
        projects: mergeProjects(projects, s.projects),
        workspaces: { ...byId(workspaces), ...s.workspaces },
        tasks: { ...byId(tasks), ...s.tasks },
        terminals: mergeTabs(
          live.map((t) => toTab(t, true)),
          s.terminals
        )
      }))
      this.hydrateLayouts()
      await this.visit(this.currentKey())
    } catch (err) {
      this.set({ error: message(err) })
    }
  }

  private subscribeEvents(): void {
    if (this.offs.length > 0) return
    const { term, workspace, task, project, quiet, config, tickets } = this.api
    this.offs.push(
      quiet.on('quiet.changed', (q) => {
        const was = isLocked(this.state.quiet)
        this.set({ quiet: q })
        // Unlocked (or morning): open the current view's first terminal if it has none.
        if (was && !isLocked(q)) void this.visit(this.currentKey())
      }),
      config.on('config.changed', (c) => this.set({ config: c })),
      tickets.on('tickets.synced', (r) => this.set({ tickets: r.tickets, ticketsSync: r.sync })),
      project.on('project.added', (p) =>
        this.set((s) => ({ projects: mergeProjects(s.projects, [p]) }))
      ),
      project.on('project.removed', ({ id }) => this.set((s) => dropProject(s, id))),
      term.on('term.created', ({ id }) => {
        // A terminal this store is creating is placed in its pane by the creator.
        if (this.creating > 0) this.createdMeanwhile.add(id)
        else void this.addTerminal(id)
      }),
      term.on('term.killed', ({ id }) => this.removeTab(id)),
      term.on('term.exit', ({ id }) =>
        this.set((s) => ({
          terminals: s.terminals.map((t) => (t.id === id ? { ...t, alive: false } : t))
        }))
      ),
      term.onDisconnect(() => this.set({ connected: false })),
      workspace.on('workspace.created', (ws) => this.upsertWorkspace(ws)),
      workspace.on('workspace.updated', (ws) => this.upsertWorkspace(ws)),
      workspace.on('workspace.changed', ({ id }) => this.followChange(id)),
      workspace.on('workspace.removed', ({ id }) => {
        if (id in this.state.diffScopes) rememberDiffBase(id, null)
        this.set((s) => ({
          workspaces: without(s.workspaces, id),
          diffScopes: without(s.diffScopes, id),
          view: s.view.kind === 'terminals' && s.view.key === id ? scratchView() : s.view
        }))
      }),
      workspace.on('workspace.status', (e) => {
        const prev = this.state.workspaces[e.id]?.status
        this.set((s) => {
          const ws = s.workspaces[e.id]
          if (!ws) return {}
          const next = { ...ws, status: e.status, statusReason: e.reason ?? null, statusAt: e.at }
          return { workspaces: { ...s.workspaces, [e.id]: next } }
        })
        // A live task's workspace never chimes on its own: its session ends a turn before the
        // task finishes, and asks for input as the task does; the task's own status chimes.
        const owned = latestTasks(this.state.tasks).get(e.id)
        if (owned && isLiveTask(owned.state)) return
        if (prev !== e.status) this.maybeChime({ state: e.status, reason: e.reason, prev })
      }),
      task.on('task.created', (t) => this.set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }))),
      task.on('task.updated', (t) => this.set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }))),
      task.on('task.status', (e) => {
        const prev = this.state.tasks[e.id]
        if (prev?.state !== e.state || prev?.reason !== (e.reason ?? null)) {
          this.maybeChime({ state: e.state, reason: e.reason })
        }
        this.set((s) => {
          const t = s.tasks[e.id]
          if (!t) return {}
          return {
            tasks: { ...s.tasks, [e.id]: { ...t, state: e.state, reason: e.reason ?? null } }
          }
        })
        // The status event carries no workspace, branch, or PR; re-read the task.
        void this.api.task.get({ id: e.id }).then(
          (t) => this.set((s) => ({ tasks: { ...s.tasks, [t.id]: t } })),
          () => {}
        )
      })
    )
  }

  /** A short chime for a finished task or turn (or one needing input), in work hours only. */
  private maybeChime(event: { state: string; reason?: string | null; prev?: string | null }): void {
    if (this.options.board) return
    const kind = shouldChime(event, this.state.quiet, this.state.config?.config.notifications)
    if (kind) chime(kind)
  }

  private upsertWorkspace(ws: Workspace): void {
    const prev = this.state.workspaces[ws.id]?.pr ?? null
    this.set((s) => ({ workspaces: { ...s.workspaces, [ws.id]: ws } }))
    // The review pane open on Pull request follows the shown workspace's pull request:
    // fetch again when it appears, disappears, or changes upstream.
    const next = ws.pr ?? null
    const changed =
      (prev === null) !== (next === null) ||
      (prev !== null && next !== null && prev.updatedAt !== next.updatedAt)
    const { review } = this.state
    if (changed && review.open && review.tab === 'pr' && this.currentKey() === ws.id) {
      void this.fetchPrThread(ws.id)
    } else if (changed && ws.id in this.state.prThreads) {
      // Not on screen: forget the stale conversation so the next look fetches it.
      this.set((s) => ({ prThreads: without(s.prThreads, ws.id) }))
    }
    if (!this.state.projects.some((p) => p.id === ws.projectId)) {
      // A project.added that raced the workspace event; fetch the list.
      void this.api.project.list().then(
        (projects) => this.set({ projects }),
        () => {}
      )
    }
  }

  private async addTerminal(id: string): Promise<TermTab | null> {
    const existing = this.state.terminals.find((t) => t.id === id)
    if (existing) return existing
    const info = (await this.api.term.list()).find((t) => t.id === id)
    if (!info) return null
    const tab = toTab(info, false)
    this.set((s) => ({ terminals: mergeTabs(s.terminals, [tab]) }))
    return tab
  }

  private currentKey(): string | null {
    return this.state.view.kind === 'terminals' ? this.state.view.key : null
  }

  /** Opens the first terminal of a key that has none, once per key. */
  private async visit(key: string | null): Promise<void> {
    if (key === null || !this.state.loaded || this.autoOpened.has(key)) return
    // The board never opens terminals; during quiet hours nothing may.
    if (this.options.board || isLocked(this.state.quiet)) return
    this.autoOpened.add(key)
    if (this.state.terminals.some((t) => t.key === key && t.alive)) return
    await this.newTerminal(key)
  }

  private fail(err: unknown): void {
    this.set({ error: message(err) })
  }

  // ---- actions --------------------------------------------------------------

  dismissError(): void {
    this.set({ error: null })
  }

  setFilter(text: string): void {
    this.set({ filter: text })
  }

  openSearch(): void {
    this.set({ searchOpen: true, searchFocusNonce: this.state.searchFocusNonce + 1 })
  }

  closeSearch(): void {
    this.set({ searchOpen: false, filter: '' })
  }

  setSort(sort: SidebarSort): void {
    try {
      localStorage.setItem(SORT_KEY, sort)
    } catch {
      // Nothing to remember into; the sort still applies for this session.
    }
    this.set({ sort })
  }

  openDialog(dialog: DialogState): void {
    this.set({ dialog })
  }

  closeDialog(): void {
    this.set({ dialog: null })
  }

  /**
   * Shows a workspace's terminals. The daemon only watches the shown workspace's worktree (the
   * view change asks it to, in watchShown), so what the pane and the view tabs show for the new
   * one is fetched again rather than served from the cache, in case it changed while another
   * was shown.
   */
  showTerminals(key: string): void {
    const was = this.currentKey()
    this.set({ view: { kind: 'terminals', key } })
    void this.visit(key)
    if (key !== was && key !== SCRATCH) void this.refetchShown(key)
  }

  // ---- the review pane ------------------------------------------------------

  private setReview(patch: Partial<ReviewState>): void {
    const review = { ...this.state.review, ...patch }
    this.set({ review })
    try {
      localStorage.setItem(REVIEW_KEY, JSON.stringify(review))
    } catch {
      // Nothing to remember into; the pane still applies for this session.
    }
  }

  /** Opens the review pane on a tab and loads what it shows for the current workspace. */
  openReview(tab: ReviewTab): void {
    this.setReview({ open: true, tab })
    const key = this.currentKey()
    if (key === null || key === SCRATCH) return
    if (tab === 'changes') void this.ensureDiff(key)
    else if (tab === 'files') {
      void this.ensureFiles(key)
      void this.ensureDiff(key)
    } else void this.fetchPrThread(key)
  }

  /**
   * With no tab, closes the pane when it is open, else opens it on its remembered tab.
   * With a tab, closes the pane when it is open on that tab, else opens it there.
   */
  toggleReview(tab?: ReviewTab): void {
    const { open, tab: current } = this.state.review
    if (open && (tab === undefined || current === tab)) this.closeReview()
    else this.openReview(tab ?? current)
  }

  closeReview(): void {
    this.setReview({ open: false })
  }

  /**
   * The daemon saw the worktree change on disk. For the shown workspace, fetch again what is on
   * screen: the diff (in its scope) while the pane or a view tab is open, and the listing and the
   * open file tabs too while Files or a file tab is; nothing while quiet hours are locked, when
   * those fetches are refused. One change at a time: a change arriving
   * while one is followed is followed once more after it lands.
   */
  private followChange(id: string): void {
    if (id !== this.currentKey() || isLocked(this.state.quiet)) return
    if (this.following.has(id)) {
      this.followAgain.add(id)
      return
    }
    this.following.add(id)
    void this.refetchShown(id).finally(() => {
      this.following.delete(id)
      if (this.followAgain.delete(id)) this.followChange(id)
    })
  }

  private refetchShown(key: string): Promise<void> {
    const { open, tab } = this.state.review
    const views = this.layout(key).views
    const fileTabs = views.some((v) => filePathOf(v) !== null)
    if (!open && views.length === 0) return Promise.resolve()
    const loads = [this.fetchDiff(key)]
    if ((open && tab === 'files') || fileTabs) loads.push(this.reloadFiles(key))
    return Promise.all(loads).then(() => undefined)
  }

  setReviewTab(tab: ReviewTab): void {
    this.setReview({ tab })
  }

  setReviewWidth(px: number): void {
    this.setReview({ width: clampReviewWidth(px) })
  }

  // ---- diff tabs ------------------------------------------------------------

  /** Opens a file's diff tab and selects it: where it already is, or else in the focused pane. */
  openDiff(key: string, path: string): void {
    this.openView(key, diffId(path))
  }

  /** Opens a worktree file's read-only tab and selects it: where it already is, or else in the focused pane. */
  openFile(key: string, path: string): void {
    this.openView(key, fileId(path))
  }

  private openView(key: string, id: string): void {
    const l = this.layout(key)
    if (l.views.includes(id)) {
      this.selectTerminal(key, id)
      return
    }
    const pane = l.split ? l.focused : 0
    this.setLayout(key, {
      ...l,
      views: [...l.views, id],
      second: pane === 1 ? [...l.second, id] : l.second,
      active: pane === 0 ? [id, l.active[1]] : [l.active[0], id],
      focused: pane
    })
  }

  /** Closes a view tab; its pane selects the neighbouring tab, and an emptied split collapses. */
  closeView(key: string, id: string): void {
    const l = this.layout(key)
    if (!l.views.includes(id)) return
    const pane = l.second.includes(id) ? 1 : 0
    const ids = this.paneIds(key, pane)
    const at = ids.indexOf(id)
    const neighbour = ids[at - 1] ?? ids[at + 1] ?? null
    const active: PaneLayout['active'] = [...l.active]
    if (this.paneActiveId(key, pane) === id) active[pane] = neighbour
    const next: PaneLayout = {
      ...l,
      views: l.views.filter((v) => v !== id),
      second: l.second.filter((x) => x !== id),
      active
    }
    const tabIds = this.tabs(key).map((t) => t.id)
    this.setLayout(key, reconcileLayout(next, new Set(tabIds), tabIds))
  }

  /** Closes the focused pane's active tab: a view tab (a diff or a file), or a terminal (which is killed). */
  closeActiveTab(key: string): void {
    const id = this.paneActiveId(key, this.focusedPane(key))
    if (id && isViewId(id)) this.closeView(key, id)
    else if (id) void this.closeTerminal(id)
  }

  /** Fetches a workspace's pull request conversation; a failure (quiet hours too) is kept for the view. */
  fetchPrThread(key: string, refresh = false): Promise<void> {
    const load = (async () => {
      try {
        const thread = await this.api.workspace.prThread(
          refresh ? { id: key, refresh: true } : { id: key }
        )
        this.set((s) => ({
          prThreads: { ...s.prThreads, [key]: thread },
          prThreadErrors: { ...s.prThreadErrors, [key]: null }
        }))
      } catch (err) {
        this.set((s) => ({ prThreadErrors: { ...s.prThreadErrors, [key]: message(err) } }))
      }
    })()
    return this.track(this.prThreadLoads, key, load)
  }

  /** Fetches the conversation unless it is loaded or on its way. */
  ensurePrThread(key: string): Promise<void> {
    if (key in this.state.prThreads) return Promise.resolve()
    return this.prThreadLoads.get(key) ?? this.fetchPrThread(key)
  }

  /** The base and commit a workspace's diff is narrowed to. */
  diffScope(key: string): DiffScope {
    return this.state.diffScopes[key] ?? NO_SCOPE
  }

  /**
   * Fetches a workspace's diff in its scope; a failure (quiet hours too) is kept for the views.
   * A base the daemon refuses (a branch since deleted) is forgotten when the daemon's own base works.
   * Only the latest fetch per workspace lands, so a quick change of scope never shows a stale answer.
   */
  fetchDiff(key: string): Promise<void> {
    const seq = (this.diffSeq.get(key) ?? 0) + 1
    this.diffSeq.set(key, seq)
    const current = (): boolean => this.diffSeq.get(key) === seq
    const load = (async () => {
      const scope = this.diffScope(key)
      try {
        const diff = await this.api.workspace.diff({
          id: key,
          base: scope.base ?? undefined,
          commit: scope.commit ?? undefined
        })
        if (current()) this.landDiff(key, diff)
      } catch (err) {
        if (!current()) return
        if (scope.base !== null) {
          try {
            const diff = await this.api.workspace.diff({ id: key })
            if (!current()) return
            rememberDiffBase(key, null)
            this.set((s) => ({ diffScopes: without(s.diffScopes, key) }))
            this.landDiff(key, diff)
            return
          } catch {
            if (!current()) return
          }
        }
        this.set((s) => ({
          diffs: without(s.diffs, key),
          diffErrors: { ...s.diffErrors, [key]: message(err) }
        }))
      }
    })()
    return this.track(this.diffLoads, key, load)
  }

  /**
   * Keeps a diff; once the Files tree has its open directories, any directory that now holds a
   * changed file and held none before is opened, and the rest of the set stands.
   */
  private landDiff(key: string, diff: WorkspaceDiff): void {
    this.set((s) => {
      const expanded = s.filesExpanded[key]
      const patch: Partial<QueState> = {
        diffs: { ...s.diffs, [key]: diff },
        diffErrors: { ...s.diffErrors, [key]: null }
      }
      if (expanded === undefined) return patch
      const listed = s.fileLists[key]?.files ?? []
      const tree = (d: WorkspaceDiff | undefined) =>
        buildTree(listed, new Map((d?.files ?? []).map((f) => [f.path, f])))
      const opened = newlyChanged(tree(s.diffs[key]), tree(diff))
      if (opened.length === 0) return patch
      return {
        ...patch,
        filesExpanded: { ...s.filesExpanded, [key]: new Set([...expanded, ...opened]) }
      }
    })
  }

  /** Compares a workspace against another ref (null: the daemon's choice), over every commit; remembered per workspace. */
  setDiffBase(key: string, base: string | null): Promise<void> {
    rememberDiffBase(key, base)
    this.set((s) => ({ diffScopes: { ...s.diffScopes, [key]: { base, commit: null } } }))
    return this.fetchDiff(key)
  }

  /** Narrows a workspace's diff to one commit's own changes (null: every commit). Not remembered. */
  setDiffCommit(key: string, commit: string | null): Promise<void> {
    this.set((s) => ({
      diffScopes: { ...s.diffScopes, [key]: { ...(s.diffScopes[key] ?? NO_SCOPE), commit } }
    }))
    return this.fetchDiff(key)
  }

  /** Fetches the diff unless it is loaded or on its way. */
  ensureDiff(key: string): Promise<void> {
    if (key in this.state.diffs) return Promise.resolve()
    return this.diffLoads.get(key) ?? this.fetchDiff(key)
  }

  // ---- the Files tab and file tabs -------------------------------------------

  /**
   * Lists a workspace's files; a failure (quiet hours too) is kept for the tree.
   * Only the latest listing per workspace lands.
   */
  fetchFiles(key: string): Promise<void> {
    const seq = (this.fileListSeq.get(key) ?? 0) + 1
    this.fileListSeq.set(key, seq)
    const current = (): boolean => this.fileListSeq.get(key) === seq
    const load = (async () => {
      try {
        const files = await this.api.workspace.files({ id: key })
        if (!current()) return
        this.set((s) => ({
          fileLists: { ...s.fileLists, [key]: files },
          fileListErrors: { ...s.fileListErrors, [key]: null }
        }))
      } catch (err) {
        if (!current()) return
        this.set((s) => ({
          fileLists: without(s.fileLists, key),
          fileListErrors: { ...s.fileListErrors, [key]: message(err) }
        }))
      }
    })()
    return this.track(this.fileListLoads, key, load)
  }

  /** Lists the files unless they are listed or on their way. */
  ensureFiles(key: string): Promise<void> {
    if (key in this.state.fileLists) return Promise.resolve()
    return this.fileListLoads.get(key) ?? this.fetchFiles(key)
  }

  /** Reads one file for its tab; a path that is gone is kept as null, any other failure as an error. */
  fetchFile(key: string, path: string): Promise<void> {
    const load = (async () => {
      let file: WorkspaceFile | null
      let error: string | null = null
      try {
        file = await this.api.workspace.readFile({ id: key, path })
      } catch (err) {
        file = null
        // The daemon's not-found code: the path left the worktree.
        if ((err as { code?: unknown }).code !== 'not_found') error = message(err)
      }
      this.set((s) => {
        const contents = { ...(s.fileContents[key] ?? {}) }
        if (error === null) contents[path] = file
        else delete contents[path]
        return {
          fileContents: { ...s.fileContents, [key]: contents },
          fileErrors: { ...s.fileErrors, [key]: { ...(s.fileErrors[key] ?? {}), [path]: error } }
        }
      })
    })()
    return this.track(this.fileLoads, `${key}\0${path}`, load)
  }

  /** Reads the file unless it is read or on its way. */
  ensureFile(key: string, path: string): Promise<void> {
    if (path in (this.state.fileContents[key] ?? {})) return Promise.resolve()
    return this.fileLoads.get(`${key}\0${path}`) ?? this.fetchFile(key, path)
  }

  /** The Files header's Refresh: the listing, the diff, and every open file tab of the workspace. */
  refreshFiles(key: string): Promise<void> {
    return Promise.all([this.reloadFiles(key), this.fetchDiff(key)]).then(() => undefined)
  }

  /** The listing and every open file tab of a workspace, without the diff. */
  private reloadFiles(key: string): Promise<void> {
    const paths = this.layout(key)
      .views.map(filePathOf)
      .filter((p): p is string => p !== null)
    return Promise.all([this.fetchFiles(key), ...paths.map((p) => this.fetchFile(key, p))]).then(
      () => undefined
    )
  }

  /** Sets the Files tree's open directories for a workspace. */
  setFilesExpanded(key: string, expanded: ReadonlySet<string>): void {
    this.set((s) => ({ filesExpanded: { ...s.filesExpanded, [key]: expanded } }))
  }

  private track(
    loads: Map<string, Promise<void>>,
    key: string,
    load: Promise<void>
  ): Promise<void> {
    loads.set(key, load)
    void load.finally(() => {
      if (loads.get(key) === load) loads.delete(key)
    })
    return load
  }

  showReport(): void {
    this.set({ view: { kind: 'report' } })
  }

  showTickets(): void {
    this.set({ view: { kind: 'tickets' } })
  }

  showSettings(): void {
    this.set({ view: { kind: 'settings' } })
  }

  /** Syncs the tickets now; a failure goes to the error banner. */
  async syncTickets(): Promise<void> {
    try {
      const r = await this.api.tickets.sync()
      this.set({ tickets: r.tickets, ticketsSync: r.sync })
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Starts a ticket: a workspace in the learned (or chosen) project, or a loose
   * session. Asks which project when none is known. Throws for the dialog.
   */
  async startTicket(
    key: string,
    choice?: { projectId: string } | { session: true }
  ): Promise<void> {
    const result = await this.api.tickets.start({ key, ...choice })
    if (result.kind === 'needs_project') {
      this.openDialog({ kind: 'start-ticket', key, projects: result.projects })
    } else if (result.kind === 'workspace') {
      this.upsertWorkspace(result.workspace)
      this.showTerminals(result.workspace.id)
    } else {
      // Add the tab before the view shows, so the view does not open a second terminal.
      await this.addTerminal(result.terminalId)
      this.showTerminals(SCRATCH)
      this.selectTerminal(SCRATCH, result.terminalId)
    }
  }

  /** The Start button: like startTicket, with a failure shown in the error banner. */
  async beginTicket(key: string): Promise<void> {
    try {
      await this.startTicket(key)
    } catch (err) {
      this.fail(err)
    }
  }

  async unlock(): Promise<void> {
    try {
      this.set({ quiet: await this.api.quiet.unlock() })
    } catch (err) {
      this.fail(err)
    }
  }

  async lock(): Promise<void> {
    try {
      this.set({ quiet: await this.api.quiet.lock() })
    } catch (err) {
      this.fail(err)
    }
  }

  fetchUnlocks(since?: string): Promise<QuietUnlock[]> {
    return this.api.quiet.log(since ? { since } : undefined)
  }

  /** Saves config changes; throws for the settings view to show. */
  async saveConfig(p: ConfigSetParams): Promise<ConfigGetResult> {
    const config = await this.api.config.set(p)
    this.set({ config })
    return config
  }

  /** The instructions file (instructions_file): its path, whether it exists, its text. */
  loadInstructions(): Promise<InstructionsGetResult> {
    return this.api.instructions.get()
  }

  /** Writes the instructions file; rejects with `not_configured` when no path is set. */
  saveInstructions(content: string): Promise<InstructionsGetResult> {
    return this.api.instructions.set({ content })
  }

  /** Selects a tab (a terminal or a view) within the pane that holds it, and focuses that pane. */
  selectTerminal(key: string, id: string): void {
    const l = this.layout(key)
    const pane = l.second.includes(id) ? 1 : 0
    const active: PaneLayout['active'] = pane === 0 ? [id, l.active[1]] : [l.active[0], id]
    this.setLayout(key, { ...l, active, focused: pane })
  }

  /** Focuses a pane (the second only when the key is split). */
  focusPane(key: string, pane: 0 | 1): void {
    const l = this.layout(key)
    if (l.focused === pane || (pane === 1 && !l.split)) return
    this.setLayout(key, { ...l, focused: pane })
  }

  /** The layout of a key. */
  layout(key: string): PaneLayout {
    return this.state.layouts[key] ?? NO_SPLIT
  }

  /** The terminal tabs of one pane, oldest first. */
  paneTabs(key: string, pane: 0 | 1): TermTab[] {
    const second = this.layout(key).second
    return this.tabs(key).filter((t) => second.includes(t.id) === (pane === 1))
  }

  /** The view (diff) tab ids of one pane, in the order they were opened. */
  paneViews(key: string, pane: 0 | 1): string[] {
    const l = this.layout(key)
    return l.views.filter((v) => l.second.includes(v) === (pane === 1))
  }

  /** Every tab id of one pane: its terminals, then its views. */
  private paneIds(key: string, pane: 0 | 1): string[] {
    return [...this.paneTabs(key, pane).map((t) => t.id), ...this.paneViews(key, pane)]
  }

  /** The selected tab id (a terminal or a view) of a pane, else its newest tab. */
  paneActiveId(key: string, pane: 0 | 1): string | null {
    const ids = this.paneIds(key, pane)
    const want = this.layout(key).active[pane]
    return (want && ids.includes(want) ? want : ids.at(-1)) ?? null
  }

  /** The selected terminal of a pane; null when the pane shows a view tab or holds no terminal. */
  paneActive(key: string, pane: 0 | 1): TermTab | null {
    const id = this.paneActiveId(key, pane)
    return this.paneTabs(key, pane).find((t) => t.id === id) ?? null
  }

  focusedPane(key: string): 0 | 1 {
    const l = this.layout(key)
    return l.split ? l.focused : 0
  }

  /** Creates a terminal for a key (a workspace's, or a loose one in the active tab's folder). */
  private async createFor(key: string): Promise<string> {
    if (key === SCRATCH) {
      const cwd = this.activeTab(key)?.cwd ?? (await this.api.app.homedir())
      return (await this.api.term.create({ cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })).id
    }
    return (
      await this.api.workspace.openTerminal({ id: key, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    ).id
  }

  /**
   * Creates a terminal and places it in a pane once its id is known, before its
   * tab appears, so it never mounts in the wrong pane.
   */
  private async openIn(key: string, place: (id: string) => void): Promise<void> {
    this.creating++
    try {
      const id = await this.createFor(key)
      place(id)
      await this.addTerminal(id)
    } catch (err) {
      this.fail(err)
    } finally {
      this.creating--
      if (this.creating === 0) {
        const others = [...this.createdMeanwhile]
        this.createdMeanwhile.clear()
        for (const id of others) void this.addTerminal(id)
      }
    }
  }

  /** A new terminal in the focused pane. */
  async newTerminal(key: string): Promise<void> {
    await this.openIn(key, (id) => {
      const l = this.layout(key)
      const pane = l.split ? l.focused : 0
      this.setLayout(key, {
        ...l,
        second: pane === 1 ? [...l.second, id] : l.second,
        active: pane === 0 ? [id, l.active[1]] : [l.active[0], id],
        focused: pane
      })
    })
  }

  /** Splits the key in two with a new terminal in the second pane (or adds one to it). */
  async splitPane(key: string, direction: 'row' | 'column'): Promise<void> {
    const first = this.paneActiveId(key, 0)
    await this.openIn(key, (id) => {
      const l = this.layout(key)
      this.setLayout(key, {
        ...l,
        split: l.split ?? { direction, ratio: RATIO_DEFAULT },
        second: [...l.second, id],
        active: [l.split ? l.active[0] : first, id],
        focused: 1
      })
    })
  }

  /** Joins the second pane's tabs onto the first; nothing is killed. */
  joinPanes(key: string): void {
    const l = this.layout(key)
    if (!l.split) return
    this.setLayout(key, {
      ...NO_SPLIT,
      views: l.views,
      active: [l.active[l.focused] ?? l.active[0], null]
    })
  }

  setRatio(key: string, ratio: number): void {
    const l = this.layout(key)
    if (!l.split) return
    this.setLayout(key, { ...l, split: { ...l.split, ratio: clampRatio(ratio) } })
  }

  resetRatio(key: string): void {
    this.setRatio(key, RATIO_DEFAULT)
  }

  private setLayout(key: string, layout: PaneLayout): void {
    this.set((s) => ({ layouts: { ...s.layouts, [key]: layout } }))
    try {
      if (isRemembered(layout)) localStorage.setItem(LAYOUT_PREFIX + key, JSON.stringify(layout))
      else localStorage.removeItem(LAYOUT_PREFIX + key)
    } catch {
      // Nothing to remember into; the layout still applies for this session.
    }
  }

  /** Restores the remembered layouts and view tabs, dropping terminals that no longer exist. */
  private hydrateLayouts(): void {
    const layouts: Record<string, PaneLayout> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i)
        if (!name?.startsWith(LAYOUT_PREFIX)) continue
        const key = name.slice(LAYOUT_PREFIX.length)
        const parsed = parseLayout(localStorage.getItem(name))
        if (!parsed) continue
        const tabIds = this.tabs(key).map((t) => t.id)
        const l = reconcileLayout(parsed, new Set(tabIds), tabIds)
        if (isRemembered(l)) layouts[key] = l
      }
    } catch {
      return
    }
    this.set((s) => ({ layouts: { ...layouts, ...s.layouts } }))
  }

  /** Removes a tab, collapsing its key's split if a pane is left empty. */
  private removeTab(id: string): void {
    const key = this.state.terminals.find((t) => t.id === id)?.key
    const terminals = this.state.terminals.filter((t) => t.id !== id)
    this.set({ terminals })
    const l = key === undefined ? undefined : this.state.layouts[key]
    if (key === undefined || !l?.split) return
    const tabIds = terminals.filter((t) => t.key === key).map((t) => t.id)
    const next = reconcileLayout(l, new Set(tabIds), tabIds)
    if (next !== l) this.setLayout(key, next)
  }

  async closeTerminal(id: string): Promise<void> {
    this.removeTab(id)
    try {
      await this.api.term.kill({ id })
    } catch {
      // Already gone.
    }
  }

  /** The tabs of a key, oldest first. */
  tabs(key: string): TermTab[] {
    return this.state.terminals.filter((t) => t.key === key)
  }

  /** The selected terminal of the focused pane, else of the first pane. */
  activeTab(key: string): TermTab | null {
    return this.paneActive(key, this.focusedPane(key)) ?? this.paneActive(key, 0)
  }

  async addProject(): Promise<void> {
    try {
      const dir = await this.api.app.openFolder()
      if (!dir) return
      const project = await this.api.project.add({ path: dir })
      this.set((s) => ({
        projects: s.projects.some((p) => p.id === project.id)
          ? s.projects
          : [...s.projects, project]
      }))
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Creates a workspace and shows it, which opens its first terminal. With `start`, the daemon
   * opens that terminal and types claude on the start prompt into it once setup is done; its tab
   * is added before the view shows, so the view does not open a second one. Throws for the dialog.
   */
  async createWorkspace(p: {
    projectId: string
    brief: string
    /** The workspace, branch and folder name. */
    name: string
    baseRef?: string
    start?: boolean
  }): Promise<void> {
    const { start, ...params } = p
    const ws = await this.api.workspace.create(params)
    this.upsertWorkspace(ws)
    if (!start) {
      this.showTerminals(ws.id)
      return
    }
    // The workspace exists now: a failure to start goes to the banner, not back to the dialog.
    let terminalId: string
    try {
      ;({ terminalId } = await this.api.workspace.start({
        id: ws.id,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS
      }))
    } catch (err) {
      this.fail(err)
      this.showTerminals(ws.id)
      return
    }
    await this.addTerminal(terminalId)
    this.showTerminals(ws.id)
    this.selectTerminal(ws.id, terminalId)
  }

  /** Whether a rename may also rename the workspace's branch (it was never pushed). */
  async canRenameBranch(id: string): Promise<boolean> {
    return (await this.api.workspace.canRenameBranch({ id })).allowed
  }

  /** Sets a workspace's title (and branch, when asked). Throws for the dialog. */
  async renameWorkspace(id: string, title: string, branch?: string): Promise<void> {
    const ws = await this.api.workspace.rename({
      id,
      title,
      ...(branch !== undefined ? { branch } : {})
    })
    this.upsertWorkspace(ws)
  }

  /** Removes the project and, with it, its workspaces (terminals killed, worktrees deleted). */
  async removeProject(id: string): Promise<void> {
    await this.api.project.remove({ id, force: true })
    this.set((s) => dropProject(s, id))
  }

  async removeWorkspace(id: string, deleteBranch: boolean): Promise<void> {
    await this.api.workspace.remove({ id, deleteBranch })
    this.set((s) => ({
      workspaces: without(s.workspaces, id),
      view: s.view.kind === 'terminals' && s.view.key === id ? scratchView() : s.view
    }))
  }

  async openInEditor(path: string): Promise<void> {
    try {
      await this.api.app.openInEditor({ path })
    } catch (err) {
      this.fail(err)
    }
  }

  async createPr(id: string, title: string): Promise<string> {
    const { prUrl } = await this.api.workspace.createPr({ id, title })
    this.set((s) => {
      const ws = s.workspaces[id]
      return ws ? { workspaces: { ...s.workspaces, [id]: { ...ws, prUrl } } } : {}
    })
    return prUrl
  }

  fetchReport(): Promise<Report> {
    return this.api.report.get()
  }
}

/** Projects in creation order, without duplicates (the first copy wins). */
function mergeProjects(a: readonly Project[], b: readonly Project[]): Project[] {
  const seen = new Set(a.map((p) => p.id))
  return [...a, ...b.filter((p) => !seen.has(p.id))].sort((x, y) =>
    x.createdAt.localeCompare(y.createdAt)
  )
}

function scratchView(): View {
  return { kind: 'terminals', key: SCRATCH }
}

/** The state without a project and its workspaces; a view on one of them goes back to scratch. */
function dropProject(s: QueState, id: string): Partial<QueState> {
  const gone = new Set(
    Object.values(s.workspaces)
      .filter((w) => w.projectId === id)
      .map((w) => w.id)
  )
  return {
    projects: s.projects.filter((p) => p.id !== id),
    workspaces: Object.fromEntries(Object.entries(s.workspaces).filter(([k]) => !gone.has(k))),
    view: s.view.kind === 'terminals' && gone.has(s.view.key) ? scratchView() : s.view
  }
}

/** Appends the tabs not already present, keeping creation order. */
function mergeTabs(a: readonly TermTab[], b: readonly TermTab[]): TermTab[] {
  const seen = new Set(a.map((t) => t.id))
  return [...a, ...b.filter((t) => !seen.has(t.id))].sort((x, y) =>
    x.createdAt.localeCompare(y.createdAt)
  )
}

export const StoreContext = createContext<QueStore | null>(null)

export function useStore(): QueStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore() outside <App>')
  return store
}

/** The store's state; re-renders on every change. */
export function useQue(): QueState {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.getState)
}
