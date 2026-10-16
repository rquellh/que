# que

que is a macOS app for running Claude Code sessions in git worktrees: every task
gets its own branch and folder, and its terminals live in a background daemon,
so they keep running when you close the window. An overnight queue runs briefs
headless while you sleep and leaves draft pull requests and a morning report. A
quiet mode, during the hours you choose, only tells you that things are running
and not stuck, and hides everything else.

## Features

- **Workspaces**: one git worktree per task, with per-repo setup from `que.toml`.
- **Terminals that outlive the app**: quit and relaunch, and every screen comes back.
- **Live status** for each session (working, idle, needs input, stuck), from Claude
  Code hooks that que passes per session; your own settings are never edited.
- **The overnight queue**: `que add` a brief, `que run`, and in the morning find
  pushed branches, draft pull requests, and a report of what happened.
- **Quiet mode**: quiet hours enforced by the daemon, a board with counts only,
  and an unlock with a reason when you really need to look.
- **A CLI** for everything the app does, and a menu-bar title (`● 3 ▸ 1 ✕ 0`).

## Install

Download `que-<version>-arm64.dmg` from
[Releases](https://github.com/rquellh/que/releases) and drag que to Applications.
macOS on Apple Silicon is required.

Builds are not signed yet, so macOS blocks the first launch. Open it anyway from
**System Settings → Privacy & Security → Open Anyway**, or clear the quarantine
flag:

```sh
xattr -dr com.apple.quarantine /Applications/que.app
```

Then choose **que → Install 'que' command in PATH** to get the CLI. It links into
`/usr/local/bin` when that is writable and `~/.local/bin` otherwise.

You also need Claude Code (`claude`) and git on your PATH; `gh`, logged in, lets
overnight tasks open pull requests.

## First run

```sh
que doctor                     # checks the daemon, claude, gh, git, config, hooks
que project add ~/code/uploader
que work "Add retry logic" -r ~/code/uploader --name app-142-retry   # a worktree on branch app-142-retry
que attach app-142-retry       # or click it in the app's sidebar
claude                         # in the workspace terminal; its status shows in the sidebar
```

## Overnight

```sh
que add -r ~/code/uploader "Add retry with backoff to the uploader; keep the tests green"
que add -r ~/code/uploader -f briefs/upload-limits.md --max-turns 30 --max-budget 3
que run                        # open the queue; tasks run two at a time by default
que report                     # in the morning: done, stuck, failed, PRs, cost
```

Each task runs `claude -p` in a fresh workspace with turn and dollar caps and a
stall timeout, pauses through rate limits, keeps the Mac awake while it works,
and finishes by committing, pushing its branch, and opening a draft pull request.
Nothing is ever pushed to the default branch or a protected one.

## Quiet mode

From 19:00 to 07:00 by default, the app swaps its terminals for a quiet board:
how many tasks are running, paused, stuck and done, and nothing to click but
Unlock. The daemon refuses terminal contents, reports and new work to every
client during those hours, so the CLI cannot peek either. `que unlock 15 --why
"deploy check"` (or the board's button) shows everything for a while; `que lock`
ends it early. When the window ends, `que report` (or the app's report view)
shows what the night did; `notifications.morning_summary` adds a notification.

## Configuration

`~/.config/que/config.toml` (or `$QUE_CONFIG`); `que config set key=value` edits
it and the daemon reloads at once. Every key, with its default
([details](docs/configuration.md)):

<!-- generated:config-defaults -->
```toml
# ~/.config/que/config.toml (or $QUE_CONFIG). Every key is optional;
# these are the defaults.
worktree_root = "~/.que/worktrees"
stall_timeout_minutes = 5
status_poll_seconds = 10
pr_poll_seconds = 60
concurrency = 2
max_turns = 50
max_budget_usd = 5
# default_permission_mode = "acceptEdits"   # unset: que.toml or Claude Code decides
allow_bypass_permissions = false
protected_branches = ["main", "master", "release"]
start_prompt = ""                    # empty: Claude starts on the brief itself
# instructions_file = "~/.config/que/instructions.md"   # unset: no instructions

[quiet_hours]
enabled = true
default = ["19:00", "07:00"]
unlock_minutes = 20
# friday = ["21:00", "09:00"]   # a per-day override (sunday … saturday)
# saturday = "none"             # no quiet hours that night

[notifications]
chime_on_complete = true
chime_on_needs_input = false
morning_summary = false

[jira]
jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"
poll_minutes = 5
start_prompt = "Read .que/ticket.md, the ticket this workspace is for. Restate the goal in a sentence, look at the code it touches, and propose a plan before changing anything."
# [jira.projects]                # learned the first time you pick a project for a ticket
# APP = "uploader"               # tracker project key = que project name

# [repos.uploader]               # a name for `que work -r uploader`
# path = "~/code/uploader"
# default_branch = "main"
```
<!-- /generated -->

Per repository, `que.toml` at the repo root (none of these keys has a default):

<!-- generated:repo-example -->
```toml
# <repo>/que.toml. Every key is optional; none has a default.
setup = "npm ci"                       # run inside a new worktree
teardown = "./scripts/teardown.sh"     # run inside a worktree before removal
default_branch = "main"                # base for new workspaces (else origin's HEAD)
worktree_include = [".env.local"]      # gitignored files copied into new worktrees
permission_mode = "acceptEdits"        # default | acceptEdits | plan | bypassPermissions | dontAsk | auto
test = "npm test"                      # the command a task must make pass
instructions = "Keep changes small."   # appended to every task brief for this repo
allowed_tools = ["Bash(npm test)"]     # passed to claude as --allowedTools
```
<!-- /generated -->

## CLI

Generated from `que --help`; options and arguments are in [docs/cli.md](docs/cli.md).

<!-- generated:cli-table -->
| Command | What it does |
| ------- | ------------ |
| `que daemon start [options]` | start the daemon if it is not running |
| `que daemon stop [options]` | kill all terminals and stop the daemon |
| `que daemon status [options]` | show whether the daemon is running |
| `que daemon install [options]` | install a launchd agent that keeps the daemon running |
| `que daemon uninstall [options]` | remove the launchd agent |
| `que term list [options]` | list terminals |
| `que term new [options]` | create a terminal running a login shell |
| `que term snapshot [options] <id>` | print the terminal screen and scrollback |
| `que term kill [options] <id>` | kill a terminal |
| `que term attach [options] <id>` | attach this TTY to a terminal (Ctrl-] detaches) |
| `que project add [options] <path>` | register a git repository |
| `que project list [options]` | list projects |
| `que work [options] [brief]` | create a workspace (git worktree) from a brief and print its path; the first line of the brief is its title, and its branch and folder get a random three-word name unless --name is given |
| `que ws list [options]` | list workspaces |
| `que ws remove [options] <workspace>` | remove a workspace: kill its terminals, run teardown, remove the worktree |
| `que ws diff [options] <workspace>` | what a workspace changed against its base, committed and uncommitted, with its commits |
| `que ws files [options] <workspace>` | every file of a workspace's worktree, tracked and untracked, never ignored |
| `que ws pr [options] <workspace>` | a workspace's pull request: its checks and its conversation |
| `que ws terminal [options] <workspace>` | print the id of the workspace's latest live terminal, opening one if needed |
| `que status [options]` | summary and per-workspace status |
| `que attach [options] <workspace>` | attach to the workspace's latest terminal, opening one if needed (Ctrl-] detaches) |
| `que open [options] <workspace>` | open the workspace with `code -n` |
| `que add [options] [brief]` | queue an overnight task (a brief run headless by claude in its own workspace) |
| `que task list [options]` | list tasks |
| `que task show [options] <id>` | show one task |
| `que task stop [options] <id>` | stop a task (kills its claude run) |
| `que task remove [options] <id>` | forget a task that is no longer live |
| `que run [options]` | open the queue: run queued tasks until it is closed |
| `que queue close [options]` | stop starting queued tasks (running ones finish) |
| `que queue status [options]` | show the queue |
| `que report [options]` | the morning report: what the queue did |
| `que tickets list [options]` | list the cached tickets (the default) |
| `que tickets sync [options]` | fetch the queue from the tracker now |
| `que tickets start [options] <key>` | make a workspace for a ticket, write it as a brief, and start claude on it |
| `que tickets open [options] <key>` | open a ticket's page in the browser |
| `que unlock [options] [minutes]` | unlock detail during quiet hours for a while (default: quiet_hours.unlock_minutes) |
| `que lock [options]` | end an unlock early |
| `que quiet status [options]` | whether quiet hours are on, until when, and any unlock |
| `que config get [options]` | print the config file path and the parsed config |
| `que config set [options] <assignments...>` | set keys (dotted, e.g. quiet_hours.default=19:00,07:00) and reload the daemon |
| `que hook [options]` | report a Claude Code hook event (stdin JSON) to the daemon; used by hooks.json |
| `que doctor [options]` | check the daemon, claude, gh, git, caffeinate, node, config, and the hooks wrapper |
<!-- /generated -->

## Development

```sh
npm ci            # Node 24; also prepares node-pty for Electron
npm run dev       # the app with hot reload
npm run verify    # typecheck, lint, build, vitest, smoke, playwright; stops at the first failure
npm run package   # an unsigned que.app in release/mac-arm64
npm run dist      # the DMG and zip
```

| Path | What lives there |
| ---- | ---------------- |
| `src/daemon/` | the daemon: terminals, workspaces, status engine, task queue, quiet hours, SQLite |
| `src/shared/` | the socket protocol, the client, paths, config |
| `src/cli/` | the `que` CLI |
| `src/main/`, `src/preload/`, `src/renderer/` | the Electron app |
| `tests/` | daemon integration tests, Playwright specs, subprocess fakes |
| `scripts/` | build, smoke, packaged smoke, soak, flake hunt, docs, release |

How the pieces fit: [docs/architecture.md](docs/architecture.md). How it looks and why:
[docs/design.md](docs/design.md). Tests follow the
three guides in `.claude/skills/` (`test-planning`, `vitest-testing`,
`e2e-testing`); see [CONTRIBUTING.md](CONTRIBUTING.md). What is next:
[ROADMAP.md](ROADMAP.md).

## License

[Apache-2.0](LICENSE) © 2026 Ryan Quellhorst
