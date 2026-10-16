// The work-mode dialogs. Each owns its form state, calls one store action,
// and shows the daemon's error inline instead of closing.
import { type FormEvent, useEffect, useState } from 'react'
import type { Project, Workspace } from '../../../preload/index.d'
import { randomWorkspaceName } from '../../../shared/names'
import { workspaceSlug } from '../../../shared/slug'
import { useQue, useStore } from '../store'
import Dialog from './Dialog'
import { RefreshIcon } from './icons'

function useSubmit(): {
  busy: boolean
  error: string | null
  run: (fn: () => Promise<void>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function FormError({ error, testId }: { error: string | null; testId: string }) {
  if (!error) return null
  return (
    <p className="form-error" role="alert" data-testid={`${testId}-error`}>
      {error}
    </p>
  )
}

export function NewWorkspaceDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected } = useQue()
  const [brief, setBrief] = useState('')
  const [name, setName] = useState(() => randomWorkspaceName())
  const [baseRef, setBaseRef] = useState('')
  const [start, setStart] = useState(true)
  const { busy, error, run } = useSubmit()
  const slug = workspaceSlug(name)
  const id = 'dialog-new-workspace'
  // Claude needs something to read; a plain workspace does not.
  const canSubmit = !!slug && (!start || brief.trim() !== '') && !busy && connected

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (!canSubmit || !slug) return
    void run(async () => {
      await store.createWorkspace({
        projectId: project.id,
        brief,
        name: slug,
        start,
        ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {})
      })
      onClose()
    })
  }

  return (
    <Dialog title="New workspace" testId={id} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          What are you doing?
          <textarea
            data-testid={`${id}-brief`}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={
              'Add retry logic to the uploader\n\nBack off exponentially; give up after three tries.'
            }
            rows={5}
          />
        </label>
        <div className="row">
          <label>
            Branch and folder
            <input
              data-testid={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="ghost icon name-draw"
            data-testid={`${id}-new-name`}
            aria-label="New name"
            title="New name"
            onClick={() => setName(randomWorkspaceName())}
          >
            <RefreshIcon />
          </button>
        </div>
        {(!slug || slug !== name) && (
          <p className="hint" data-testid={`${id}-slug`} aria-live="polite">
            {slug ? `Becomes ${slug}` : "Use letters, digits, '.', '_' or '-' (up to 64)."}
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            data-testid={`${id}-start`}
            checked={start}
            onChange={(e) => setStart(e.target.checked)}
          />
          Start Claude with this brief
        </label>
        <details className="dialog-advanced">
          <summary>Advanced</summary>
          <label>
            Base ref (optional)
            <input
              data-testid={`${id}-base`}
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              placeholder={`origin/${project.defaultBranch}`}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </details>
        <FormError error={error} testId={id} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            data-testid={`${id}-submit`}
            disabled={!canSubmit}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function RenameWorkspaceDialog({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected } = useQue()
  const [title, setTitle] = useState(workspace.title ?? workspace.name)
  const [branch, setBranch] = useState(workspace.branch)
  /** Null until the daemon says whether the branch was pushed. */
  const [branchRenamable, setBranchRenamable] = useState<boolean | null>(null)
  const { busy, error, run } = useSubmit()
  const id = 'dialog-rename-workspace'
  const newBranch = branch.trim()
  const branchChanged = branchRenamable === true && newBranch !== workspace.branch

  useEffect(() => {
    let live = true
    store.canRenameBranch(workspace.id).then(
      (allowed) => {
        if (live) setBranchRenamable(allowed)
      },
      () => {
        if (live) setBranchRenamable(false)
      }
    )
    return () => {
      live = false
    }
  }, [store, workspace.id])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      await store.renameWorkspace(workspace.id, title.trim(), branchChanged ? newBranch : undefined)
      onClose()
    })
  }

  return (
    <Dialog title={`Rename ${workspace.title ?? workspace.name}`} testId={id} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Title
          <input
            data-testid={`${id}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          Branch
          <input
            data-testid={`${id}-branch`}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            disabled={branchRenamable !== true}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {branchRenamable === false && (
          <p className="hint" data-testid={`${id}-branch-pushed`}>
            Pushed branches keep their name
          </p>
        )}
        <p className="hint">The folder keeps its name, {workspace.name}.</p>
        <FormError error={error} testId={id} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            data-testid={`${id}-submit`}
            disabled={
              title.trim() === '' || (branchChanged && newBranch === '') || busy || !connected
            }
          >
            Rename
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function CreatePrDialog({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected } = useQue()
  const [title, setTitle] = useState('')
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const { busy, error, run } = useSubmit()
  const id = 'dialog-create-pr'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      setPrUrl(await store.createPr(workspace.id, title.trim()))
    })
  }

  return (
    <Dialog title={`Draft PR from ${workspace.branch}`} testId={id} onClose={onClose}>
      {prUrl ? (
        <>
          <p>
            Opened{' '}
            <a href={prUrl} target="_blank" rel="noreferrer" data-testid={`${id}-url`}>
              {prUrl}
            </a>
          </p>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <label>
            Title
            <input
              data-testid={`${id}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add retry logic to the uploader"
              autoComplete="off"
            />
          </label>
          <p className="hint">Uncommitted changes are committed with this title, then pushed.</p>
          <FormError error={error} testId={id} />
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              data-testid={`${id}-submit`}
              disabled={title.trim() === '' || busy || !connected}
            >
              {busy ? 'Opening…' : 'Create draft PR'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

export function RemoveProjectDialog({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected, workspaces } = useQue()
  const { busy, error, run } = useSubmit()
  const id = 'dialog-remove-project'
  const count = Object.values(workspaces).filter((w) => w.projectId === project.id).length

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      await store.removeProject(project.id)
      onClose()
    })
  }

  return (
    <Dialog title={`Remove ${project.name}?`} testId={id} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="hint">
          que forgets the repository at {project.path}; the repository itself is not touched.
        </p>
        {count > 0 && (
          <p className="hint" data-testid={`${id}-workspaces`}>
            Its {count} {count === 1 ? 'workspace is' : 'workspaces are'} removed too: terminals
            killed and worktrees deleted. Branches are kept.
          </p>
        )}
        <FormError error={error} testId={id} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger"
            data-testid={`${id}-submit`}
            disabled={busy || !connected}
          >
            Remove
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function RemoveWorkspaceDialog({
  workspace,
  onClose
}: {
  workspace: Workspace
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected } = useQue()
  const [deleteBranch, setDeleteBranch] = useState(false)
  const { busy, error, run } = useSubmit()
  const id = 'dialog-remove-workspace'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      await store.removeWorkspace(workspace.id, deleteBranch)
      onClose()
    })
  }

  return (
    <Dialog title={`Remove ${workspace.name}?`} testId={id} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="hint">Its terminals are killed and the worktree is deleted.</p>
        <label className="check">
          <input
            type="checkbox"
            data-testid={`${id}-delete-branch`}
            checked={deleteBranch}
            onChange={(e) => setDeleteBranch(e.target.checked)}
          />
          Also delete the branch {workspace.branch}
        </label>
        <FormError error={error} testId={id} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger"
            data-testid={`${id}-submit`}
            disabled={busy || !connected}
          >
            Remove
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function StartTicketDialog({
  ticketKey,
  projects,
  onClose
}: {
  ticketKey: string
  projects: Project[]
  onClose: () => void
}): React.JSX.Element {
  const store = useStore()
  const { connected } = useQue()
  const [choice, setChoice] = useState(projects[0]?.id ?? 'session')
  const { busy, error, run } = useSubmit()
  const id = 'dialog-start-ticket'

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    void run(async () => {
      await store.startTicket(
        ticketKey,
        choice === 'session' ? { session: true } : { projectId: choice }
      )
      onClose()
    })
  }

  return (
    <Dialog title={`Start ${ticketKey}`} testId={id} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="hint">
          que does not know which project this ticket belongs to yet; it remembers your choice.
        </p>
        <label>
          Project
          <select
            data-testid={`${id}-project`}
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="session">A session, no project</option>
          </select>
        </label>
        <FormError error={error} testId={id} />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            data-testid={`${id}-submit`}
            disabled={busy || !connected}
          >
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
