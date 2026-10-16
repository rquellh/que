# Architecture

que is three kinds of process around one long-lived daemon. The daemon owns
everything that must outlive a window: terminals, workspaces, the overnight
queue, statuses, and quiet hours. The app and the `que` CLI hold no state of
their own; they are clients of the daemon's unix socket and can come and go.

```
  que.app (Electron)                          que CLI          Claude Code session
  ┌───────────────────────────┐            ┌──────────┐      ┌──────────────────────┐
  │ renderer (React, xterm)   │            │ commander│      │ hooks → `que hook`   │
  │   │ window.que (preload)  │            └────┬─────┘      └──────────┬───────────┘
  │ main: proxy, tray, board  │                 │                       │
  └────────────┬──────────────┘                 │                       │
               │   newline-delimited JSON over ~/.que/daemon.sock        │
               └───────────────┬────────────────┴───────────────────────┘
                               ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ daemon (Electron binary as Node: ELECTRON_RUN_AS_NODE=1)                       │
  │  DaemonServer ─ quiet gate ─┬─ PtyHost: node-pty + headless xterm mirrors     │
  │                             ├─ Workspaces: projects, git worktrees, setup     │
  │                             ├─ Status engine: hooks + ticks → workspace status│
  │                             ├─ Task queue: dispatcher, runner, finisher       │
  │                             └─ Store: SQLite (node:sqlite) in QUE_HOME        │
  └──────────────────────────────────────────────────────────────────────────────┘
          │ spawns                         │ spawns                    │ spawns
      login shells                 claude -p (stream-json)         git, gh, caffeinate
```

## The daemon

`src/daemon/index.ts` starts once per `QUE_HOME`. Clients find it through the
socket; if the socket is missing or stale, `DaemonClient.connectOrStart()`
spawns the daemon detached and waits for `daemon.ping`. It runs under the
Electron binary with `ELECTRON_RUN_AS_NODE=1`, so `node-pty` is the one native
module and it is built once, for Electron's ABI. In the packaged app the daemon,
CLI and client bundles live in `que.app/Contents/Resources/{daemon,cli,client}`
and `node-pty` in `Resources/daemon/node_modules`, outside the asar archive.
`que daemon install` adds an opt-in launchd agent that starts it at login.

Quitting the app closes a socket connection and nothing more: terminals and
tasks keep running, and the next window reattaches.

## The protocol

`src/shared/protocol.ts` is the contract. Requests are `{ id, method, params }`,
responses echo the `id` with `result` or a structured `error` (`code`,
`message`), and events are `{ event, data }` pushed to every connection. The
`Methods` and `Events` maps type every call end to end: the daemon's handlers,
`DaemonClient.request()`, the CLI, the main process allow-list, and the preload
bridge the renderer sees (`src/preload/index.d.ts`). Framing is a line splitter
that copes with chunks split anywhere, including inside a multi-byte character.

## Terminals

`PtyHost` runs each terminal as a node-pty process and feeds every byte into a
headless xterm as well as to subscribers. Attaching takes a serialized snapshot
of that mirror (screen, scrollback, modes) and then streams live data, with
anything that arrives during the snapshot buffered so nothing is lost or
duplicated. That is what lets a relaunched app, or `que attach` in another
terminal, pick up exactly where the screen was.

## Workspaces and the hooks wrapper

A project is a registered git repository; a workspace is a git worktree on its
own branch under `worktree_root`, with the repo's `que.toml` setup command run
inside it. Workspace terminals start with `<QUE_HOME>/bin` first on `PATH`.
That directory holds two small scripts the daemon writes at startup:

- `claude` runs the `claude` the daemon resolved (`QUE_REAL_CLAUDE`, else the
  next one down `PATH`) and, inside a que workspace, adds
  `--settings <QUE_HOME>/hooks.json`. Outside one it is transparent. The
  user's own settings files are never written. If what it runs is another
  tool's wrapper that hands the command back (wrappers exec, so the pid is the
  same), it skips what it already tried and does not add `--settings` twice;
  a chain that keeps going fails with a message instead of looping.
