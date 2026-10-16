import fs from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import {
  ErrorCodes,
  MessageDecoder,
  encode,
  type EventName,
  type Events,
  type PingResult,
  type Request,
  type ResponseError
} from '../shared/protocol'
import {
  configPath,
  defaultConfig,
  formatConfigErrors,
  loadConfig,
  loadRepoConfig,
  mergeConfigPatch,
  parseConfig,
  readRawConfig,
  stringifyConfig,
  type UserConfig
} from '../shared/config'
import { ensureDirs, quePaths, type QuePaths } from '../shared/paths'
import type {
  ConfigGetResult,
  HookEvent,
  InstructionsGetResult,
  TaskAddParams,
  TermCreateParams
} from '../shared/protocol'
import type { TaskSource, TaskState, Workspace } from '../shared/types'
import { conflict, RpcError } from './errors'
import { finishTask, isProtectedBranch } from './finisher'
import type { HostedTerminal, PtyHost, TermExtra } from './pty-host'
import { QuietService } from './quiet'
import { TaskQueue } from './queue'
import { SYSTEM_PROMPT } from './runner'
import { PrService } from './prs'
import { StatusService } from './status'
import { TicketService } from './tickets'
import { Store } from './store'
import { workspaceDiff } from './diff'
import { readWorkspaceFile, workspaceFiles } from './files'
import { sessionEnv, WorkspaceManager, workspaceTerminalEnv } from './workspaces'
import { WorktreeWatcher } from './watcher'
import { defaultCliScript, installWrapper, resolveCliRunner, startCommand } from './wrapper'

export interface ServerOptions {
  host: PtyHost
  version: string
  startedAt?: string
  log?: (msg: string) => void
  /** Called after the daemon.shutdown response has been flushed. */
  onShutdown?: () => void
  /** Defaults to quePaths() at construction. */
  paths?: QuePaths
  /** The CLI bin/que runs. Defaults to the bundled out/cli/index.js. */
  cliScript?: string
  /** Status engine stall-check interval. Default 5 s. */
  statusTickMs?: number
  /** Task queue stall / pause tick. Default 5 s. */
  queueTickMs?: number
  /** Task dispatcher interval. Default 1 s. */
  dispatchMs?: number
  /** Quiet-hours re-evaluation interval. Default 15 s. */
  quietTickMs?: number
  /** The clock quiet hours read. Default Date.now. */
  now?: () => number
  /** Draws the name of a workspace created without one. Default randomWorkspaceName. */
  randomWorkspaceName?: () => string
}

interface Subscription {
  /** Live data buffered while an attach snapshot is being taken. */
  pending: string[] | null
}

/** Work to run after a response is written (e.g. flushing buffered data). */
type AfterSend = (fn: () => void) => void

class Connection {
  readonly subs = new Map<string, Subscription>()
  /** The workspaces this connection asked to watch with workspace.watch. */
  readonly watches = new Set<string>()
  private decoder: MessageDecoder<Request>

  constructor(
    readonly socket: net.Socket,
    readonly server: DaemonServer
  ) {
    this.decoder = new MessageDecoder<Request>((line) =>
      server.log(`bad frame from client: ${line.slice(0, 200)}`)
    )
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      for (const req of this.decoder.push(chunk)) void server.dispatch(this, req)
    })
    socket.on('error', () => {
      // Clients disappear without ceremony; 'close' does the cleanup.
    })
  }

  send(msg: unknown): void {
    if (this.socket.destroyed || !this.socket.writable) return
    this.socket.write(encode(msg))
  }

  sendEvent<E extends EventName>(event: E, data: Events[E]): void {
    this.send({ event, data })
  }
}

export class DaemonServer {
  private server: net.Server | null = null
  private conns = new Set<Connection>()
  private unsubs: Array<() => void> = []
  private socketPath = ''
  private closed = false
  /** Workspace of each workspace terminal, kept past the terminal's removal. */
  private termWorkspace = new Map<string, string>()
  readonly startedAt: string
  readonly paths: QuePaths
  readonly store: Store
  readonly status: StatusService
  readonly prs: PrService
  readonly tickets: TicketService
  readonly workspaces: WorkspaceManager
  readonly tasks: TaskQueue
  readonly quiet: QuietService
  /** The last good user config and the file stamp it was read at. */
  private config: UserConfig
  private configStamp = ''
  /** Watches the worktrees of workspaces with an attached terminal (workspace.changed). */
  readonly watcher = new WorktreeWatcher((id) => this.broadcast('workspace.changed', { id }), {
    log: (m) => this.log(m)
  })

