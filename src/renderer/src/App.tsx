import { useEffect, useState } from 'react'
import {
  CreatePrDialog,
  NewWorkspaceDialog,
  RemoveProjectDialog,
  RemoveWorkspaceDialog,
  RenameWorkspaceDialog,
  StartTicketDialog
} from './components/dialogs'
import { hhmm } from '../../daemon/quiet-hours'
import QuietBoard from './components/QuietBoard'
import ReportView from './components/ReportView'
import SettingsView from './components/SettingsView'
import TicketsView from './components/TicketsView'
import Sidebar from './components/Sidebar'
import SidebarResizer, { useSidebarWidth } from './components/SidebarResizer'
import Panes from './components/Panes'
import ReviewPane from './components/ReviewPane'
import ReviewResizer from './components/ReviewResizer'
import TopBar from './components/TopBar'
import UpdateBanner from './components/UpdateBanner'
import { isLocked, QueStore, StoreContext, useQue, useStore } from './store'
import { setReviewSource } from './testHook'

function Dialogs(): React.JSX.Element | null {
  const store = useStore()
  const { dialog, projects, workspaces } = useQue()
  const close = (): void => store.closeDialog()
  if (!dialog) return null
  switch (dialog.kind) {
    case 'new-workspace': {
      const project = projects.find((p) => p.id === dialog.projectId)
      return project ? <NewWorkspaceDialog project={project} onClose={close} /> : null
    }
    case 'remove-project': {
      const project = projects.find((p) => p.id === dialog.projectId)
      return project ? <RemoveProjectDialog project={project} onClose={close} /> : null
    }
    case 'start-ticket':
      return <StartTicketDialog ticketKey={dialog.key} projects={dialog.projects} onClose={close} />
    default: {
      const ws = workspaces[dialog.workspaceId]
      if (!ws) return null
      if (dialog.kind === 'create-pr') return <CreatePrDialog workspace={ws} onClose={close} />
      if (dialog.kind === 'rename-workspace') {
        return <RenameWorkspaceDialog workspace={ws} onClose={close} />
      }
      return <RemoveWorkspaceDialog workspace={ws} onClose={close} />
    }
  }
}

/** What the (hidden) main window shows while quiet hours are locked: no detail at all. */
function Locked(): React.JSX.Element {
  const { quiet } = useQue()
  return (
    <section className="locked" data-testid="quiet-locked" aria-label="Quiet hours">
      <p>
        Quiet hours. Detail unlocks at{' '}
        {quiet?.windowEnd ? hhmm(Date.parse(quiet.windowEnd)) : '--:--'}.
      </p>
    </section>
  )
}

function Shell(): React.JSX.Element {
  const store = useStore()
  const { view, error, dialog, connected, quiet, review } = useQue()
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  const locked = isLocked(quiet)
  const termKey = view.kind === 'terminals' && !locked ? view.key : null

  // Cmd+T / Cmd+W manage the tabs (⌘W closes a view tab too), Cmd+D / Cmd+Shift+D split the panes and
  // Cmd+Option+arrows move between them; captured before xterm sees them.
  useEffect(() => {
    if (termKey === null || dialog) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey) return
      const key = e.key.toLowerCase()
      const arrows = ['arrowleft', 'arrowup', 'arrowright', 'arrowdown']
      let run: (() => void) | null = null
      if (e.altKey) {
        if (e.shiftKey || !arrows.includes(key)) return
        const pane = key === 'arrowleft' || key === 'arrowup' ? 0 : 1
        run = () => store.focusPane(termKey, pane)
      } else if (key === 'd') {
        run = () => void store.splitPane(termKey, e.shiftKey ? 'column' : 'row')
      } else if (e.shiftKey) {
        return
      } else if (key === 'b') {
        run = () => store.toggleReview()
      } else if (key === 't') {
        run = () => void store.newTerminal(termKey)
      } else if (key === 'w') {
        run = () => store.closeActiveTab(termKey)
      }
      if (!run) return
      e.preventDefault()
      e.stopPropagation()
      run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store, termKey, dialog])

  // Tell the e2e test hook about the review pane.
  useEffect(() => {
    setReviewSource(() => store.getState().review)
    return () => setReviewSource(null)
  }, [store])

  // Cmd+K opens the sidebar search from anywhere (but not under a dialog); the field focuses itself.
  useEffect(() => {
    if (dialog) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      e.stopPropagation()
      store.openSearch()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store, dialog])

  return (
    <div
      className="app"
      data-testid="app-shell"
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--review-width': `${review.width}px`
        } as React.CSSProperties
      }
    >
      <div className="window-drag" aria-hidden="true" />
      <Sidebar />
      <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} />
      <main className="main">
        <UpdateBanner />
        {!connected ? (
          <div className="error" role="alert" data-testid="app-error">
            <span>Lost connection to the que daemon.</span>
          </div>
        ) : (
          error && (
            <div className="error" role="alert" data-testid="app-error">
              <span>{error}</span>
              <button
                type="button"
                className="ghost"
                aria-label="Dismiss"
                onClick={() => store.dismissError()}
              >
                ×
              </button>
            </div>
          )
        )}
        {locked ? (
          <Locked />
        ) : termKey !== null ? (
          <>
            <TopBar termKey={termKey} />
            <Panes termKey={termKey} />
          </>
        ) : view.kind === 'settings' ? (
          <SettingsView />
        ) : view.kind === 'tickets' ? (
          <TicketsView />
        ) : (
          <ReportView />
        )}
      </main>
      {termKey !== null && review.open && (
        <>
          <ReviewResizer width={review.width} onChange={(w) => store.setReviewWidth(w)} />
          <ReviewPane termKey={termKey} />
        </>
      )}
      <Dialogs />
    </div>
  )
}

/** The board window loads the renderer with `#board`. */
function isBoardWindow(): boolean {
  return window.location.hash === '#board'
}

export default function App({
  board = isBoardWindow(),
  now
}: {
  /** Render the quiet board (its own window) instead of the app. */
  board?: boolean
  /** The clock (tests pass a fixed one). Default Date.now. */
  now?: () => number
}): React.JSX.Element {
  const [store] = useState(() => new QueStore(window.que, { board, now }))

  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])

  return (
    <StoreContext.Provider value={store}>
      {board ? <QuietBoard /> : <Shell />}
    </StoreContext.Provider>
  )
}