- `que` runs the bundled CLI (with the app's own binary in a packaged build).

`hooks.json` registers `que hook` for every hook event, so each event a session
fires arrives at the daemon as JSON on stdin, tagged with the workspace it ran in.

## What a process que starts can see

The daemon, every terminal, and every headless run get a cleaned copy of the
environment (`src/shared/env.ts`): the markers a running coding-agent session
leaves in the shells it spawns are removed, so a session started in que is a
normal top-level one; the identity of whichever terminal emulator launched que
is removed, so programs pick generic terminal features that an embedded xterm
serves; app internals go too. `QUE_TERMINAL=1` is set. The user's own
configuration (an alternate config directory, provider selectors, limits) is
kept.

The app resolves the login shell's PATH once at start (`src/shared/login-path.ts`)
and merges it in front of its own, and the daemon and editor launches inherit
it, so a Finder launch finds the same tools a terminal does. `que doctor`
reports what is on the daemon's PATH.

## The status engine

`status-engine.ts` is a set of pure functions: a hook event, a terminal exit,
a clock tick, or a `claude agents --json` entry goes in with the previous
status and `now`; the next status comes out. A prompt or tool use means
working, a stop means idle, a permission prompt means needs input, and no sign
of life for `stall_timeout_minutes` (a transcript file growing counts as life)
means stuck. `status.ts` runs those rules per workspace, persists transitions,
and emits `workspace.status`. Nothing in the rules reads the clock, so they are
tested exhaustively as plain functions.

## The overnight digest

Every change of a workspace's status or reason is also appended to the
`workspace_status_log` table (and its creation, as `preparing`); rows older than
30 days are pruned as new ones arrive, and a workspace's rows go with it. The
morning report, `que report` and the morning summary build on that log, so they
cover interactive sessions as well as queued tasks. `digest.ts` turns one
workspace's log rows for the window (plus the last row before it, so time already
spent in a state when the window opened counts) into a `WorkspaceDigest`: time
spent working, how many times it asked for input, whether it is still waiting and
since when, how many times it got stuck, its pull request, and its commits ahead
of base. Commits ahead are counted against `origin/<default branch>` when that
ref exists, else the base the workspace was created from. Workspaces that did
nothing in the window and are not working, waiting or stuck are left out; the
rest are sorted with those needing input first, then stuck, then working.

## Pull request tracking

`prs.ts` keeps `Workspace.pr` fresh. Every `pr_poll_seconds` (default 60) it
asks `gh pr list --head <branch> --state all --limit 1` in each unarchived,
unprotected workspace, one call at a time; a merged or closed pull request is
re-checked only every fifth time. `pr-state.ts` maps the answer to state
(draft, open, merged, closed), checks (none, pending, passing, failing) and
review decision. When the result differs from the stored one (ignoring
`checkedAt`) it is saved in `pr_json` and `workspace.updated` is emitted. A
failed `gh` keeps the stored value and logs one line until a call succeeds
again. A successful `workspace.createPr` and a task reaching `done` trigger an
immediate check of that workspace.

Each check run and commit status from the rollup is kept too, as
`PullRequest.checkRuns`: name, workflow, state (failing, pending, passing,
skipped), link and times, failing first. The `checks` summary is derived from
them, and a run that changes counts as a change, so `workspace.updated` fires
when a check finishes even though `updatedAt` stays put.

`workspace.prThread` (`que ws pr`) answers the conversation: issue comments and
reviews from `gh pr view <n> --json comments,reviews`, line comments from
`gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate`, parsed by
`pr-thread.ts` and sorted oldest first. Threads are fetched on demand, never
polled: each workspace's thread is cached with the pull request number and
`updatedAt` it was fetched for, and reused until the tracker stores a different
one (or the caller passes `refresh`). Concurrent calls share one fetch. A failed
`gh` raises `gh_failed` and caches nothing; the cache entry goes when the
workspace is removed or its pull request disappears.

## The diff view

