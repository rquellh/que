// The headless runner: prepares a task's workspace, runs the installed
// `claude` in it with stream-json output, feeds every message and exit to the
// task machine (through `apply`), kills the run when the machine says so, and
// hands a finished run to the finisher.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cleanSpawnEnv } from '../shared/env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import {
  loadRepoConfig,
  type PermissionMode,
  resolvePermissionMode,
  type RepoConfig,
  type UserConfig
} from '../shared/config'
import type { QuePaths } from '../shared/paths'
import type { Project, Task, Workspace } from '../shared/types'
import { finishTask } from './finisher'
import { StreamParser } from './stream-json'
import type { TaskEvent } from './task-machine'
import type { Store } from './store'
import type { WorkspaceManager } from './workspaces'
import { findOnPath } from './wrapper'

// ---- prompts (pure) ------------------------------------------------------------

const DEFINITION_OF_DONE = `Definition of done:
- Work only inside this worktree (the current directory); do not touch anything outside it.
- {test}
- Commit your work with a clear message. Do not push.
- End with a short summary of what you changed and why, suitable for a pull request description.`

/** The system prompt appended to every headless run (written to <QUE_HOME>/system.md). */
export const SYSTEM_PROMPT = `You are running unattended as a que overnight task. Nobody is watching this session.

- Work only inside the current git worktree; never modify files outside it.
- If the repository has a test command, run it and make it pass before you finish.
- Commit your work with a clear message. Never push, and never open pull requests; que does that.
- End with a short summary of what you changed and why, suitable for a pull request description.
- You cannot ask questions. If you are blocked, explain why in your final message and stop.
`

/** The brief, then the repo's instructions, then the fixed definition of done. */
export function buildPrompt(
  task: Pick<Task, 'brief'>,
  repo: Pick<RepoConfig, 'instructions' | 'test'>
): string {
  const test = repo.test
    ? `Run the test command \`${repo.test}\` and make it pass.`
    : 'Run the repository tests if it has any, and make them pass.'
  const parts = [task.brief.trim()]
  if (repo.instructions?.trim()) parts.push(repo.instructions.trim())
  parts.push(DEFINITION_OF_DONE.replace('{test}', test))
  return parts.join('\n\n')
}

export { resolvePermissionMode }

export interface ClaudeArgsOptions {
  prompt: string
  sessionId: string
  /** Resume `sessionId` instead of starting it. */
  resume: boolean
  permissionMode: PermissionMode
  maxTurns: number
  maxBudgetUsd: number
  systemPromptFile: string
  settingsFile: string
  allowedTools: readonly string[]
}

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-hook-events',
    o.resume ? '--resume' : '--session-id',
    o.sessionId,
    '--permission-mode',
    o.permissionMode,
    '--permission-prompts',
    'none',
    '--max-turns',
    String(o.maxTurns),
    '--max-budget-usd',
    String(o.maxBudgetUsd),
    '--append-system-prompt-file',
    o.systemPromptFile,
    '--settings',
    o.settingsFile
  ]
  if (o.allowedTools.length > 0) args.push('--allowedTools', o.allowedTools.join(','))
  return args
}

// ---- process groups ------------------------------------------------------------

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Kills a claude left running by a daemon that died, after checking it is one. */
export function reapOrphan(pid: number, log: (m: string) => void): void {
  if (!pidAlive(pid)) return
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8'
    })
    if (!command.includes('claude')) return
  } catch {
    return
  }
  log(`killing orphaned task process group ${pid}`)
  signalGroup(pid, 'SIGKILL')
}

// ---- runner --------------------------------------------------------------------

export const KILL_GRACE_MS = 5_000
/** How long a run may linger after its success result before it is killed. */
const FINISH_GRACE_MS = 10_000

interface Run {
  child: ChildProcess
  pid: number
  logFd: number
  killTimer: NodeJS.Timeout | null
  finishTimer: NodeJS.Timeout | null
}

