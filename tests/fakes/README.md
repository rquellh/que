# Subprocess fakes

`tests/fakes/bin/` holds stand-ins for the external programs que spawns. Tests put
the directory **first on `PATH`** (`vi.stubEnv('PATH', ...)` in Vitest, `testEnv()`
in Playwright), so the daemon, the CLI, and the app find these instead of the real
binaries. `git` is never faked: tests use real repos in temp dirs. All of them are
dependency-free Node scripts.

## `claude`

Parses the flags que uses (`-p`, `--output-format text|json|stream-json`, `--verbose`,
`--include-hook-events`, `--settings`, `--session-id`, `--resume`, `--max-turns`,
`--max-budget-usd`, `--permission-mode`, `--permission-prompts`, `--allowedTools`,
`--append-system-prompt-file`, `--model`, `--version`) and `agents --json`. Unknown
flags are ignored. Like the real CLI, `-p` with `stream-json` requires `--verbose`.

**Hooks.** Every `command` hook in the `--settings` `hooks` map (inline JSON or a
file) runs through `/bin/sh -c` with the session cwd and the inherited env, with
the hook JSON on stdin (`hook_event_name`, `session_id`, `cwd`, `transcript_path`,
`permission_mode`, plus the per-event fields). Matchers are honoured. A
`PreToolUse` hook exiting 2 blocks the tool.

**Headless scenarios** (`QUE_FAKE_CLAUDE_SCENARIO`, default `success`), one
message every `QUE_FAKE_CLAUDE_DELAY_MS` (default 30):

| Scenario      | Stream / hooks                                                                                     | Exit           |
| ------------- | -------------------------------------------------------------------------------------------------- | -------------- |
| `success`     | init, SessionStart, UserPromptSubmit, assistant + `Write` of `que-fake-change.txt`, Stop, `result` | 0              |
| `stall`       | init, SessionStart, UserPromptSubmit, one assistant, then hangs                                    | 143 on SIGTERM |
| `rate_limit`  | init, hooks, `rate_limit_event`, `system/api_retry`, StopFailure (`rate_limit`), then hangs        | 143 on SIGTERM |
| `max_turns`   | init, hooks, one assistant, `result` `error_max_turns`                                             | 1              |
| `crash`       | init, SessionStart, `fake claude: simulated crash` on stderr                                       | 1              |
| `needs_input` | init, hooks, Notification `permission_prompt`, then hangs                                          | 143 on SIGTERM |

A `[que-fake-scenario:<name>]` marker anywhere in the prompt picks the scenario
for that run instead of the env, so one daemon can run tasks with different
scenarios.

`rate_limit` behaves as `success` when `QUE_FAKE_CLAUDE_RESUME_OK=1` and
`--resume` was passed. Its `rate_limit_event` reports `resetsAt` as now plus
`QUE_FAKE_CLAUDE_RESET_SECONDS` (default 3600), in epoch seconds.

With `QUE_FAKE_CLAUDE_COMMIT=1`, `success` also runs `git add` and `git commit`
on the file it wrote (an agent that commits its work); without it the change is
left uncommitted in the working tree.

**One-shot text** (`-p` with an explicit `--output-format text`, as que's sidebar-title
summariser runs it): prints `$QUE_FAKE_CLAUDE_SUMMARY` (default `Fake summary of the
session`) and a newline, exits 0, and runs no scenario, hooks, or transcript. The call is
still logged to `QUE_FAKE_CLAUDE_LOG`, prompt included in `argv`. Without the flag, `-p`
runs the headless scenarios above.

**Interactive mode** (no `-p`): prints a banner and `> `; each line fires
UserPromptSubmit, a fake `Read` (Pre/PostToolUse), a reply, and Stop.
`/needs-input` fires UserPromptSubmit, then the permission Notification, and waits for `y`; `/exit` fires
SessionEnd and exits 0.

Other knobs: `QUE_FAKE_CLAUDE_TRANSCRIPT_DIR` (where `<session_id>.jsonl`
transcripts go; default under the OS temp dir), `QUE_FAKE_CLAUDE_AGENTS_JSON` (a
file whose contents `agents --json` prints instead of `[]`),
`QUE_FAKE_CLAUDE_VERSION`. With `QUE_FAKE_CLAUDE_LOG` set, every invocation
first appends one JSON line `{ "argv": [...], "cwd": "...", "pid": <n>, "ts": "...",
"env": [...] }` to it (`env` is the sorted CLAUDE*, TERM* and QUE_* variable names it
saw), as `gh` and `code` do.

## `gh` and `code`

Each invocation appends one JSON line `{ "argv": [...], "cwd": "...", "ts": "..." }`
to `$QUE_FAKE_GH_LOG` / `$QUE_FAKE_CODE_LOG` when set. `gh auth status` reports
a logged-in account; `gh pr create ...` prints
`https://github.com/rquellh/que/pull/<n>`, where `n` counts the `pr create` calls
already in the log. Everything else exits 0 silently.