  constructor(private opts: ServerOptions) {
    this.startedAt = opts.startedAt ?? new Date().toISOString()
    const { host } = opts
    this.paths = ensureDirs(opts.paths ?? quePaths())
    this.store = new Store(this.paths.db)
    this.config = defaultConfig({ queHome: this.paths.home })
    const emit = this.broadcast.bind(this) as DaemonServer['broadcast']
    this.status = new StatusService({
      store: this.store,
      emit,
      config: () => this.configOrDefault(),
      log: (m) => this.log(m),
      tickMs: opts.statusTickMs
    })
    this.workspaces = new WorkspaceManager({
      store: this.store,
      paths: this.paths,
      status: this.status,
      emit,
      killTerminals: (id) => this.killWorkspaceTerminals(id),
      log: (m) => this.log(m),
      randomName: opts.randomWorkspaceName
    })
    this.tasks = new TaskQueue({
      store: this.store,
      paths: this.paths,
      workspaces: this.workspaces,
      emit: ((event, data) => {
        emit(event, data)
        if (event === 'task.status' && (data as { state: string }).state === 'done') {
          const wsId = this.store.getTask((data as { id: string }).id)?.workspaceId
          if (wsId) void this.prs.refresh(wsId)
        }
      }) as DaemonServer['broadcast'],
      config: () => this.configOrDefault(),
      killTerminals: (id) => this.killWorkspaceTerminals(id),
      socket: () => this.socketPath,
      log: (m) => this.log(m),
      tickMs: opts.queueTickMs,
      dispatchMs: opts.dispatchMs
    })
    this.prs = new PrService({
      store: this.store,
      listWorkspaces: () => this.store.listWorkspaces(),
      projectOf: (ws) => this.workspaces.project(ws.projectId),
      emit,
      config: () => this.configOrDefault(),
      log: (m) => this.log(m)
    })
    this.tickets = new TicketService({
      store: this.store,
      config: () => this.configOrDefault(),
      emit,
      log: (m) => this.log(m),
      home: this.paths.home,
      projects: () => this.workspaces.listProjects(),
      createWorkspace: (p) => this.workspaces.create(p),
      openTerminal: async (workspaceId) => {
        const ws = this.workspaces.get(workspaceId)
        const t = this.createTerminal(
          { cwd: ws.path, cols: 120, rows: 30, name: ws.name },
          { workspaceId: ws.id, env: this.terminalEnv(ws) }
        )
        return { id: t.id }
      },
      createSession: async (cwd) => ({ id: this.createTerminal({ cwd, cols: 120, rows: 30 }).id }),
      writeTerminal: (id, data) => {
        const t = opts.host.get(id)
        if (!t) throw new RpcError(ErrorCodes.NotFound, `no terminal ${id}`)
        t.write(data)
      },
      learnProject: async (projectKey, projectName) => {
        this.setConfig({ jira: { projects: { [projectKey]: projectName } } }, false)
      }
    })
    this.quiet = new QuietService({
      store: this.store,
      emit,
      config: () => this.configOrDefault(),
      detachAll: () => {
        for (const c of this.conns) c.subs.clear()
        this.syncWatches()
      },
      report: (since) => this.tasks.report(since),
      log: (m) => this.log(m),
      now: opts.now,
      tickMs: opts.quietTickMs
    })
    this.unsubs.push(
      host.onData((id, data) => {
        for (const c of this.conns) {
          const sub = c.subs.get(id)
          if (!sub) continue
          if (sub.pending) sub.pending.push(data)
          else c.sendEvent('term.data', { id, data })
        }
      }),
      host.onExit((id, info) => {
        this.log(`term ${id} exited code=${info.exitCode} signal=${info.signal ?? ''}`)
        this.broadcast('term.exit', { id, exitCode: info.exitCode, signal: info.signal })
        const wsId = this.termWorkspace.get(id)
        if (wsId) {
          this.termWorkspace.delete(id)
          const live = host.list().some((t) => t.alive && t.workspaceId === wsId)
          if (!live) this.status.apply(wsId, { kind: 'terminal_exit' })
        }
        this.syncWatches()
      })
    )
  }

