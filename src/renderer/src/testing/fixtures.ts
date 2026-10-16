// Fixture factories for renderer tests. Same shapes as src/testing/fixtures.ts
// (kept separate: renderer tests never import node-side test code).
import type {
  DiffFile,
  Project,
  PrCheck,
  PrThreadEntry,
  PullRequest,
  QuietState,
  Task,
  TermInfo,
  Ticket,
  UserConfig,
  Workspace,
  WorkspaceDiff,
  DiffCommit,
  WorkspaceDigest,
  WorkspaceFiles,
  WorkspaceFile
} from '../../../preload/index.d'

let wsCounter = 0
let taskCounter = 0
let termCounter = 0

/** The uploader repository, the project every fixture workspace belongs to by default. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'prj_01hzw7q2m4nb',
    name: 'uploader',
    path: '/Users/dev/code/uploader',
    defaultBranch: 'main',
    createdAt: '2026-10-13T20:58:00.000Z',
    ...overrides
  }
}

/** A workspace whose branch and worktree path derive from its name, status idle. */
export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  wsCounter += 1
  const name = overrides.name ?? `ha-${1430 + wsCounter}-retry-logic`
  return {
    id: `ws_01hzx${wsCounter.toString(36).padStart(7, '0')}`,
    projectId: 'prj_01hzw7q2m4nb',
    name,
    branch: name,
    path: `/Users/dev/.que/worktrees/uploader/${name}`,
    baseRef: 'origin/main',
    status: 'idle',
    statusReason: null,
    statusAt: '2026-10-13T21:04:30.000Z',
    lastActivityAt: null,
    sessionId: null,
    createdAt: '2026-10-13T21:04:00.000Z',
    archivedAt: null,
    prUrl: null,
    pr: null,
    ...overrides
  }
}

/** One workspace's line in the report: idle, 42 minutes of work, two commits ahead. */
export function makeWorkspaceDigest(overrides: Partial<WorkspaceDigest> = {}): WorkspaceDigest {
  const name = overrides.name ?? 'app-1432-retry-logic'
  return {
    id: 'ws_01hzx3k9c2qf',
    name,
    project: 'uploader',
    branch: name,
    status: 'idle',
    statusReason: null,
    firstActivityAt: '2026-10-14T01:00:00.000Z',
    lastActivityAt: '2026-10-14T01:42:00.000Z',
    workingMs: 42 * 60_000,
    needsInputCount: 0,
    waitingSince: null,
    stuckCount: 0,
    commitsAhead: 2,
    pr: null,
    sessionId: null,
    ...overrides
  }
}

/** A draft pull request with no checks yet and no review. */
export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/rquellh/que/pull/41',
    number: 41,
    title: 'Add retry logic to the uploader',
    state: 'draft',
    checks: 'none',
    review: null,
    checkRuns: [],
    updatedAt: null,
    checkedAt: '2026-10-14T01:00:00.000Z',
    ...overrides
  }
}

/** A queued task with a real brief, the default caps, and an opaque id. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  taskCounter += 1
  return {
    id: `tsk_01hzy${taskCounter.toString(36).padStart(7, '0')}`,
    projectId: 'prj_01hzw7q2m4nb',
    workspaceId: 'ws_01hzx3k9c2qf',
    title: 'Add retry logic to the uploader and cover it with tests',
    brief: 'Add retry logic to the uploader and cover it with tests.\nUse exponential backoff.',
    source: 'prompt',
    resumeSessionId: null,
    state: 'queued',
    reason: null,
    sessionId: null,
    pid: null,
    attempts: 0,
    costUsd: 0,
    turns: 0,
    maxTurns: 50,
    maxBudgetUsd: 5,
    permissionMode: null,
    branch: null,
    prUrl: null,
    resultText: null,
    lastActivityAt: null,
    startedAt: null,
    finishedAt: null,
    pausedUntil: null,
    createdAt: '2026-10-13T21:05:00.000Z',
    updatedAt: '2026-10-13T21:05:00.000Z',
    ...overrides
  }
}

/** A live terminal as term.list reports it, with a daemon-style UUID id. */
export function makeTermInfo(overrides: Partial<TermInfo> = {}): TermInfo {
  termCounter += 1
  const n = termCounter.toString(16).padStart(4, '0')
  return {
    id: `6f1c2a7e-${n}-4b8d-9a3e-5c0d7e21${n}`,
    name: 'zsh',
    cwd: '/Users/dev/code/uploader',
    cols: 80,
    rows: 24,
    pid: 51_200 + termCounter,
    alive: true,
    createdAt: `2026-10-13T21:${(10 + termCounter).toString().padStart(2, '0')}:00.000Z`,
    ...overrides
  }
}

/** Work hours: quiet hours on, the next window starting at 19:00 local. */
export function makeQuietState(overrides: Partial<QuietState> = {}): QuietState {
  return {
    enabled: true,
    inQuietHours: false,
    windowStart: null,
    windowEnd: null,
    nextBoundary: new Date(2026, 9, 13, 19, 0).toISOString(),
    unlockedUntil: null,
    unlockMinutes: 20,
    ...overrides
  }
}

