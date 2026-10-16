import { useEffect, useRef, useState } from 'react'
import type { Project, Task, Workspace } from '../../../preload/index.d'
import { isLiveTask, latestTasks } from '../format'
import { SCRATCH, useQue, useStore } from '../store'
import { countOpenTickets } from '../ticket-tree'
import { filterSidebar, matches, sortProjects, sortWorkspaces } from '../sidebar-order'
import { FolderPlusIcon, PlusIcon, SearchIcon, SortIcon } from './icons'
import Menu, { type MenuItem, type Point } from './Menu'
import { PrChip, StatusBadge, TaskBadge } from './StatusBadge'

/** Which row's menu is open, and where: under its ⋯ button, or at the pointer. */
type OpenMenu = { kind: 'project' | 'workspace'; id: string; at?: Point }

/**
 * A task-owned workspace shows its task: the task's state while it is live
 * (not the idle or exited terminal state), and `done` with the PR after.
 */
function WorkspaceBadge({ w, task }: { w: Workspace; task?: Task }): React.JSX.Element {
  const testId = `sidebar-workspace-${w.id}-status`
  const interactive = w.status === 'working' || w.status === 'needs_input'
  if (task && isLiveTask(task.state)) return <TaskBadge state={task.state} testId={testId} />
  if (task?.state === 'done' && !interactive) return <TaskBadge state="done" testId={testId} />
  return <StatusBadge status={w.status} reason={w.statusReason} testId={testId} />
}

