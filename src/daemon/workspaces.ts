// Projects (registered git repos) and workspaces (git worktrees on their own
// branch). Every git call is execFile('git', [...]) with an explicit cwd; user
// input never reaches a shell string.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { titleOf } from '../shared/brief'
import {
  formatConfigErrors,
  loadConfig,
  loadRepoConfig,
  type RepoConfig,
  resolvePermissionMode,
  type UserConfig
} from '../shared/config'
import type { QuePaths } from '../shared/paths'
import type {
  ProjectAddParams,
  WorkspaceCreateParams,
  WorkspaceRemoveParams,
  WorkspaceRenameParams
} from '../shared/protocol'
import { randomWorkspaceName } from '../shared/names'
import { workspaceSlug } from '../shared/slug'
import type { Project, Workspace } from '../shared/types'
import { badRequest, conflict, notFound } from './errors'
import type { Emit, StatusService } from './status'
import { newId, type Store } from './store'
import { findOnPath, zshDir } from './wrapper'

export { slugify } from '../shared/slug'

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** Runs git in `cwd`; never throws. */
export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() })
    ).stdin?.end()
  })
}

/**
 * Commits on the workspace's branch past its base: `origin/<default>` when
 * that ref exists, else the base it was created from. Null when git cannot say.
 */
export async function commitsAhead(ws: Workspace, project: Project): Promise<number | null> {
  const def = project.defaultBranch
  const remote = await git(
    ws.path,
    ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${def}`],
    10_000
  )
  const base = remote.ok ? `origin/${def}` : ws.baseRef
  const counted = await git(ws.path, ['rev-list', '--count', `${base}..HEAD`], 10_000)
  if (!counted.ok) return null
  const n = Number(counted.stdout)
  return Number.isInteger(n) ? n : null
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['show-ref', '--verify', '--quiet', ref])).ok
}

async function validBranch(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ['check-ref-format', '--branch', branch])).ok
}

/** Keeps `.que/` out of `git status` through the repository's exclude file. */
export async function excludeQueDir(worktree: string): Promise<void> {
  const r = await git(worktree, ['rev-parse', '--git-path', 'info/exclude'])
  if (!r.ok || !r.stdout) return
  const file = resolve(worktree, r.stdout)
  let current = ''
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    // Created below.
  }
  if (current.split('\n').some((l) => l.trim() === '.que/')) return
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}.que/\n`)
}

async function detectDefaultBranch(repo: string): Promise<string> {
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.stdout.startsWith('origin/')) return head.stdout.slice('origin/'.length)
  for (const b of ['main', 'master']) {
    if (
      (await refExists(repo, `refs/heads/${b}`)) ||
      (await refExists(repo, `refs/remotes/origin/${b}`))
    ) {
      return b
    }
  }
  const current = await git(repo, ['symbolic-ref', '--short', 'HEAD'])
  return current.ok && current.stdout ? current.stdout : 'main'
}

export interface WorkspaceManagerOptions {
  store: Store
  paths: QuePaths
  status: StatusService
  emit: Emit
  /** Kills (and announces) every terminal of a workspace. */
  killTerminals: (workspaceId: string) => void
  log?: (msg: string) => void
  /** Draws a name for a workspace created without one (default: randomWorkspaceName). */
  randomName?: () => string
  /** Called after a workspace is created and announced (the summariser queues it). */
  onCreated?: (ws: Workspace) => void
  /** Called after a workspace is archived (the summariser drops it). */
  onRemoved?: (id: string) => void
}

export class WorkspaceManager {
  private setups = new Map<string, ChildProcess>()
  /** Settles when the workspace's setup command ends; absent once it has (or when there is none). */
  private ready = new Map<string, Promise<void>>()

  constructor(private opts: WorkspaceManagerOptions) {}

  private log(msg: string): void {
    this.opts.log?.(msg)
  }

  config(): UserConfig {
    const r = loadConfig({ queHome: this.opts.paths.home })
    if (!r.ok) throw badRequest(`invalid que config: ${formatConfigErrors(r.errors)}`)
    return r.config
  }

  private repoConfig(repo: string): RepoConfig {
    const r = loadRepoConfig(repo)
    if (!r.ok) throw badRequest(`invalid que.toml in ${repo}: ${formatConfigErrors(r.errors)}`)
    return r.config
  }

  // ---- projects -------------------------------------------------------------