/** The parsed defaults, as config.get reports them. */
export function makeUserConfig(overrides: Partial<UserConfig> = {}): UserConfig {
  return {
    worktreeRoot: '/Users/dev/.que/worktrees',
    stallTimeoutMinutes: 5,
    statusPollSeconds: 10,
    prPollSeconds: 60,
    repos: {},
    concurrency: 2,
    maxTurns: 50,
    maxBudgetUsd: 5,
    allowBypassPermissions: false,
    protectedBranches: ['main', 'master', 'release'],
    quietHours: {
      enabled: true,
      default: { start: '19:00', end: '07:00' },
      days: {},
      unlockMinutes: 20
    },
    notifications: { chimeOnComplete: true, chimeOnNeedsInput: false, morningSummary: false },
    jira: {
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      pollMinutes: 5,
      site: null,
      startPrompt: 'Read .que/ticket.md and propose a plan before changing anything.',
      projects: {}
    },
    startPrompt: '',
    summaries: true,
    summaryModel: 'haiku',
    summaryIntervalMinutes: 5,
    ...overrides
  }
}

/** A ticket assigned to the user, as tickets.list reports it. */
export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    key: 'APP-1432',
    summary: 'Add retry logic to the uploader',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    priority: 'Medium',
    type: 'Story',
    level: 'standard',
    parentKey: null,
    assigned: true,
    assignee: 'Ryan',
    projectKey: 'APP',
    projectName: 'Uploader',
    url: 'https://example.atlassian.net/browse/APP-1432',
    labels: [],
    updatedAt: '2026-10-14T01:12:00.000Z',
    syncedAt: '2026-10-14T01:15:00.000Z',
    workspaceId: null,
    ...overrides
  }
}

/** One changed file, as workspace.diff reports it. */
export function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/upload/put.ts',
    from: null,
    status: 'modified',
    additions: 12,
    deletions: 3,
    dirty: false,
    patch:
      'diff --git a/src/upload/put.ts b/src/upload/put.ts\n--- a/src/upload/put.ts\n+++ b/src/upload/put.ts\n@@ -1,3 +1,4 @@\n-const retries = 1\n+const retries = 3\n+const backoffMs = 250\n export {}\n',
    ...overrides
  }
}

/** One commit ahead of the base. */
export function makeDiffCommit(overrides: Partial<DiffCommit> = {}): DiffCommit {
  return {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    shortSha: 'a1b2c3d',
    subject: 'Retry uploads with backoff',
    author: 'Dev',
    at: '2026-10-14T13:40:00.000Z',
    ...overrides
  }
}

/** A workspace's diff against its base: two commits ahead, one file. */
export function makeWorkspaceDiff(overrides: Partial<WorkspaceDiff> = {}): WorkspaceDiff {
  return {
    workspaceId: 'ws_01hzx3k9c2qf',
    base: 'origin/main',
    head: 'app-1432-retry-logic',
    commitsAhead: 2,
    commits: [
      makeDiffCommit(),
      makeDiffCommit({
        sha: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
        shortSha: 'b2c3d4e',
        subject: 'Add the uploader',
        at: '2026-10-14T13:10:00.000Z'
      })
    ],
    bases: ['origin/main', 'main'],
    commit: null,
    files: [makeDiffFile()],
    generatedAt: '2026-10-14T14:00:00.000Z',
    ...overrides
  }
}

/** A worktree's listing: a small tree with the diff fixture's file in it. */
export function makeWorkspaceFiles(overrides: Partial<WorkspaceFiles> = {}): WorkspaceFiles {
  return {
    workspaceId: 'ws_01hzx3k9c2qf',
    files: [
      'README.md',
      'package.json',
      'src/index.ts',
      'src/upload/retry.ts',
      'src/upload/retry.test.ts',
      'tests/e2e/upload.spec.ts'
    ],
    truncated: false,
    generatedAt: '2026-10-14T14:00:00.000Z',
    ...overrides
  }
}

/** One text file of the worktree. */
export function makeWorkspaceFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  const content = overrides.content === undefined ? 'export const retries = 3\n' : overrides.content
  return {
    workspaceId: 'ws_01hzx3k9c2qf',
    path: 'src/index.ts',
    content,
    binary: false,
    size: content === null ? 0 : new TextEncoder().encode(content).length,
    truncated: false,
    ...overrides
  }
}

/** One check run on a pull request's head. */
export function makePrCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return {
    name: 'build',
    source: 'CI',
    state: 'passing',
    url: 'https://github.com/rquellh/que/actions/runs/1',
    startedAt: '2026-10-14T01:00:00.000Z',
    completedAt: '2026-10-14T01:04:00.000Z',
    ...overrides
  }
}

let prEntryCounter = 0

/** One entry of a pull request's conversation: an issue comment by default. */
export function makePrThreadEntry(overrides: Partial<PrThreadEntry> = {}): PrThreadEntry {
  prEntryCounter += 1
  return {
    id: `c${prEntryCounter}`,
    kind: 'comment',
    author: 'reviewer',
    body: 'Looks good, one question about the retry cap.',
    at: '2026-10-14T02:00:00.000Z',
    url: `https://github.com/rquellh/que/pull/41#issuecomment-${prEntryCounter}`,
    state: null,
    path: null,
    line: null,
    hunk: null,
    ...overrides
  }
}
