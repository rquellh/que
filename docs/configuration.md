# Configuration

que reads two TOML files. Both are optional: with neither, everything below is
the default. The code blocks marked _generated_ are written by
`scripts/config-reference.mjs` from the defaults in `src/shared/config.ts`
(`npm run docs`), so they cannot drift from what the daemon actually uses.

## The user config: `config.toml`

Location: `~/.config/que/config.toml`, or the path in `$QUE_CONFIG`.
`que config get` prints the path and the parsed values; `que config set key=value`
edits it (dotted keys, e.g. `quiet_hours.default=19:00,07:00`) and the daemon
reloads it at once. Settings in the app write the same file.

_Generated:_

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

| Key | Meaning |
| --- | ------- |
| `worktree_root` | Where workspaces (git worktrees) are created: `<root>/<project>/<workspace>`. |
| `stall_timeout_minutes` | A working session or task with no sign of life for this long is marked stuck. |
| `status_poll_seconds` | How often the daemon cross-checks live sessions with `claude agents --json`. |
| `pr_poll_seconds` | How often the daemon refreshes each workspace's pull request from GitHub (merged and closed ones every fifth time). |
| `concurrency` | How many overnight tasks run at once while the queue is open. `que run -j` overrides it until the queue closes. |
| `max_turns`, `max_budget_usd` | Default caps for a task (`que add --max-turns/--max-budget` override them per task). |
| `default_permission_mode` | Permission mode for headless runs and workspace sessions when a repo's `que.toml` sets none. |
| `allow_bypass_permissions` | Must be `true`, and the repo must opt in, before a task may run with `bypassPermissions`. |
| `protected_branches` | Branches the finisher never pushes, besides each project's default branch. |
| `start_prompt` | Empty by default: a workspace made from a brief (New workspace with "Start Claude with this brief" on) starts `claude` with the brief itself as the first prompt. Set it to send this text instead; the brief is in `.que/brief.md`, so the text can tell Claude to read it. |
| `instructions_file` | A file appended to the system prompt of every session started in a workspace (see [Instructions](#instructions)). Absolute, or starting with `~`; empty means unset. |
| `quiet_hours.enabled` | Quiet mode on or off. |
| `quiet_hours.default` | The nightly window, `[start, end]` in local 24-hour time. It may cross midnight. |
| `quiet_hours.<day>` | A per-day override (`sunday` … `saturday`, keyed by the day the window starts): a window, or `"none"`. |
| `quiet_hours.unlock_minutes` | How long `que unlock` (or the board's Unlock button) shows detail. |
| `notifications.chime_on_complete` | A soft chime when a session finishes a turn or a task finishes (work hours only). |
| `notifications.chime_on_needs_input` | A chime when a session asks for input (work hours only). |
| `notifications.morning_summary` | One notification with the night's totals when quiet hours end. |
| `jira.jql` | The filter for the ticket queue, run with `acli jira workitem search`. The default is the tickets assigned to you that are not done, newest first. |
| `jira.poll_minutes` | How often the daemon refreshes the queue from the tracker. |
| `jira.site` | The tracker's host (`team.example.net`, or a URL) that ticket links are built on. By default que reads it from `acli jira auth status`; set it if that is wrong or unavailable. |
| `jira.start_prompt` | The first prompt typed into `claude` when a ticket is started. |
| `jira.projects.<KEY>` | The que project (by name) a tracker project's tickets get their workspaces in. que writes it the first time you choose; edit it to change your mind. |
| `repos.<name>.path` | A name for a repository, so `que work -r <name>` and `que add -r <name>` resolve it. |

Edits made during quiet hours never shorten the window in progress; pass
`--apply-tonight` to `que config set` to apply them at once.

## Instructions

`instructions_file` gives a reusable policy for every session (model delegation
rules, house conventions) a home. Set it with `que config set
instructions_file=~/.config/que/instructions.md`, or in Settings → Instructions,
which also edits the file itself.

Every workspace terminal the daemon opens exports two variables, read from the
current config, so new terminals see a change without a restart:

| Variable | Meaning |
| -------- | ------- |
| `QUE_INSTRUCTIONS` | The absolute path of `instructions_file`, set whenever the key is, even before the file exists. |
| `QUE_PERMISSION_MODE` | The repo's `que.toml` `permission_mode`, else `default_permission_mode`; absent when neither is set. `bypassPermissions` needs the same two opt-ins as a task. |

Inside a workspace, que's `claude` wrapper (`<QUE_HOME>/bin/claude`) then adds
`--append-system-prompt-file "$QUE_INSTRUCTIONS"` when the file exists, and
`--permission-mode "$QUE_PERMISSION_MODE"` unless your own arguments (up to a
`--`) already pass `--permission-mode` or `--dangerously-skip-permissions`.

Claude Code records the system prompt on a conversation's first request, so an
edit applies to new sessions; a resumed session picks it up after it compacts.

## The repository config: `que.toml`

Put `que.toml` at the root of a repository. A `.worktreeinclude` file next to it
(one path per line, `#` comments) adds to `worktree_include`.

_Generated (an example; none of these keys has a default):_

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

## Environment variables

| Variable | Meaning |
| -------- | ------- |
| `QUE_HOME` | que's state directory (default `~/.que`): socket, database, logs, worktrees, the hooks wrapper. |
| `QUE_CONFIG` | The user config path (default `~/.config/que/config.toml`). |
| `QUE_NODE` | The `node` that the hooks wrapper's `que` runs in development builds. |
| `QUE_REAL_CLAUDE` | The `claude` executable workspace terminals run. The daemon sets it to the first `claude` on its own `PATH`; set it in the daemon's environment when that is not the one you want. |
| `QUE_INSTRUCTIONS`, `QUE_PERMISSION_MODE` | Set by the daemon in workspace terminals for the `claude` wrapper; see [Instructions](#instructions). |
| `QUE_UPDATE_CHECK` | `0` turns off the app's daily check for a newer release. |