  async addProject(p: ProjectAddParams): Promise<Project> {
    if (!fs.existsSync(p.path) || !fs.statSync(p.path).isDirectory()) {
      throw badRequest(`no such directory: ${p.path}`)
    }
    const top = await git(p.path, ['rev-parse', '--show-toplevel'])
    if (!top.ok || !top.stdout) throw badRequest(`not a git repository: ${p.path}`)
    const path = top.stdout
    const existing = this.opts.store.getProjectByPath(path)
    if (existing) return existing

    const name = (p.name ?? basename(path)).trim()
    if (!name || name.includes('/') || name === '.' || name === '..') {
      throw badRequest(`invalid project name: ${JSON.stringify(name)}`)
    }
    const configured = Object.values(this.config().repos).find((r) => r.path === path)
    const defaultBranch =
      this.repoConfig(path).defaultBranch ??
      configured?.defaultBranch ??
      (await detectDefaultBranch(path))
    const project: Project = {
      id: newId('prj_'),
      name,
      path,
      defaultBranch,
      createdAt: new Date().toISOString()
    }
    this.opts.store.insertProject(project)
    this.log(`project ${project.id} added: ${path} (default ${defaultBranch})`)
    return project
  }

  listProjects(): Project[] {
    return this.opts.store.listProjects()
  }

  project(id: string): Project {
    const p = this.opts.store.getProject(id)
    if (!p) throw notFound(`no project ${id}`)
    return p
  }

  async removeProject(id: string, force = false): Promise<void> {
    this.project(id)
    const open = this.opts.store.listWorkspaces(id)
    if (open.length > 0 && !force) {
      throw conflict(`project ${id} has ${open.length} workspace(s); remove them or pass force`)
    }
    for (const ws of open) await this.remove({ id: ws.id })
    this.opts.store.deleteProject(id)
  }

  // ---- workspaces -----------------------------------------------------------

  get(id: string): Workspace {
    const ws = this.opts.store.getWorkspace(id)
    if (!ws || ws.archivedAt) throw notFound(`no workspace ${id}`)
    return ws
  }

  list(projectId?: string): Workspace[] {
    return this.opts.store.listWorkspaces(projectId)
  }

  /**
   * Makes a workspace from a name (a clash is refused) or, without one, under a random
   * three-word name (drawn again on a clash, up to 50 times). The title defaults to the
   * brief's first line; a brief goes to `.que/brief.md`.
   */
  async create(p: WorkspaceCreateParams): Promise<Workspace> {
    const project = this.project(p.projectId)
    const brief = p.brief?.trim() ? p.brief : undefined
    const explicitTitle = p.title?.trim() || undefined
    const title = explicitTitle || (brief ? titleOf(brief) : undefined) || undefined
    const titleSource = title ? (explicitTitle ? 'user' : 'brief') : undefined
    const id = newId('ws_')
    const explicit = p.name !== undefined
    const draw = this.opts.randomName ?? (() => randomWorkspaceName())
    const wanted = explicit ? workspaceSlug(p.name ?? '') : draw()
    if (!wanted) {
      throw badRequest(
        `invalid workspace name ${JSON.stringify(p.name ?? '')}: use letters, digits, '.', '_' or '-' (max 64)`
      )
    }
    if (p.branch !== undefined && !(await validBranch(project.path, p.branch))) {
      throw badRequest(`invalid branch name ${JSON.stringify(p.branch)}`)
    }
    if (!(await validBranch(project.path, wanted))) {
      throw badRequest(`invalid branch name ${JSON.stringify(wanted)}`)
    }
    const config = this.config()
    const repo = this.repoConfig(project.path)

    // The first free name: only the given one for an explicit name, else up to 50 draws.
    let slug = ''
    let branch = ''
    let path = ''
    let clash = ''
    for (let i = 1; i <= (explicit ? 1 : 50); i++) {
      slug = i === 1 ? wanted : draw()
      branch = p.branch ?? slug
      path = join(config.worktreeRoot, project.name, slug)
      clash = await this.clash(project, slug, branch, path)
      if (!clash) break
      if (p.branch !== undefined && clash.startsWith('branch')) break
    }
    if (clash) throw conflict(clash)

    const remotes = await git(project.path, ['remote'])
    const hasOrigin = remotes.ok && remotes.stdout.split('\n').includes('origin')
    if (hasOrigin) {
      const fetched = await git(project.path, ['fetch', 'origin'], 30_000)
      if (!fetched.ok) this.log(`git fetch origin failed (continuing): ${fetched.stderr}`)
    }
    const base =
      p.baseRef ??
      (hasOrigin && (await refExists(project.path, `refs/remotes/origin/${project.defaultBranch}`))
        ? `origin/${project.defaultBranch}`
        : project.defaultBranch)
    if (!(await git(project.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])).ok) {
      throw badRequest(`unknown base ref ${base}`)
    }

    fs.mkdirSync(dirname(path), { recursive: true })
    const added = await git(project.path, [
      'worktree',
      'add',
      '--no-track',
      '-b',
      branch,
      path,
      base
    ])
    if (!added.ok) throw badRequest(`git worktree add failed: ${added.stderr}`)

