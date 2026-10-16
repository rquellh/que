// Projects (registered git repos) and workspaces (git worktrees on their own
// branch). Every git call is execFile('git', [...]) with an explicit cwd; user
// input never reaches a shell string.
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
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
  WorkspaceRemoveParams
} from '../shared/protocol'
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
}

export class WorkspaceManager {
  private setups = new Map<string, ChildProcess>()

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

  async create(p: WorkspaceCreateParams): Promise<Workspace> {
    const project = this.project(p.projectId)
    const slug = workspaceSlug(p.name)
    if (!slug) {
      throw badRequest(
        `invalid workspace name ${JSON.stringify(p.name)}: use letters, digits, '.', '_' or '-' (max 64)`
      )
    }
    const branch = p.branch ?? slug
    if (!(await git(project.path, ['check-ref-format', '--branch', branch])).ok) {
      throw badRequest(`invalid branch name ${JSON.stringify(branch)}`)
    }
    const config = this.config()
    const repo = this.repoConfig(project.path)
    const path = join(config.worktreeRoot, project.name, slug)

    for (const other of this.opts.store.findWorkspaceConflicts(project.id, slug, path)) {
      if (!other.archivedAt) throw conflict(`workspace ${slug} already exists (${other.id})`)
      this.opts.store.deleteWorkspace(other.id)
    }
    if (await refExists(project.path, `refs/heads/${branch}`)) {
      throw conflict(`branch ${branch} already exists`)
    }
    if (fs.existsSync(path)) throw conflict(`path already exists: ${path}`)

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

    const now = new Date().toISOString()
    const ws: Workspace = {
      id: newId('ws_'),
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
      pr: null
    }
    this.opts.store.insertWorkspace(ws)
    this.opts.store.insertStatusLog(ws.id, ws.status, null, now)
    this.log(`workspace ${ws.id} created at ${path} on ${branch} from ${base}`)
    this.opts.emit('workspace.created', ws)
    this.opts.emit('workspace.status', { id: ws.id, status: 'preparing', at: now })
    this.runSetup(ws, repo.setup)
    return ws
  }

  private runSetup(ws: Workspace, command: string | undefined): void {
    if (!command) {
      this.opts.status.set(ws.id, 'idle')
      return
    }
    const child = this.runInWorktree(ws, 'setup', command)
    this.setups.set(ws.id, child)
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
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