export interface TaskRunnerOptions {
  store: Store
  paths: QuePaths
  workspaces: WorkspaceManager
  config: () => UserConfig
  /** Feeds an event to the task machine; returns the task after it. */
  apply: (id: string, event: TaskEvent) => Task | undefined
  /** Writes fields the machine does not own (pid, session, permission mode, workspace). */
  patch: (id: string, fields: Partial<Task>) => void
  /** Kills a workspace's terminals; returns how many were alive. */
  killTerminals: (workspaceId: string) => number
  socket: () => string
  log: (msg: string) => void
}

export class TaskRunner {
  private runs = new Map<string, Run>()
  private finishing = new Set<string>()
  private closed = false

  constructor(private o: TaskRunnerOptions) {}

  logPath(id: string): string {
    return join(this.o.paths.taskLogsDir, `${id}.log`)
  }

  /** Appends lines to the task's log. */
  taskLog(id: string, ...lines: string[]): void {
    try {
      fs.mkdirSync(this.o.paths.taskLogsDir, { recursive: true, mode: 0o700 })
      fs.appendFileSync(this.logPath(id), `${lines.map((l) => `[que] ${l}`).join('\n')}\n`)
    } catch (err) {
      this.o.log(`task ${id}: writing the log failed: ${(err as Error).message}`)
    }
  }

  /** Pids of every live claude this runner started. */
  pids(): number[] {
    return [...this.runs.values()].map((r) => r.pid)
  }

  isRunning(id: string): boolean {
    return this.runs.has(id)
  }

  /** Starts a queued task: preparing, then running. */
  start(id: string): void {
    const t = this.o.apply(id, { type: 'start' })
    if (t?.state !== 'preparing') return
    this.taskLog(id, `attempt ${t.attempts} starting at ${new Date().toISOString()}`)
    this.prepareAndSpawn(t).catch((err: Error) => {
      if (this.closed) return
      this.taskLog(id, `preparing failed: ${err.message}`)
      this.o.log(`task ${id}: preparing failed: ${err.stack ?? err.message}`)
      this.o.apply(id, { type: 'prepare_failed', reason: 'setup_failed' })
    })
  }

  private stillPreparing(id: string): boolean {
    return !this.closed && this.o.store.getTask(id)?.state === 'preparing'
  }

  /** The task's workspace, named from its title (suffixed on a clash) by WorkspaceManager.create. */
  private createWorkspace(task: Task, project: Project): Promise<Workspace> {
    return this.o.workspaces.create({ projectId: project.id, title: task.title, brief: task.brief })
  }