`workspace.diff` (`que ws diff`) compares a workspace against its base: `origin/<default>` when that remote ref exists, else the default branch, unless the caller names another ref as `base` (`--base`), which must resolve to a commit. Everything is measured from the merge base of the base and `HEAD`, so committed and uncommitted changes appear together, and untracked files are listed too. Each file carries its status, line counts, whether it is still uncommitted, and a unified patch (null for binary files and patches over 200,000 characters). The result also lists the branch's commits past the base, newest first (at most 200), and the refs worth comparing against: the base, the default branch here and on origin, then the other local and origin branches, never the workspace's own (at most 50). Given a `commit` (`--commit`) that is on the branch and not on the base, the files narrow to that commit's own changes, against its parent (or the empty tree for a root commit), with nothing from the working tree; the commit count and list still describe the whole branch. A base or commit that does not qualify is a `bad_request`. It only reads: `git diff`, `git status`, `git log`, `git ls-files`, and `git for-each-ref`. Quiet hours refuse it like any other workspace read.

`workspace.files` (`que ws files`) lists every file of a workspace's worktree that git would show: tracked and untracked, never ignored (`git ls-files --cached --others --exclude-standard`), deduplicated and sorted, cut at 20,000 paths with `truncated` set; a missing worktree lists nothing. `workspace.readFile` reads one of them for the file view. The path must be relative and strictly inside the worktree: an absolute path, the root itself, or any empty, `.` or `..` segment is a `bad_request`, and so is a path whose real location, symlinks followed, falls outside the worktree's real root, or a directory. A missing path is `not_found`. A NUL byte in the first 8 KB marks the file binary and its content null; text is decoded as UTF-8 and cut at 500,000 characters with `truncated` set; `size` is always the byte size on disk. Both only read, and quiet hours refuse them like any other workspace read.

In the app, Changes and Files follow `workspace.changed` for the workspace on screen: while the review pane or one of its diff or file tabs is open, the store fetches the diff again in its scope (the base and commit stay), and while Files or a file tab is open, the listing and every open file tab too. A change that arrives during that fetch is followed once more after it lands; a closed pane with no view tabs fetches nothing until it opens, and a failure is kept for the views as any other. The Files tree keeps the directories the user opened and closed, except that a directory that newly holds a changed file opens.
`workspace.changed { id }` tells clients a workspace's worktree changed, so they can ask for the diff or the files again; the event carries nothing else and the daemon computes nothing for it. The daemon watches a workspace only while a window shows it or some connection is attached to one of its live terminals. The app says which workspace a window shows with `workspace.watch { id }` when it shows one and `workspace.unwatch { id }` when it leaves it, so the watch holds while a diff or a file tab covers the terminal; the daemon keeps the ids per connection. A watch or an attach starts the watch, and it stops when no connection wants the workspace any more: an unwatch, the last detach, the terminal's exit or kill, the connection closing, or the workspace's removal; shutdown closes every watch. Each watched workspace has two recursive watches. One is the worktree, ignoring the `.git` entry and everything under it. The other is the gitdir: a linked worktree's `.git` is a file whose `gitdir:` line points into the repository's `.git/worktrees/<name>`, which is where a commit, checkout or reset writes, and a main worktree's `.git` is the gitdir itself. Only `HEAD`, `ORIG_HEAD`, `index`, `packed-refs` and anything under `logs/` and `refs/` count there, so object writes do not. The first change that counts opens a 300 ms window and the event goes out when it closes, once per window per workspace however many changes it held.

## The ticket queue

`tickets.ts` keeps the tickets assigned to the user in the `tickets` table, the
way the pull request service keeps pull requests. It never writes to the
tracker. The tracker is read through the user's own `acli` (already signed in):
every `jira.poll_minutes` (first run a second after the daemon starts) it runs
`acli jira workitem search --jql <jira.jql> --json --fields key,summary,status,priority,issuetype,assignee,labels`
(the search refuses any other field, so the project comes from the key's prefix and there is
no updated time), upserts what came back,
drops tickets that vanished unless a workspace was started for them, and emits
`tickets.synced`. The queue keeps the order the search returned (a `position` column), so the
JQL's `ORDER BY` decides it. A failure stores the first line of stderr in the `kv` table as
the sync error (the list stays), logs once, and is cleared by the next success.
`tickets.list` only reads the cache.