    copyIncludes(project.path, path, repo.worktreeInclude, (m) => this.log(m))
    if (brief) {
      fs.mkdirSync(join(path, '.que'), { recursive: true })
      fs.writeFileSync(join(path, '.que', 'brief.md'), brief)
      await excludeQueDir(path)
    }

    const now = new Date().toISOString()
    const ws: Workspace = {
      id,
      projectId: project.id,
      name: slug,
      branch,
      path,
      baseRef: base,
      status: 'preparing',
      statusReason: null,
      statusAt: now,
      lastActivityAt: null,
      sessionId: null,
      createdAt: now,
      archivedAt: null,
      prUrl: null,
      pr: null,
      ...(title ? { title } : {}),
      ...(brief ? { brief } : {}),
      ...(titleSource ? { titleSource } : {})
    }
    this.opts.store.insertWorkspace(ws)
    this.opts.store.insertStatusLog(ws.id, ws.status, null, now)
    this.log(`workspace ${ws.id} created at ${path} on ${branch} from ${base}`)
    this.opts.emit('workspace.created', ws)
    this.opts.emit('workspace.status', { id: ws.id, status: 'preparing', at: now })
    this.runSetup(ws, repo.setup)
    this.opts.onCreated?.(ws)
    return ws
  }

  /** Why this name, branch, or path cannot be used, or '' (archived rows holding it are dropped). */
  private async clash(project: Project, slug: string, branch: string, path: string) {
    for (const other of this.opts.store.findWorkspaceConflicts(project.id, slug, path)) {
      if (!other.archivedAt) return `workspace ${slug} already exists (${other.id})`
      this.opts.store.deleteWorkspace(other.id)
    }
    if (await refExists(project.path, `refs/heads/${branch}`)) {
      return `branch ${branch} already exists`
    }
    if (fs.existsSync(path)) return `path already exists: ${path}`
    return ''
  }

  /** Resolves once the workspace's setup command has ended (at once when none is running). */
  whenReady(id: string): Promise<void> {
    return this.ready.get(id) ?? Promise.resolve()
  }

  /** True when the branch was never pushed: no `origin/<branch>` in the worktree. */
  async canRenameBranch(id: string): Promise<boolean> {
    const ws = this.get(id)
    const remote = await git(ws.path, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${ws.branch}`
    ])
    return !remote.ok
  }

  /**
   * Sets the title and, given a different branch, renames a never-pushed branch to it (the
   * folder keeps its name). Announces the change with workspace.updated.
   */
  async rename(p: WorkspaceRenameParams): Promise<Workspace> {
    const ws = this.get(p.id)
    const title = p.title.trim()
    if (!title) throw badRequest('title is required')
    const branch = p.branch?.trim()
    if (branch !== undefined && branch !== ws.branch) {
      if (!(await validBranch(ws.path, branch))) {
        throw badRequest(`invalid branch name ${JSON.stringify(branch)}`)
      }
      if (!(await this.canRenameBranch(ws.id))) {
        throw conflict(`branch ${ws.branch} is on origin; it keeps its name`)
      }
      if (await refExists(ws.path, `refs/heads/${branch}`)) {
        throw conflict(`branch ${branch} already exists`)
      }
      const moved = await git(ws.path, ['branch', '-m', ws.branch, branch])
      if (!moved.ok) throw badRequest(`git branch -m failed: ${moved.stderr}`)
      this.opts.store.setWorkspaceBranch(ws.id, branch)
    }
    this.opts.store.setWorkspaceTitle(ws.id, title, 'user')
    const next = this.get(ws.id)
    this.log(`workspace ${ws.id} renamed to ${JSON.stringify(title)} on ${next.branch}`)
    this.opts.emit('workspace.updated', next)
    return next
  }

  private runSetup(ws: Workspace, command: string | undefined): void {
    if (!command) {
      this.opts.status.set(ws.id, 'idle')
      return
    }
    const child = this.runInWorktree(ws, 'setup', command)
    this.setups.set(ws.id, child)
    let markReady = (): void => {}
    this.ready.set(
      ws.id,
      new Promise<void>((resolve) => {
        markReady = resolve
      })
    )
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      this.ready.delete(ws.id)
      markReady()
      if (this.setups.get(ws.id) === child) this.setups.delete(ws.id)
      this.log(`workspace ${ws.id} setup ${ok ? 'finished' : 'failed'}`)
      if (ok) this.opts.status.set(ws.id, 'idle', null, 'preparing')
      else this.opts.status.set(ws.id, 'stuck', 'setup_failed')
    }
    child.once('error', () => finish(false))
    child.once('exit', (code) => finish(code === 0))
  }

  /** Runs a que.toml command in the worktree via /bin/sh, logging to logs/workspaces/. */
  private runInWorktree(ws: Workspace, kind: 'setup' | 'teardown', command: string): ChildProcess {
    const logs = this.opts.paths.workspaceLogsDir
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 })
    const fd = fs.openSync(join(logs, `${ws.id}-${kind}.log`), 'a')
    try {
      return spawn('/bin/sh', ['-c', command], {
        cwd: ws.path,
        stdio: ['ignore', fd, fd],
        detached: true,
        env: { ...process.env, QUE_WORKSPACE_ID: ws.id, QUE_WORKSPACE_PATH: ws.path }
      })
    } finally {
      fs.closeSync(fd)
    }
  }

  async remove(p: WorkspaceRemoveParams): Promise<void> {
    const ws = this.get(p.id)
    const project = this.opts.store.getProject(ws.projectId)
    this.opts.killTerminals(ws.id)
    const setup = this.setups.get(ws.id)
    if (setup) {
      this.setups.delete(ws.id)
      killGroup(setup)
    }
    if (project && fs.existsSync(ws.path)) {
      const teardown = loadRepoConfig(project.path)
      if (teardown.ok && teardown.config.teardown) {
        const child = this.runInWorktree(ws, 'teardown', teardown.config.teardown)
        const timer = setTimeout(() => killGroup(child), 60_000)
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.once('error', () => resolve())
        })
        clearTimeout(timer)
      }
    }
    if (project) {
      const removed = await git(project.path, ['worktree', 'remove', '--force', ws.path])
      if (!removed.ok) this.log(`git worktree remove ${ws.path} failed: ${removed.stderr}`)
      await git(project.path, ['worktree', 'prune'])
      if (p.deleteBranch) {
        const deleted = await git(project.path, ['branch', '-D', ws.branch])
        if (!deleted.ok) this.log(`git branch -D ${ws.branch} failed: ${deleted.stderr}`)
      }
    }
    this.opts.store.archiveWorkspace(ws.id, new Date().toISOString())
    this.opts.status.forget(ws.id)
    this.opts.onRemoved?.(ws.id)
    this.log(`workspace ${ws.id} removed`)
    this.opts.emit('workspace.removed', { id: ws.id })
  }

  /** Stops setup commands still running (daemon shutdown). */
  close(): void {
    for (const child of this.setups.values()) killGroup(child)
    this.setups.clear()
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/** Copies gitignored files/dirs listed in worktree_include; missing ones are skipped. */
function copyIncludes(from: string, to: string, entries: string[], log: (m: string) => void): void {
  for (const entry of entries) {
    const rel = normalize(entry).replace(/\/+$/, '')
    if (!rel || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
      log(`worktree_include: skipping unsafe path ${entry}`)
      continue
    }
    const src = join(from, rel)
    if (!fs.existsSync(src)) continue
    const dest = join(to, rel)
    fs.mkdirSync(dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true })
  }
}

/**
 * What the claude wrapper adds to a session: QUE_INSTRUCTIONS (the configured
 * instructions file, whether or not it exists yet) and QUE_PERMISSION_MODE
 * (que.toml's permission_mode, else default_permission_mode, gated like a
 * task's; omitted when neither is set).
 */
export function sessionEnv(
  config: Pick<UserConfig, 'instructionsFile' | 'defaultPermissionMode' | 'allowBypassPermissions'>,
  repo: Pick<RepoConfig, 'permissionMode'>
): Record<string, string> {
  const env: Record<string, string> = {}
  if (config.instructionsFile) env.QUE_INSTRUCTIONS = config.instructionsFile
  if (repo.permissionMode || config.defaultPermissionMode) {
    env.QUE_PERMISSION_MODE = resolvePermissionMode(repo, config).mode
  }
  return env
}

/** Extra environment for a workspace terminal: hooks wrapper first on PATH. */
export function workspaceTerminalEnv(
  ws: Workspace,
  paths: QuePaths,
  socket: string,
  session: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {
    ...session,
    QUE_WORKSPACE_ID: ws.id,
    QUE_SOCKET: socket,
    QUE_HOME: paths.home,
    PATH: `${paths.binDir}:${process.env.PATH ?? ''}`
  }
  // The claude the daemon itself would run; the wrapper prefers it, so a
  // profile that reorders PATH cannot swap in a different binary.
  const real = findOnPath('claude', process.env.PATH, [paths.binDir])
  if (real) env.QUE_REAL_CLAUDE = real
  const shell = process.env.SHELL || '/bin/zsh'
  if (basename(shell) === 'zsh') {
    env.ZDOTDIR = zshDir(paths)
    if (process.env.ZDOTDIR) env.QUE_USER_ZDOTDIR = process.env.ZDOTDIR
  }
  return env
}