  /**
   * The user config, re-read whenever the file changes (so every reader sees
   * an edit at once). An invalid file keeps the last good config.
   */
  private configOrDefault(): UserConfig {
    const path = configPath()
    let stamp = `${path}:missing`
    try {
      const st = fs.statSync(path)
      stamp = `${path}:${st.mtimeMs}:${st.size}`
    } catch {
      // No file: the defaults.
    }
    if (stamp !== this.configStamp) {
      this.configStamp = stamp
      const r = loadConfig({ queHome: this.paths.home }, path)
      if (r.ok) this.config = r.config
      else
        this.log(
          `config ${path} is invalid; keeping the last good one: ${formatConfigErrors(r.errors)}`
        )
    }
    return this.config
  }

  private getConfig(): ConfigGetResult {
    const path = configPath()
    const raw = readRawConfig(path)
    return { path, config: this.configOrDefault(), raw: raw.ok ? raw.config : {} }
  }

  /** Merges a patch into the config file, validates, writes, and reloads it. */
  private setConfig(patch: unknown, applyTonight: boolean): ConfigGetResult {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new RpcError(ErrorCodes.BadRequest, 'patch must be an object')
    }
    const path = configPath()
    const raw = readRawConfig(path)
    if (!raw.ok) {
      throw new RpcError(ErrorCodes.BadRequest, `${path}: ${formatConfigErrors(raw.errors)}`)
    }
    const merged = mergeConfigPatch(raw.config, patch as Record<string, unknown>)
    // smol-toml writes the table back without the file's comments.
    const text = stringifyConfig(merged)
    const parsed = parseConfig(text, { queHome: this.paths.home })
    if (!parsed.ok) {
      throw new RpcError(
        ErrorCodes.BadRequest,
        `invalid config: ${formatConfigErrors(parsed.errors)}`
      )
    }
    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`)
    fs.renameSync(tmp, path)
    this.configStamp = ''
    this.configOrDefault()
    this.log(`config ${path} updated${applyTonight ? ' (apply tonight)' : ''}`)
    this.quiet.configChanged(applyTonight)
    this.tasks.kick()
    const result = this.getConfig()
    this.broadcast('config.changed', result)
    return result
  }

  private createTerminal(params: TermCreateParams, extra?: TermExtra): HostedTerminal {
    const t = this.opts.host.create(params, extra)
    if (extra?.workspaceId) this.termWorkspace.set(t.id, extra.workspaceId)
    this.log(`term ${t.id} created pid=${t.proc.pid} cwd=${t.cwd}`)
    this.broadcast('term.created', { id: t.id })
    return t
  }

  /**
   * Starts claude on the brief (or the configured start prompt) in the workspace's first terminal (opened when it has
   * none). Answers with the terminal at once; the command is typed once setup has ended.
   */
  private startWorkspace(id: string, cols = 120, rows = 30): { terminalId: string } {
    const ws = this.workspaces.get(id)
    const first =
      this.opts.host.list().find((t) => t.alive && t.workspaceId === ws.id) ??
      this.createTerminal(
        { cwd: ws.path, cols, rows, name: ws.name },
        { workspaceId: ws.id, env: this.terminalEnv(ws) }
      )
    const command = startCommand(
      this.configOrDefault().startPrompt,
      ws.brief ? join(ws.path, '.que', 'brief.md') : null
    )
    void this.workspaces.whenReady(ws.id).then(() => {
      const t = this.opts.host.get(first.id)
      if (t?.alive) t.write(command)
      else this.log(`workspace ${ws.id}: terminal ${first.id} is gone; claude not started`)
    })
    return { terminalId: first.id }
  }

  private killTerminal(id: string): boolean {
    if (!this.opts.host.kill(id)) return false
    this.log(`term ${id} killed`)
    for (const c of this.conns) c.subs.delete(id)
    this.syncWatches()
    this.broadcast('term.killed', { id })
    return true
  }

  /**
   * A workspace terminal's environment, with the instructions file and the
   * permission mode from the current config and the project's que.toml.
   */
  private terminalEnv(ws: Workspace): Record<string, string> {
    const repo = loadRepoConfig(this.workspaces.project(ws.projectId).path)
    if (!repo.ok) this.log(`que.toml for ${ws.name} is invalid: ${formatConfigErrors(repo.errors)}`)
    const session = sessionEnv(this.configOrDefault(), repo.ok ? repo.config : {})
    return workspaceTerminalEnv(ws, this.paths, this.socketPath, session)
  }

  private getInstructions(): InstructionsGetResult {
    const path = this.configOrDefault().instructionsFile
    if (!path) return { exists: false, content: '' }
    try {
      return { path, exists: true, content: fs.readFileSync(path, 'utf8') }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path, exists: false, content: '' }
      }
      throw new RpcError(ErrorCodes.BadRequest, `${path}: ${(err as Error).message}`)
    }
  }

  private setInstructions(content: string): InstructionsGetResult {
    const path = this.configOrDefault().instructionsFile
    if (!path) {
      throw new RpcError(
        ErrorCodes.NotConfigured,
        'no instructions file: set instructions_file in the que config first'
      )
    }
    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, path)
    this.log(`instructions ${path} updated`)
    return this.getInstructions()
  }

  /** Kills every terminal of a workspace; returns how many were still alive. */
  private killWorkspaceTerminals(workspaceId: string): number {
    let alive = 0
    for (const t of this.opts.host.list()) {
      if (t.workspaceId === workspaceId) {
        if (t.alive) alive += 1
        this.termWorkspace.delete(t.id)
        this.killTerminal(t.id)
      }
    }
    return alive
  }

  log(msg: string): void {
    this.opts.log?.(msg)
  }

  /**
   * Opens a draft pull request from an interactive workspace with the
   * finisher: commits what is uncommitted as `title`, pushes, and runs gh.
   */
  private async createPr(id: string, rawTitle: string): Promise<{ prUrl: string }> {
    const ws = this.workspaces.get(id)
    const title = rawTitle.trim()
    if (!title) throw new RpcError(ErrorCodes.BadRequest, 'title is required')
    const project = this.workspaces.project(ws.projectId)
    const { protectedBranches } = this.configOrDefault()
    if (isProtectedBranch(ws.branch, project.defaultBranch, protectedBranches)) {
      throw conflict(`refusing to open a pull request from protected branch ${ws.branch}`)
    }
    const busy = this.tasks
      .list()
      .some((t) => t.workspaceId === id && ['preparing', 'running', 'finishing'].includes(t.state))
    if (busy) throw conflict(`a task is running in workspace ${ws.name}`)

    const lines: string[] = []
    fs.mkdirSync(this.paths.workspaceLogsDir, { recursive: true, mode: 0o700 })
    const result = await finishTask({
      task: { title, resultText: null },
      workspace: ws,
      project,
      protectedBranches,
      bodyFile: join(this.paths.workspaceLogsDir, `${ws.id}.pr.md`),
      log: (line) => {
        lines.push(line)
        this.log(`workspace ${ws.id} ${line}`)
      }
    })
    if (!result.ok) {
      const detail = lines.at(-1) ?? `${result.step} failed`
      if (result.step === 'protected_branch') throw conflict(detail)
      throw new RpcError(ErrorCodes.Internal, detail)
    }
    if (!result.prUrl) {
      throw conflict(`${ws.branch} has no commits ahead of its base; nothing to open a PR for`)
    }
    this.store.setWorkspacePrUrl(ws.id, result.prUrl)
    this.broadcast('workspace.updated', this.workspaces.get(ws.id))
    void this.prs.refresh(ws.id)
    return { prUrl: result.prUrl }
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = new Connection(socket, this)
        this.conns.add(conn)
        socket.on('close', () => {
          // Subscriptions are per-connection; terminals keep running.
          conn.subs.clear()
          conn.watches.clear()
          this.conns.delete(conn)
          this.syncWatches()
        })
      })
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        this.socketPath = socketPath
        try {
          installWrapper({
            paths: this.paths,
            ...resolveCliRunner(),
            cliScript: this.opts.cliScript ?? defaultCliScript()
          })
        } catch (err) {
          this.log(`installing the hooks wrapper failed: ${(err as Error).message}`)
        }
        try {
          fs.writeFileSync(this.paths.systemPrompt, SYSTEM_PROMPT, { mode: 0o644 })
        } catch (err) {
          this.log(`writing ${this.paths.systemPrompt} failed: ${(err as Error).message}`)
        }
        this.status.start()
        this.tasks.start()
        this.quiet.start()
        this.prs.start()
        this.tickets.start()
        server.on('error', (err) => this.log(`server error: ${err.message}`))
        try {
          fs.chmodSync(socketPath, 0o600)
        } catch (err) {
          this.log(`chmod socket failed: ${(err as Error).message}`)
        }
        this.server = server
        resolve()
      })
    })
  }

  /**
   * Stops accepting connections and drops existing ones, and stops every task
   * run (restart recovery resumes them). Does not kill PTYs.
   */
  async close(): Promise<void> {
    for (const u of this.unsubs) u()
    this.unsubs = []
    if (!this.closed) {
      this.closed = true
      this.quiet.stop()
      this.prs.stop()
      await this.prs.drain()
      this.tickets.stop()
      await this.tickets.drain()
      await this.tasks.shutdown()
      this.status.stop()
      this.watcher.close()
      this.workspaces.close()
      this.store.close()
    }
    for (const c of this.conns) c.socket.destroy()
    this.conns.clear()
    const server = this.server
    this.server = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  /**
   * Watches the worktree of every workspace some connection asked to watch
   * (workspace.watch) or has a live terminal attached in, and nothing else.
   */
  private syncWatches(): void {
    if (this.closed) {
      this.watcher.close()
      return
    }
    const wanted = new Map<string, string>()
    for (const c of this.conns) {
      for (const id of c.watches) {
        if (wanted.has(id)) continue
        const ws = this.store.getWorkspace(id)
        if (ws && !ws.archivedAt) wanted.set(ws.id, ws.path)
      }
      for (const termId of c.subs.keys()) {
        const t = this.opts.host.get(termId)
        if (!t?.alive || !t.workspaceId || wanted.has(t.workspaceId)) continue
        const ws = this.store.getWorkspace(t.workspaceId)
        if (ws && !ws.archivedAt) wanted.set(ws.id, ws.path)
      }
    }
    this.watcher.sync(wanted)
  }

  broadcast<E extends EventName>(event: E, data: Events[E]): void {
    if (event === 'workspace.removed') {
      this.prs?.forget((data as Events['workspace.removed']).id)
      this.syncWatches()
    }
    for (const c of this.conns) c.sendEvent(event, data)
  }

  async dispatch(conn: Connection, req: Request): Promise<void> {
    if (typeof req !== 'object' || req === null || typeof req.id !== 'number') {
      this.log('dropping request without numeric id')
      return
    }
    if (typeof req.method !== 'string') {
      conn.send({ id: req.id, error: err(ErrorCodes.BadRequest, 'method must be a string') })
      return
    }
    const after: Array<() => void> = []
    try {
      const result = await this.handle(conn, req.method, req.params ?? {}, (fn) => after.push(fn))
      conn.send({ id: req.id, result })
      for (const fn of after) fn()
      if (req.method === 'daemon.shutdown') {
        // Let the response reach the client before tearing everything down.
        conn.socket.end(() => this.opts.onShutdown?.())
        setTimeout(() => this.opts.onShutdown?.(), 500).unref()
      }
    } catch (e) {
      const error =
        e instanceof RpcError
          ? err(e.code, e.message)
          : err(ErrorCodes.Internal, e instanceof Error ? e.message : String(e))
      if (!(e instanceof RpcError)) this.log(`${req.method} failed: ${error.message}`)
      conn.send({ id: req.id, error })
    }
  }

  private async handle(
    conn: Connection,
    method: string,
    p: Record<string, unknown>,
    afterSend: AfterSend
  ): Promise<unknown> {
    const { host } = this.opts
    // Quiet hours: detail is refused here, so every client gets the same answer.
    this.quiet.check(method)
    switch (method) {
      case 'daemon.ping': {
        const r: PingResult = {
          version: this.opts.version,
          pid: process.pid,
          startedAt: this.startedAt,
          nodeVersion: process.version,
          path: process.env.PATH ?? ''
        }
        return r
      }
      case 'daemon.shutdown':
        return { ok: true }
      case 'term.create': {
        const t = this.createTerminal({
          cwd: optString(p, 'cwd'),
          cols: num(p, 'cols'),
          rows: num(p, 'rows'),
          name: optString(p, 'name'),
          file: optString(p, 'file'),
          args: optStringArray(p, 'args')
        })
        return { id: t.id }
      }
      case 'term.list': {
        const workspaceId = optString(p, 'workspaceId')
        return host
          .list()
          .filter((t) => !workspaceId || t.workspaceId === workspaceId)
          .map((t) => t.info())
      }
      case 'term.attach': {
        const t = term(host, p)
        const cols = num(p, 'cols')
        const rows = num(p, 'rows')
        // Buffer live output from this instant; the snapshot below covers
        // everything before it, so nothing is lost or duplicated.
        const sub: Subscription = { pending: [] }
        conn.subs.set(t.id, sub)
        try {
          t.resize(cols, rows)
          const snapshot = await t.serializeNow()
          afterSend(() => flushPending(conn, t.id, sub))
          this.syncWatches()
          return { snapshot, cols: t.cols, rows: t.rows }
        } catch (e) {
          if (conn.subs.get(t.id) === sub) conn.subs.delete(t.id)
          this.syncWatches()
          throw e
        }
      }
      case 'term.detach': {
        conn.subs.delete(str(p, 'id'))
        this.syncWatches()
        return { ok: true }
      }
      case 'term.write': {
        term(host, p).write(str(p, 'data'))
        return { ok: true }
      }
      case 'term.resize': {
        term(host, p).resize(num(p, 'cols'), num(p, 'rows'))
        return { ok: true }
      }
      case 'term.kill': {
        const id = str(p, 'id')
        if (!this.killTerminal(id)) throw new RpcError(ErrorCodes.NotFound, `no terminal ${id}`)
        return { ok: true }
      }
      case 'term.snapshot':
        return term(host, p).snapshot()
      case 'project.add': {
        const before = new Set(this.workspaces.listProjects().map((x) => x.id))
        const project = await this.workspaces.addProject({
          path: str(p, 'path'),
          name: optString(p, 'name')
        })
        if (!before.has(project.id)) this.broadcast('project.added', project)
        return project
      }
      case 'project.list':
        return this.workspaces.listProjects()
      case 'project.remove':
        await this.workspaces.removeProject(str(p, 'id'), optBool(p, 'force'))
        this.broadcast('project.removed', { id: str(p, 'id') })
        return { ok: true }
      case 'workspace.create':
        return this.workspaces.create({
          projectId: str(p, 'projectId'),
          name: optString(p, 'name'),
          title: optString(p, 'title'),
          brief: optString(p, 'brief'),
          baseRef: optString(p, 'baseRef'),
          branch: optString(p, 'branch')
        })
      case 'workspace.start':
        return this.startWorkspace(str(p, 'id'), optNumber(p, 'cols'), optNumber(p, 'rows'))
      case 'workspace.rename':
        return this.workspaces.rename({
          id: str(p, 'id'),
          title: str(p, 'title'),
          branch: optString(p, 'branch')
        })
      case 'workspace.canRenameBranch':
        return { allowed: await this.workspaces.canRenameBranch(str(p, 'id')) }
      case 'workspace.list':
        return this.workspaces.list(optString(p, 'projectId'))
      case 'workspace.get':
        return this.workspaces.get(str(p, 'id'))
      case 'workspace.remove':
        this.tasks.stopWorkspace(str(p, 'id'))
        await this.workspaces.remove({ id: str(p, 'id'), deleteBranch: optBool(p, 'deleteBranch') })
        this.syncWatches()
        return { ok: true }
      case 'workspace.openTerminal': {
        const ws = this.workspaces.get(str(p, 'id'))
        const t = this.createTerminal(
          { cwd: ws.path, cols: num(p, 'cols'), rows: num(p, 'rows'), name: ws.name },
          { workspaceId: ws.id, env: this.terminalEnv(ws) }
        )
        return { id: t.id }
      }
      case 'workspace.diff': {
        const ws = this.workspaces.get(str(p, 'id'))
        return workspaceDiff(ws, this.workspaces.project(ws.projectId), Date.now, {
          base: optString(p, 'base'),
          commit: optString(p, 'commit')
        })
      }
      case 'workspace.watch':
        conn.watches.add(this.workspaces.get(str(p, 'id')).id)
        this.syncWatches()
        return { ok: true }
      case 'workspace.unwatch':
        conn.watches.delete(str(p, 'id'))
        this.syncWatches()
        return { ok: true }
      case 'workspace.files':
        return workspaceFiles(this.workspaces.get(str(p, 'id')), Date.now)
      case 'workspace.readFile':
        return readWorkspaceFile(this.workspaces.get(str(p, 'id')), str(p, 'path'))
      case 'workspace.prThread': {
        const ws = this.workspaces.get(str(p, 'id'))
        return this.prs.thread(ws.id, optBool(p, 'refresh') === true)
      }
      case 'workspace.createPr':
        return this.createPr(str(p, 'id'), str(p, 'title'))
      case 'hook.event': {
        const ws = this.workspaces.get(str(p, 'workspaceId'))
        const payload = p.payload
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new RpcError(ErrorCodes.BadRequest, 'payload must be an object')
        }
        this.status.hook(ws.id, payload as HookEvent)
        const taskId = optString(p, 'taskId')
        if (taskId) this.tasks.hook(taskId, payload as HookEvent)
        return { ok: true }
      }
      case 'task.add': {
        const params: TaskAddParams = {
          projectId: optString(p, 'projectId'),
          workspaceId: optString(p, 'workspaceId'),
          title: optString(p, 'title'),
          brief: str(p, 'brief'),
          source: optString(p, 'source') as TaskSource | undefined,
          resumeSessionId: optString(p, 'resumeSessionId'),
          maxTurns: optNumber(p, 'maxTurns'),
          maxBudgetUsd: optNumber(p, 'maxBudgetUsd')
        }
        return this.tasks.add(params)
      }
      case 'task.list':
        return this.tasks.list({ state: optString(p, 'state') as TaskState | undefined })
      case 'task.get':
        return this.tasks.get(str(p, 'id'))
      case 'task.stop':
        return this.tasks.stop(str(p, 'id'))
      case 'task.remove':
        this.tasks.remove(str(p, 'id'))
        return { ok: true }
      case 'queue.open':
        return this.tasks.open(optNumber(p, 'concurrency'))
      case 'queue.close':
        return this.tasks.close()
      case 'queue.state':
        return this.tasks.state()
      case 'report.get':
        return this.tasks.report(optString(p, 'since'))
      case 'quiet.state':
        return this.quiet.state()
      case 'quiet.unlock':
        return this.quiet.unlockFor(optNumber(p, 'minutes'), optString(p, 'why'))
      case 'quiet.lock':
        return this.quiet.lock()
      case 'quiet.log':
        return this.quiet.log(optString(p, 'since'))
      case 'tickets.list':
        return this.tickets.list()
      case 'tickets.sync':
        return this.tickets.sync()
      case 'tickets.start':
        return this.tickets.startTicket({
          key: str(p, 'key'),
          projectId: optString(p, 'projectId'),
          session: optBool(p, 'session')
        })
      case 'tickets.projectFor':
        return { projectId: this.tickets.projectFor(str(p, 'key')) }
      case 'config.get':
        return this.getConfig()
      case 'config.set':
        return this.setConfig(p.patch, optBool(p, 'applyTonight') === true)
      case 'instructions.get':
        return this.getInstructions()
      case 'instructions.set':
        return this.setInstructions(str(p, 'content'))
      default:
        throw new RpcError(ErrorCodes.UnknownMethod, `unknown method ${method}`)
    }
  }
}

function flushPending(conn: Connection, id: string, sub: Subscription): void {
  // A later attach/detach on this connection replaced this subscription.
  if (conn.subs.get(id) !== sub || !sub.pending) return
  const pending = sub.pending
  sub.pending = null
  if (pending.length > 0) conn.sendEvent('term.data', { id, data: pending.join('') })
}

function err(code: string, message: string): ResponseError {
  return { code, message }
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string') throw new RpcError(ErrorCodes.BadRequest, `${key} must be a string`)
  return v
}

function optString(p: Record<string, unknown>, key: string): string | undefined {
  return p[key] === undefined || p[key] === null ? undefined : str(p, key)
}

function optStringArray(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new RpcError(ErrorCodes.BadRequest, `${key} must be an array of strings`)
  }
  return v
}

function optBool(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new RpcError(ErrorCodes.BadRequest, `${key} must be a boolean`)
  return v
}

function optNumber(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RpcError(ErrorCodes.BadRequest, `${key} must be a number`)
  }
  return v
}

function num(p: Record<string, unknown>, key: string): number {
  const v = p[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
    throw new RpcError(ErrorCodes.BadRequest, `${key} must be a positive number`)
  }
  return v
}

function term(host: PtyHost, p: Record<string, unknown>) {
  const id = str(p, 'id')
  const t = host.get(id)
  if (!t) throw new RpcError(ErrorCodes.NotFound, `no terminal ${id}`)
  return t
}