**Pull requests.** `$QUE_FAKE_GH_PRS` names a JSON file keyed by head branch name (a
missing file means no pull requests). When it is set, `gh pr create` records
`{ number, url, title, state: "OPEN", isDraft, headRefName, reviewDecision: "",
statusCheckRollup: [], mergedAt: null }` under the current branch of its cwd, and
`gh pr list --head <branch> --state all --limit 1 --json <fields>` prints a JSON
array with that branch's entry (only the requested fields) or `[]`. With
`$QUE_FAKE_GH_FAIL` set, `pr list` exits 1 printing `gh: failed (fake)` on stderr.
Tests edit the file with `setFakePullRequest()` and read it with
`readFakePullRequests()` from `src/testing/fakes.ts`. `pr create` also stores `updatedAt` (now).
**The conversation.** `gh pr view <n> --json <fields>` finds the entry whose `number` is
`n` and prints an object with the requested fields among `number,url,title,state,isDraft,
reviewDecision,statusCheckRollup,mergedAt,updatedAt,comments,reviews` (`comments` and
`reviews` default to `[]`); an unknown number exits 1 with `gh: no pull request #<n> (fake)`.
`gh api repos/<owner>/<repo>/pulls/<n>/comments` (literal `{owner}`/`{repo}`, `--paginate`,
`-X GET` and `--method GET` are fine) prints that entry's `lineComments` (default `[]`).
Both honour `$QUE_FAKE_GH_FAIL` and are logged like every other call. Seed the data with
the builders in `src/testing/fakes.ts`, which use GitHub's own field names:
`fakeCheckRun({ name, conclusion?, status?, workflowName?, detailsUrl?, startedAt?, completedAt? })`
and `fakeStatusContext({ context, state, targetUrl? })` for `statusCheckRollup`;
`fakeComment({ author, body, createdAt?, url? })` and `fakeReview({ author, state, body?, submittedAt? })`
for `comments` / `reviews`; `fakeLineComment({ author, body, path, line, hunk?, createdAt? })`
for `lineComments`. A check run defaults to a completed success; times default to
2026-10-14 around 03:00 UTC.
Read the call logs back with `readFakeLog()` from `src/testing/fakes.ts` (Vitest) or `launched.ghCalls()` (E2E).

## `acli`

Appends `{ "argv": [...], "cwd": "...", "ts": "..." }` to `$QUE_FAKE_ACLI_LOG` for
every call. `jira auth status` prints the signed-in lines (`Site: example.atlassian.net`).
`jira workitem search ... --limit N` prints the first N issues of the JSON array in
`$QUE_FAKE_ACLI_TICKETS` (acli's shape; a missing file means `[]`), keeping only the
requested `--fields` (plus `id`, `key`, `self`). Like the real CLI it refuses any field outside
`issuetype, key, assignee, priority, status, summary, labels, reporter, description` with
`✗ Error: fields '<names>' are not allowed` and exit 1; `view` accepts any list. And
`jira workitem view KEY` prints the whole matching issue, whatever `--fields` says (so a child written with
`fields.parent` returns it, and an issue without one returns no `parent` key; `search` never leaks `parent`) or exits 1 with
`No work item found: KEY`. `$QUE_FAKE_ACLI_FAIL=auth` makes every call exit 1 with
`Not authenticated. Run acli jira auth login.`; `network` makes `search` and `view`
exit 1 with `dial tcp: connection refused`. Tests write the file with
`writeFakeTickets()` and build issues with `makeFakeIssue()` from `src/testing/fakes.ts`.

## `caffeinate`

Appends `{ "argv": [...], "cwd": "...", "pid": <n>, "ts": "..." }` to
`$QUE_FAKE_CAFFEINATE_LOG` when set, then sleeps until it gets SIGTERM/SIGINT or
the process named by `-w <pid>` exits, as the real one does.

## `wrappers/claude`

Not a fake of a program que spawns but of something found on a user's machine:
another tool's `claude` wrapper, the kind that runs the next `claude` on `PATH`
outside its own directory. Tests put `tests/fakes/wrappers` **ahead of**
`tests/fakes/bin` (`FAKE_WRAPPERS` in `src/testing/fakes.ts`, or the harness's
`pathPrefix`) to check that que's own wrapper composes with it instead of the two
handing the command back and forth. It appends `<pid>\t<arguments>` to
`$QUE_FAKE_WRAPPER_LOG` when set (read with `readWrapperLog()`), and with
`QUE_FAKE_WRAPPER_STYLE=spawn` it runs the next `claude` as a child instead of
exec'ing it.
