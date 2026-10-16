// The task queue: task.* / queue.* / report.get, the
// dispatcher that starts queued tasks up to the concurrency cap while the
// queue is open, the clock tick (stalls, pause expiry, sleep/wake), the
// keep-awake, and recovery after a daemon restart. Every state change goes
// through the pure task machine; this module persists it and reacts.
import { type ChildProcess, spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { titleOf } from '../shared/brief'
import type { UserConfig } from '../shared/config'
import type { QuePaths } from '../shared/paths'
import type {
  QueueState,
  Report,
  TaskAddParams,
  TaskListParams,
  WorkspaceDigest
} from '../shared/protocol'
import type { Project, Task, TaskState } from '../shared/types'
import { buildWorkspaceDigest, sortDigests } from './digest'
import { badRequest, conflict, notFound } from './errors'
import { buildReport, reportSince } from './report'
import { reapOrphan, TaskRunner } from './runner'
import type { Emit } from './status'
import { newId, type Store } from './store'
import {
  ACTIVE_STATES,
  LIVE_STATES,
  nextTask,
  type TaskEvent,
  type TaskHookPayload
} from './task-machine'
import { commitsAhead, type WorkspaceManager } from './workspaces'
import { findOnPath } from './wrapper'

const KV_OPEN = 'queue.open'
const KV_OPENED_AT = 'queue.opened_at'
const KV_CONCURRENCY = 'concurrency'

/** A wall-clock jump this much larger than the monotonic clock's means the machine slept. */
export const WAKE_THRESHOLD_MS = 2 * 60_000

/** True when the wall clock advanced more than the monotonic clock by over the threshold. */
export function detectWake(
  prevWall: number,
  prevMono: number,
  wall: number,
  mono: number,
  thresholdMs = WAKE_THRESHOLD_MS
): boolean {
  return wall - prevWall - (mono - prevMono) > thresholdMs
}

export interface TaskQueueOptions {
  store: Store
  paths: QuePaths
  workspaces: WorkspaceManager
  emit: Emit
  config: () => UserConfig
  killTerminals: (workspaceId: string) => number
  socket: () => string
  log: (msg: string) => void
  now?: () => number
  /** Stall / pause / wake tick. Default 5 s. */
  tickMs?: number
  /** Dispatcher interval. Default 1 s. */
  dispatchMs?: number
}

export class TaskQueue {
  readonly runner: TaskRunner
  private timers: NodeJS.Timeout[] = []
  private kickScheduled = false
  private closed = false
  private caffeinate: ChildProcess | null = null
  private warnedNoCaffeinate = false
  private lastWall = 0
  private lastMono = 0
  private readonly now: () => number

  constructor(private o: TaskQueueOptions) {
    this.now = o.now ?? Date.now
    this.runner = new TaskRunner({
      store: o.store,
      paths: o.paths,
      workspaces: o.workspaces,
      config: o.config,
      apply: (id, event) => this.apply(id, event),
      patch: (id, fields) => this.patch(id, fields),
      killTerminals: o.killTerminals,
      socket: o.socket,
      log: o.log
    })
  }

  // ---- lifecycle --------------------------------------------------------------

  /** Recovers tasks a previous daemon left live, then starts the timers. */
  start(): void {
    for (const t of this.o.store.listTasks([...ACTIVE_STATES])) {
      if (t.pid !== null) reapOrphan(t.pid, this.o.log)
      this.o.log(`task ${t.id}: daemon restarted while ${t.state}`)
      this.patch(t.id, { pid: null })
      this.apply(t.id, { type: 'restart' })
    }
    this.lastWall = this.now()
    this.lastMono = performance.now()
    const tick = setInterval(() => this.tick(), this.o.tickMs ?? 5_000)
    const dispatch = setInterval(() => this.dispatch(), this.o.dispatchMs ?? 1_000)
    tick.unref()
    dispatch.unref()
    this.timers.push(tick, dispatch)
    this.kick()
  }

  /** Daemon shutdown: stops the timers, every run, and the keep-awake. */
  async shutdown(): Promise<void> {
    this.closed = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    await this.runner.close()
    this.stopCaffeinate()
  }

  /** Pids of task runs and the keep-awake (for leak checks). */
  pids(): number[] {
    const pids = this.runner.pids()
    if (this.caffeinate?.pid !== undefined && this.caffeinate.exitCode === null) {
      pids.push(this.caffeinate.pid)
    }
    return pids
  }

  // ---- the machine ------------------------------------------------------------

  private limits() {
    return { stallTimeoutMs: this.o.config().stallTimeoutMinutes * 60_000 }
  }

  /** Feeds one event to the machine, persists the result, and reacts. */
  apply(id: string, event: TaskEvent): Task | undefined {
    if (this.closed) return undefined
    const prev = this.o.store.getTask(id)
    if (!prev) return undefined
    const next = nextTask(prev, event, this.now(), this.limits())
    this.commit(prev, next)
    return next
  }

  private patch(id: string, fields: Partial<Task>): void {
    if (this.closed) return
    const prev = this.o.store.getTask(id)
    if (prev) this.commit(prev, { ...prev, ...fields })
  }

  private commit(prev: Task, next: Task): void {
    const changed = (Object.keys(next) as Array<keyof Task>).some(
      (k) => k !== 'updatedAt' && next[k] !== prev[k]
    )
    if (!changed) return
    next.updatedAt = new Date(this.now()).toISOString()
    this.o.store.updateTask(next)
    const statusChanged = prev.state !== next.state || prev.reason !== next.reason
    if (statusChanged) {
      this.o.log(
        `task ${next.id} ${prev.state} -> ${next.state}${next.reason ? ` (${next.reason})` : ''}`
      )
      this.o.emit('task.status', {
        id: next.id,
        state: next.state,
        ...(next.reason ? { reason: next.reason } : {}),
        at: next.updatedAt
      })
      this.runner.onTransition(prev, next)
      this.emitState()
      this.keepAwake()
      this.kick()
    }
    const updated: Array<keyof Task> = [
      'costUsd',
      'turns',
      'prUrl',
      'sessionId',
      'branch',
      'workspaceId',
      'pid'
    ]
    if (updated.some((k) => prev[k] !== next[k])) this.o.emit('task.updated', next)
  }

  // ---- dispatcher -------------------------------------------------------------

  private concurrency(): number {
    const override = Number(this.o.store.getKv(KV_CONCURRENCY))
    return Number.isInteger(override) && override > 0 ? override : this.o.config().concurrency
  }

  private isOpen(): boolean {
    return this.o.store.getKv(KV_OPEN) === 'true'
  }

  /** Dispatches soon (coalesced). */
  kick(): void {
    if (this.kickScheduled || this.closed) return
    this.kickScheduled = true
    setImmediate(() => {
      this.kickScheduled = false
      this.dispatch()
    })
  }

  /** Starts the oldest queued tasks until the cap; one live task per workspace. */
  dispatch(): void {
    if (this.closed || !this.isOpen()) return
    const active = this.o.store.listTasks([...ACTIVE_STATES])
    const busy = new Set(active.map((t) => t.workspaceId).filter((w): w is string => w !== null))
    let slots = this.concurrency() - active.length
    for (const t of this.o.store.listTasks(['queued'])) {
      if (slots <= 0) break
      if (t.workspaceId && busy.has(t.workspaceId)) continue
      if (t.workspaceId) busy.add(t.workspaceId)
      slots -= 1
      this.runner.start(t.id)
    }
  }

  // ---- clock ------------------------------------------------------------------

  tick(): void {
    if (this.closed) return
    const wall = this.now()
    const mono = performance.now()
    const woke = detectWake(this.lastWall, this.lastMono, wall, mono)
    this.lastWall = wall
    this.lastMono = mono
    if (woke) this.o.log('wake: the machine slept; re-checking running tasks')
    for (const t of this.o.store.listTasks(['running', 'paused'])) {
      if (woke && t.state === 'running' && !this.runner.isRunning(t.id)) {
        this.apply(t.id, { type: 'exit', code: null, signal: null })
        continue
      }
      this.apply(t.id, { type: 'tick' })
    }
    this.keepAwake()
  }

  /** Holds a `caffeinate -i -w <daemon pid>` while any task is active. */
  private keepAwake(): void {
    if (this.closed) return
    const needed = this.o.store.listTasks([...ACTIVE_STATES]).length > 0
    if (needed && !this.caffeinate) {
      const bin = findOnPath('caffeinate', process.env.PATH)
      if (!bin) {
        if (!this.warnedNoCaffeinate) this.o.log('caffeinate not found; the machine may sleep')
        this.warnedNoCaffeinate = true
        return
      }
      const child = spawn(bin, ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
      child.once('error', () => {})
      child.once('exit', () => {
        if (this.caffeinate === child) this.caffeinate = null
      })
      this.caffeinate = child
      this.o.log(`keep-awake on (caffeinate pid ${child.pid})`)
    } else if (!needed && this.caffeinate) {
      this.stopCaffeinate()
      this.o.log('keep-awake off')
    }
  }

  private stopCaffeinate(): void {
    const c = this.caffeinate
    this.caffeinate = null
    if (c && c.exitCode === null) c.kill('SIGTERM')
  }

  // ---- methods ----------------------------------------------------------------

  add(p: TaskAddParams): Task {
    if (typeof p.brief !== 'string' || p.brief.trim() === '') throw badRequest('brief is required')
    if (!p.projectId === !p.workspaceId) {
      throw badRequest('pass exactly one of projectId or workspaceId')
    }
    let projectId: string
    if (p.workspaceId) {
      const ws = this.o.workspaces.get(p.workspaceId)
      projectId = ws.projectId
    } else {
      projectId = this.o.workspaces.project(p.projectId as string).id
    }
    const source = p.source ?? 'prompt'
    if (!['prompt', 'file'].includes(source)) throw badRequest(`invalid source ${source}`)
    const positive = (v: unknown, key: string, int: boolean): void => {
      if (v === undefined) return
      if (typeof v !== 'number' || !(v > 0) || (int && !Number.isInteger(v))) {
        throw badRequest(`${key} must be a positive ${int ? 'integer' : 'number'}`)
      }
    }
    positive(p.maxTurns, 'maxTurns', true)
    positive(p.maxBudgetUsd, 'maxBudgetUsd', false)
    const title = (p.title?.trim() || titleOf(p.brief)).slice(0, 200)
    const config = this.o.config()
    const now = new Date(this.now()).toISOString()
    const task: Task = {
      id: newId('tsk_'),
      projectId,
      workspaceId: p.workspaceId ?? null,
      title,
      brief: p.brief,
      source,
      resumeSessionId: p.resumeSessionId ?? null,
      state: 'queued',
      reason: null,
      sessionId: null,
      pid: null,
      attempts: 0,
      costUsd: 0,
      turns: 0,
      maxTurns: p.maxTurns ?? config.maxTurns,
      maxBudgetUsd: p.maxBudgetUsd ?? config.maxBudgetUsd,
      permissionMode: null,
      branch: null,
      prUrl: null,
      resultText: null,
      lastActivityAt: null,
      startedAt: null,
      finishedAt: null,
      pausedUntil: null,
      createdAt: now,
      updatedAt: now
    }
    this.o.store.insertTask(task)
    this.o.log(`task ${task.id} added: ${title}`)
    this.o.emit('task.created', task)
    this.emitState()
    this.kick()
    return task
  }

  list(p: TaskListParams = {}): Task[] {
    return this.o.store.listTasks(p.state ? [p.state] : undefined)
  }

  get(id: string): Task {
    const t = this.o.store.getTask(id)
    if (!t) throw notFound(`no task ${id}`)
    return t
  }

  stop(id: string): Task {
    const t = this.get(id)
    if (!LIVE_STATES.has(t.state)) throw conflict(`task ${id} is already ${t.state}`)
    return this.apply(id, { type: 'stop' }) ?? t
  }

  remove(id: string): void {
    const t = this.get(id)
    if (LIVE_STATES.has(t.state)) throw conflict(`task ${id} is ${t.state}; stop it first`)
    this.o.store.deleteTask(id)
    this.emitState()
  }

  /** Stops every live task of a workspace (it is being removed). */
  stopWorkspace(workspaceId: string): void {
    for (const t of this.o.store.listTasks([...LIVE_STATES])) {
      if (t.workspaceId === workspaceId) this.apply(t.id, { type: 'stop' })
    }
  }

  hook(taskId: string, payload: TaskHookPayload): void {
    this.apply(taskId, { type: 'hook', payload })
  }

  open(concurrency?: number): QueueState {
    if (
      concurrency !== undefined &&
      (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1)
    ) {
      throw badRequest('concurrency must be a positive integer')
    }
    this.o.store.setKv(KV_OPEN, 'true')
    this.o.store.setKv(KV_OPENED_AT, new Date(this.now()).toISOString())
    if (concurrency !== undefined) this.o.store.setKv(KV_CONCURRENCY, String(concurrency))
    this.o.log(`queue opened (concurrency ${this.concurrency()})`)
    this.emitState()
    this.kick()
    return this.state()
  }

  close(): QueueState {
    this.o.store.setKv(KV_OPEN, 'false')
    this.o.store.setKv(KV_CONCURRENCY, null)
    this.o.log('queue closed')
    this.emitState()
    return this.state()
  }

  state(): QueueState {
    const count = (states: TaskState[]) => this.o.store.listTasks(states).length
    return {
      open: this.isOpen(),
      concurrency: this.concurrency(),
      running: count([...ACTIVE_STATES]),
      queued: count(['queued']),
      paused: count(['paused']),
      openedAt: this.o.store.getKv(KV_OPENED_AT) ?? null
    }
  }

  private emitState(): void {
    if (!this.closed) this.o.emit('queue.state', this.state())
  }

  async report(since?: string): Promise<Report> {
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw badRequest('since must be an ISO time')
    }
    const now = this.now()
    const from = reportSince(since, this.o.store.getKv(KV_OPENED_AT) ?? null, now)
    const names = new Map<string, string>()
    for (const t of this.o.store.listTasks()) {
      if (!t.workspaceId || names.has(t.workspaceId)) continue
      const ws = this.o.store.getWorkspace(t.workspaceId)
      if (ws) names.set(ws.id, ws.name)
    }
    const digests: WorkspaceDigest[] = []
    for (const ws of this.o.store.listWorkspaces()) {
      let project: Project
      try {
        project = this.o.workspaces.project(ws.projectId)
      } catch {
        continue
      }
      const log = this.o.store.listStatusLog(ws.id, from)
      const digest = buildWorkspaceDigest(ws, project, log, Date.parse(from), now, {
        commitsAhead: null
      })
      if (!digest) continue
      digest.commitsAhead = await commitsAhead(ws, project)
      digests.push(digest)
    }
    return buildReport(this.o.store.listTasks(), names, from, now, sortDigests(digests))
  }
}