  /** Waits until the workspace's setup command has finished. */
  private async waitForSetup(id: string, taskId: string): Promise<Workspace | undefined> {
    for (;;) {
      const ws = this.o.store.getWorkspace(id)
      if (!ws || ws.archivedAt || ws.status !== 'preparing' || !this.stillPreparing(taskId)) {
        return ws
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private async prepareAndSpawn(task: Task): Promise<void> {
    const id = task.id
    const fail = (reason: string, why: string): void => {
      this.taskLog(id, why)
      this.o.apply(id, { type: 'prepare_failed', reason })
    }
    const project = this.o.store.getProject(task.projectId)
    if (!project) return fail('setup_failed', `project ${task.projectId} no longer exists`)

    let wsId = task.workspaceId
    if (!wsId) {
      const created = await this.createWorkspace(task, project)
      wsId = created.id
      this.o.patch(id, { workspaceId: created.id, branch: created.branch })
      this.taskLog(id, `created workspace ${created.name} at ${created.path}`)
    }
    const ws = await this.waitForSetup(wsId, id)
    if (!this.stillPreparing(id)) return
    if (!ws || ws.archivedAt) return fail('setup_failed', `workspace ${wsId} no longer exists`)
    if (ws.status === 'stuck' && ws.statusReason === 'setup_failed') {
      return fail('setup_failed', `workspace setup failed; see logs/workspaces/${ws.id}-setup.log`)
    }

    const repoResult = loadRepoConfig(project.path)
    if (!repoResult.ok) return fail('setup_failed', 'invalid que.toml')
    const repo = repoResult.config
    const config = this.o.config()

    const resume = task.resumeSessionId
    if (resume) {
      const killed = this.o.killTerminals(ws.id)
      this.taskLog(id, `taking over workspace ${ws.name}: killed ${killed} live terminal(s)`)
      this.o.log(`task ${id}: took over workspace ${ws.id} (killed ${killed} terminals)`)
    } else if (ws.status === 'working' || ws.status === 'needs_input') {
      return fail('session_active', `workspace ${ws.name} has an interactive session at work`)
    }

    const claude = resolveClaude(this.o.paths)
    if (!claude) return fail('setup_failed', 'claude was not found on PATH')

    const { mode, warning } = resolvePermissionMode(repo, config)
    if (warning) {
      this.taskLog(id, `warning: ${warning}`)
      this.o.log(`task ${id}: ${warning}`)
    }
    const sessionId = resume ?? randomUUID()
    const args = buildClaudeArgs({
      prompt: buildPrompt(task, repo),
      sessionId,
      resume: resume !== null,
      permissionMode: mode,
      maxTurns: task.maxTurns,
      maxBudgetUsd: task.maxBudgetUsd,
      systemPromptFile: this.o.paths.systemPrompt,
      settingsFile: this.o.paths.hooksJson,
      allowedTools: repo.allowedTools
    })

    if (!this.stillPreparing(id)) return
    this.o.patch(id, { permissionMode: mode, sessionId })
    this.o.apply(id, { type: 'prepared', workspaceId: ws.id, branch: ws.branch })
    this.spawnClaude(id, claude, args, ws)
  }

  private spawnClaude(id: string, claude: string, args: string[], ws: Workspace): void {
    const { paths } = this.o
    fs.mkdirSync(paths.taskLogsDir, { recursive: true, mode: 0o700 })
    const shown = args.map((a, i) => (i === 1 ? `<prompt: ${a.length} chars>` : a))
    this.taskLog(id, `$ ${claude} ${shown.join(' ')}`, `cwd ${ws.path}`)
    const logFd = fs.openSync(this.logPath(id), 'a')
    let child: ChildProcess
    try {
      child = spawn(claude, args, {
        cwd: ws.path,
        detached: true,
        stdio: ['ignore', 'pipe', logFd],
        // A fresh top-level session: no markers of whatever shell started the daemon.
        env: {
          ...cleanSpawnEnv(process.env),
          QUE_WORKSPACE_ID: ws.id,
          QUE_TASK_ID: id,
          QUE_SOCKET: this.o.socket(),
          QUE_HOME: paths.home,
          CLAUDE_CODE_RETRY_WATCHDOG: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          PATH: `${paths.binDir}:${process.env.PATH ?? ''}`
        }
      })
    } catch (err) {
      fs.closeSync(logFd)
      throw err
    }
    if (child.pid === undefined) {
      fs.closeSync(logFd)
      this.taskLog(id, 'spawning claude failed')
      this.o.apply(id, { type: 'exit', code: null, signal: null })
      return
    }
    const run: Run = { child, pid: child.pid, logFd, killTimer: null, finishTimer: null }
    this.runs.set(id, run)
    this.o.patch(id, { pid: child.pid })
    this.o.log(`task ${id}: claude pid ${child.pid} in ${ws.path}`)

    const parser = new StreamParser()
    const feed = (messages: ReturnType<StreamParser['push']>): void => {
      if (this.closed) return
      for (const message of messages) this.o.apply(id, { type: 'stream', message })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        fs.writeSync(logFd, chunk)
      } catch {
        // The log is best effort.
      }
      feed(parser.push(chunk))
    })
    child.on('error', (err) => this.taskLog(id, `claude process error: ${err.message}`))
    child.once('close', (code, signal) => {
      if (run.killTimer) clearTimeout(run.killTimer)
      if (run.finishTimer) clearTimeout(run.finishTimer)
      // Nothing of the group may outlive the run.
      signalGroup(run.pid, 'SIGKILL')
      try {
        fs.closeSync(logFd)
      } catch {
        // Already closed.
      }
      if (this.runs.get(id) === run) this.runs.delete(id)
      // During shutdown the rows stay as they are; restart recovery picks them up.
      if (this.closed) return
      feed(parser.flush())
      if (parser.skipped > 0)
        this.taskLog(id, `skipped ${parser.skipped} unparsable stdout line(s)`)
      this.taskLog(id, `claude exited code=${code ?? ''} signal=${signal ?? ''}`)
      this.o.patch(id, { pid: null })
      const after = this.o.apply(id, { type: 'exit', code, signal })
      if (after?.state === 'finishing') this.finish(id)
    })
  }

  /** Reacts to a state change the machine made. */
  onTransition(prev: Task, next: Task): void {
    if (this.closed || prev.state === next.state) return
    const run = this.runs.get(next.id)
    if (next.state === 'finishing') {
      if (!run) {
        this.finish(next.id)
        return
      }
      run.finishTimer = setTimeout(() => this.kill(next.id), FINISH_GRACE_MS)
      run.finishTimer.unref()
      return
    }
    if (run && next.state !== 'running') this.kill(next.id)
  }

  /** SIGTERM to the run's process group, SIGKILL after the grace period. */
  kill(id: string): void {
    const run = this.runs.get(id)
    if (!run || run.killTimer) return
    this.taskLog(id, `stopping claude (pid ${run.pid})`)
    signalGroup(run.pid, 'SIGTERM')
    run.killTimer = setTimeout(() => signalGroup(run.pid, 'SIGKILL'), KILL_GRACE_MS)
    run.killTimer.unref()
  }

  private finish(id: string): void {
    if (this.finishing.has(id) || this.closed) return
    this.finishing.add(id)
    void this.runFinisher(id)
      .catch((err: Error) => {
        if (this.closed) return
        this.taskLog(id, `finisher crashed: ${err.message}`)
        this.o.apply(id, { type: 'finish_failed', step: 'internal' })
      })
      .finally(() => this.finishing.delete(id))
  }

  private async runFinisher(id: string): Promise<void> {
    const task = this.o.store.getTask(id)
    if (task?.state !== 'finishing') return
    const ws = task.workspaceId ? this.o.store.getWorkspace(task.workspaceId) : undefined
    const project = this.o.store.getProject(task.projectId)
    if (!ws || !project) {
      this.o.apply(id, { type: 'finish_failed', step: 'workspace' })
      return
    }
    const result = await finishTask({
      task,
      workspace: ws,
      project,
      protectedBranches: this.o.config().protectedBranches,
      bodyFile: join(this.o.paths.taskLogsDir, `${id}.pr.md`),
      log: (line) => this.taskLog(id, line)
    })
    if (this.closed) return
    if (result.ok) this.o.apply(id, { type: 'finished', prUrl: result.prUrl })
    else this.o.apply(id, { type: 'finish_failed', step: result.step })
  }

  /** Daemon shutdown: stop every run and wait for it (SIGKILL after the grace period). */
  async close(): Promise<void> {
    this.closed = true
    const runs = [...this.runs.values()]
    await Promise.all(
      runs.map(
        (run) =>
          new Promise<void>((resolve) => {
            if (run.child.exitCode !== null || run.child.signalCode !== null) {
              signalGroup(run.pid, 'SIGKILL')
              resolve()
              return
            }
            const t = setTimeout(() => {
              signalGroup(run.pid, 'SIGKILL')
              resolve()
            }, 2_000)
            run.child.once('close', () => {
              clearTimeout(t)
              resolve()
            })
            signalGroup(run.pid, 'SIGTERM')
          })
      )
    )
    this.runs.clear()
  }
}

/** The claude a task runs: $QUE_REAL_CLAUDE, else the first on PATH outside que's bin. */
export function resolveClaude(paths: QuePaths): string | null {
  const pinned = process.env.QUE_REAL_CLAUDE
  if (pinned) {
    try {
      fs.accessSync(pinned, fs.constants.X_OK)
      if (fs.statSync(pinned).isFile()) return pinned
    } catch {
      // Fall back to PATH.
    }
  }
  return findOnPath('claude', process.env.PATH, [paths.binDir])
}