export default function Sidebar(): React.JSX.Element {
  const store = useStore()
  const {
    projects,
    workspaces,
    view,
    connected,
    loaded,
    tasks,
    tickets,
    ticketsSync,
    filter,
    searchOpen,
    searchFocusNonce,
    sort
  } = useQue()
  const searchRef = useRef<HTMLInputElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the nonce re-runs the focus on every request
  useEffect(() => {
    if (!searchOpen) return
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [searchOpen, searchFocusNonce])
  const filtering = filter.trim() !== ''
  const openTickets = countOpenTickets(tickets.filter((t) => matches(filter, t.key, t.summary)))
  const owned = latestTasks(tasks)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const closeMenu = useRef(() => setMenu(null)).current
  const selected = view.kind === 'terminals' ? view.key : null
  const allSessions = store.tabs(SCRATCH)
  const sessions = allSessions.filter((t) => matches(filter, t.name, t.cwd))
  const narrowed = filterSidebar(filter, projects, Object.values(workspaces))
  const shownProjects = sortProjects(narrowed.projects, Object.values(workspaces), sort)
  const activeSession = selected === SCRATCH ? store.activeTab(SCRATCH) : null

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleMenu = (kind: OpenMenu['kind'], id: string): void =>
    setMenu(menu?.kind === kind && menu.id === id && !menu.at ? null : { kind, id })

  const menuAtPointer = (e: React.MouseEvent, kind: OpenMenu['kind'], id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind, id, at: { x: e.clientX, y: e.clientY } })
  }

  const projectItems = (p: Project): MenuItem[] => [
    {
      label: 'New workspace…',
      testId: 'new-workspace',
      action: () => store.openDialog({ kind: 'new-workspace', projectId: p.id })
    },
    {
      label: 'Open in editor',
      testId: 'open-editor',
      action: () => void store.openInEditor(p.path)
    },
    {
      label: 'Remove project…',
      testId: 'remove',
      action: () => store.openDialog({ kind: 'remove-project', projectId: p.id })
    }
  ]

  const workspaceItems = (w: Workspace): MenuItem[] => [
    {
      label: 'Rename…',
      testId: 'rename',
      action: () => store.openDialog({ kind: 'rename-workspace', workspaceId: w.id })
    },
    {
      label: 'Open in editor',
      testId: 'open-editor',
      action: () => void store.openInEditor(w.path)
    },
    {
      label: 'Remove…',
      testId: 'remove',
      action: () => store.openDialog({ kind: 'remove-workspace', workspaceId: w.id })
    }
  ]

  const menuFor = (kind: OpenMenu['kind'], id: string): OpenMenu | null =>
    menu?.kind === kind && menu.id === id ? menu : null

  return (
    <aside className="sidebar" data-testid="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className={`ghost icon sidebar-search-toggle${searchOpen ? ' active' : ''}`}
        data-testid="sidebar-search-toggle"
        aria-label="Search"
        title="Search (⌘K)"
        aria-expanded={searchOpen}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (searchOpen ? store.closeSearch() : store.openSearch())}
      >
        <SearchIcon />
      </button>
      {searchOpen && (
        <div className="sidebar-search">
          <input
            ref={searchRef}
            type="search"
            data-testid="sidebar-search"
            aria-label="Search"
            placeholder="Search"
            value={filter}
            onChange={(e) => store.setFilter(e.target.value)}
            onBlur={(e) => {
              if (e.currentTarget.value === '') store.closeSearch()
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              store.closeSearch()
            }}
          />
        </div>
      )}
      <nav aria-label="Sessions" data-testid="sidebar-sessions">
        <div className="section-head">
          <h2>Sessions</h2>
          <button
            type="button"
            className="ghost icon"
            data-testid="sidebar-sessions-add"
            aria-label="New session"
            title="New session: a terminal outside any workspace"
            disabled={!connected}
            onClick={() => {
              store.showTerminals(SCRATCH)
              void store.newTerminal(SCRATCH)
            }}
          >
            <PlusIcon />
          </button>
        </div>
        {allSessions.length > 0 && sessions.length === 0 ? (
          <p className="empty-note" data-testid="sidebar-sessions-nomatch">
            Nothing matches
          </p>
        ) : sessions.length === 0 ? (
          <p className="empty-note" data-testid="sidebar-sessions-empty">
            No sessions. Press + to open a terminal.
          </p>
        ) : (
          <ul>
            {sessions.map((t) => (
              <li key={t.id} className="session" data-testid={`sidebar-session-${t.id}`}>
                <button
                  type="button"
                  className="row-button"
                  data-testid={`sidebar-session-${t.id}-open`}
                  aria-current={activeSession?.id === t.id ? 'page' : undefined}
                  title={t.cwd}
                  onClick={() => {
                    store.showTerminals(SCRATCH)
                    store.selectTerminal(SCRATCH, t.id)
                  }}
                >
                  <span className="glyph" aria-hidden="true">
                    ›_
                  </span>
                  <span className="name">{t.name}</span>
                  {!t.alive && (
                    <span className="badge exited" data-testid={`sidebar-session-${t.id}-exited`}>
                      exited
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <nav aria-label="Projects">
        <div className="section-head">
          <h2>Projects</h2>
          <div className="head-actions">
            <button
              type="button"
              className="ghost icon"
              data-testid="sidebar-add-project"
              aria-label="Add project"
              title="Add project: a git repository"
              disabled={!connected}
              onClick={() => void store.addProject()}
            >
              <FolderPlusIcon />
            </button>
            <button
              type="button"
              className="ghost icon"
              data-testid="sidebar-sort"
              data-sort={sort}
              aria-label={sort === 'name' ? 'Sorted by name' : 'Sorted by last activity'}
              title={sort === 'name' ? 'Sort by last activity' : 'Sort by name'}
              onClick={() => store.setSort(sort === 'name' ? 'activity' : 'name')}
            >
              <SortIcon />
            </button>
          </div>
        </div>
        {loaded && projects.length === 0 && (
          <p className="empty-note" data-testid="sidebar-empty">
            Add a git repository to start a workspace.
          </p>
        )}
        {loaded && filtering && projects.length > 0 && shownProjects.length === 0 && (
          <p className="empty-note" data-testid="sidebar-projects-nomatch">
            Nothing matches
          </p>
        )}
        {shownProjects.map((p) => {
          const open = filtering || !collapsed.has(p.id)
          const list = sortWorkspaces(narrowed.workspacesOf(p.id), sort)
          const projectMenu = menuFor('project', p.id)
          return (
            <div key={p.id} className="project" data-testid={`sidebar-project-${p.id}`}>
              <div className="project-head">
                <button
                  type="button"
                  className="disclosure"
                  data-testid={`sidebar-project-${p.id}-toggle`}
                  aria-expanded={open}
                  title={p.path}
                  onClick={() => toggle(p.id)}
                  onContextMenu={(e) => menuAtPointer(e, 'project', p.id)}
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span> {p.name}
                </button>
                <button
                  type="button"
                  className="ghost icon"
                  data-testid={`sidebar-project-${p.id}-add-workspace`}
                  aria-label={`New workspace in ${p.name}`}
                  title={`New workspace in ${p.name}`}
                  disabled={!connected}
                  onClick={() => store.openDialog({ kind: 'new-workspace', projectId: p.id })}
                >
                  <PlusIcon />
                </button>
                <button
                  type="button"
                  className="ghost more"
                  data-testid={`sidebar-project-${p.id}-menu`}
                  aria-label={`More actions for ${p.name}`}
                  aria-haspopup="menu"
                  aria-expanded={projectMenu !== null}
                  onClick={() => toggleMenu('project', p.id)}
                >
                  ⋯
                </button>
                {projectMenu && (
                  <Menu
                    label={`Actions for ${p.name}`}
                    testId={`sidebar-project-${p.id}-menu`}
                    items={projectItems(p)}
                    at={projectMenu.at}
                    onClose={closeMenu}
                  />
                )}
              </div>
              {open && (
                <ul>
                  {list.map((w) => {
                    const workspaceMenu = menuFor('workspace', w.id)
                    return (
                      <li
                        key={w.id}
                        className="workspace"
                        data-testid={`sidebar-workspace-${w.id}`}
                        onContextMenu={(e) => menuAtPointer(e, 'workspace', w.id)}
                      >
                        <button
                          type="button"
                          className="row-button"
                          data-testid={`sidebar-workspace-${w.id}-open`}
                          aria-current={selected === w.id ? 'page' : undefined}
                          title={w.brief?.trim() ? `${w.brief.trim()}\n${w.path}` : w.path}
                          onClick={() => store.showTerminals(w.id)}
                        >
                          <span className="name" data-testid={`sidebar-workspace-${w.id}-name`}>
                            {w.title ?? w.name}
                          </span>
                          <WorkspaceBadge w={w} task={owned.get(w.id)} />
                        </button>
                        {w.pr ? (
                          <PrChip pr={w.pr} testId={`sidebar-workspace-${w.id}-pr`} />
                        ) : (
                          owned.get(w.id)?.state === 'done' &&
                          owned.get(w.id)?.prUrl && (
                            <a
                              className="pr-link"
                              href={owned.get(w.id)?.prUrl ?? undefined}
                              target="_blank"
                              rel="noreferrer"
                              data-testid={`sidebar-workspace-${w.id}-pr`}
                            >
                              PR #{owned.get(w.id)?.prUrl?.split('/').pop()}
                            </a>
                          )
                        )}
                        <button
                          type="button"
                          className="ghost more"
                          data-testid={`sidebar-workspace-${w.id}-menu`}
                          aria-label={`More actions for ${w.title ?? w.name}`}
                          aria-haspopup="menu"
                          aria-expanded={workspaceMenu !== null}
                          onClick={() => toggleMenu('workspace', w.id)}
                        >
                          ⋯
                        </button>
                        {workspaceMenu && (
                          <Menu
                            label={`Actions for ${w.title ?? w.name}`}
                            testId={`sidebar-workspace-${w.id}-menu`}
                            items={workspaceItems(w)}
                            at={workspaceMenu.at}
                            onClose={closeMenu}
                          />
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </nav>
      <div className="sidebar-bottom" data-testid="sidebar-bottom">
        <button
          type="button"
          className="row-button report-entry"
          data-testid="sidebar-report"
          aria-current={view.kind === 'report' ? 'page' : undefined}
          onClick={() => store.showReport()}
        >
          <span className="name">Report</span>
        </button>
        <button
          type="button"
          className="row-button report-entry tickets-entry"
          data-testid="sidebar-tickets"
          aria-current={view.kind === 'tickets' ? 'page' : undefined}
          onClick={() => store.showTickets()}
        >
          <span className="name">Tickets</span>
          {ticketsSync.error && (
            <span
              className="tickets-mark"
              data-testid="sidebar-tickets-error"
              title={ticketsSync.error}
            >
              ✕
            </span>
          )}
          <span className="count" data-testid="sidebar-tickets-count">
            {openTickets}
          </span>
        </button>
        <button
          type="button"
          className="row-button report-entry"
          data-testid="sidebar-settings"
          aria-current={view.kind === 'settings' ? 'page' : undefined}
          onClick={() => store.showSettings()}
        >
          <span className="name">Settings</span>
        </button>
      </div>
    </aside>
  )
}