Ticket links are `https://<site>/browse/<key>`, with the site from `[jira] site` or else from
`acli jira auth status` (read once per sync and cached; the search's `self` URLs point at an
internal API host). The search cannot return a ticket's parent, so after it the daemon runs
`workitem view KEY --fields parent` for every non-epic ticket whose parent was never checked
or was checked over a day ago (at most four at a time; a failure is logged and retried next
sync) and stores `parent_key` and `parent_checked_at`. A parent the search did not return is
kept as a synthesized ticket (`assigned = false`) built from the view's parent fields; it takes
the position of its first child, just before it, and is dropped when no ticket points at it any
more. Epics are overviews: `tickets.start` refuses them, and a started ticket's brief ends
with its parent's summary and description.

`tickets.start` fetches the full ticket with `acli jira workitem view`, flattens
its description (`adf-text.ts`) and renders a brief. The ticket's tracker project
picks the que project through `[jira.projects]`; with no mapping the daemon
answers `needs_project` and does nothing, and once the caller passes a project
the choice is written back to the config. The workspace is named
`<key>-<summary slug>`; the brief goes to `<worktree>/.que/ticket.md` (with
`.que/` added to the repository's `info/exclude`), and a terminal in the
workspace is typed `claude '<jira.start_prompt>'`. A second start reuses the
workspace. A loose session instead gets the brief at `<QUE_HOME>/tickets/<KEY>.md`
and a terminal in the home directory. Starting is refused in quiet hours.

A workspace can also start from a brief. `workspace.create` without a `name`
draws a random three-word name (`adjective-adjective-noun`, `names.ts`) for the
workspace, branch and folder, drawing again on a clash up to 50 times; an
explicit name is refused on a clash instead. The new-workspace dialog prefills
such a name and lets the user draw another or type their own, which it sends as
the explicit name. Tasks get random names too; tickets pass their own name. The
title is the given one, else the brief's first line (`brief.ts`), and is what the
sidebar shows; the brief goes verbatim to `<worktree>/.que/brief.md`.
`workspace.start` opens the workspace's first terminal when it has none, answers
with it, and once setup has ended types the command that starts Claude. By
default the brief is the first prompt: `claude "$(cat '<worktree>/.que/brief.md')"`,
so the shell hands it over verbatim. With `start_prompt` set, that text is sent
instead (`claude '<start_prompt>'`; it can tell Claude to read `.que/brief.md`),
and a workspace without a brief gets a bare `claude`. `workspace.rename`
changes the title and, for a branch with no `origin/<branch>`, can rename the
branch to a name the user gives; the folder keeps its name.

## The task machine

An overnight task moves `queued → preparing → running → finishing → done`, and
may end `stuck`, `failed`, or `stopped`, or rest `paused` while a rate limit
lasts. `task-machine.ts` is one pure function from a task and an event (a
stream-json message, a hook, an exit, a tick) to the next task. Around it:

- the **dispatcher** starts queued tasks up to `concurrency` while the queue is open;
- the **runner** prepares a fresh workspace, runs `claude -p` with stream-json
  output, turn and dollar caps, and que's system prompt, and kills the run when
  the machine says so (caps, stall, stop);
- the **finisher** commits what the agent left, pushes the task branch (never
  the default or a protected branch), and opens a draft pull request with `gh`;
- a **keep-awake** (`caffeinate -i -w <daemon pid>`) is held while any task is
  active, and the clock tick resumes paused tasks when their limit resets;
- the **report** groups the night's tasks by outcome for `que report` and the app.

## Quiet enforcement

Quiet hours are enforced in the daemon, not the UI, so no client can see past
them. While a window is in progress and not unlocked, the server refuses the
detail methods (terminal attach and snapshot, reports, new tasks and
terminals) with a `quiet_hours` error and drops every live terminal
subscription the moment the window starts. Status, counts and the queue keep
working, which is all the quiet board needs: it answers "is it running, and is
it stuck?" and nothing else. An unlock lasts `unlock_minutes`, is logged with
its reason, and ends on its own. A config edit made during a window never
shortens tonight's window unless asked to. When the window ends, the daemon
emits one morning summary.

## The app

The main process proxies an allow-list of methods and forwards events to the
renderer, keeps the menu-bar title (`● 3 ▸ 1 ✕ 0`), shows the quiet board window
while locked, and checks once a day for a newer release. The renderer only
ever talks to `window.que`, which is why its component tests can run against
an in-memory fake of that bridge.
