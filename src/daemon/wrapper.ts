// The hooks wrapper. Workspace terminals get <QUE_HOME>/bin first on PATH:
// its `claude` adds `--settings <QUE_HOME>/hooks.json` when started inside a
// workspace, and those hooks run `que hook`, which reports to the daemon. It
// also adds the instructions file and the permission mode from the terminal's
// QUE_INSTRUCTIONS and QUE_PERMISSION_MODE. The user's own Claude Code
// settings are never touched.
import fs from 'node:fs'
import { delimiter, join } from 'node:path'
import { appExecutable, cliScriptFrom, packagedResourcesDir } from '../shared/packaged'
import { HOOK_EVENT_NAMES } from '../shared/protocol'
import type { QuePaths } from '../shared/paths'

export interface WrapperOptions {
  paths: QuePaths
  /** Node used by bin/que; null falls back to `/usr/bin/env node`. */
  nodePath: string | null
  /** nodePath is the app binary, which runs scripts only with ELECTRON_RUN_AS_NODE=1. */
  runAsNode?: boolean
  /** The bundled CLI (out/cli/index.js). */
  cliScript: string
}

/** Single-quotes a string for POSIX sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First executable `name` on `pathEnv`, skipping the `skip` directories. */
export function findOnPath(
  name: string,
  pathEnv: string | undefined,
  skip: string[] = []
): string | null {
  const skipReal = new Set(skip.flatMap((d) => [d, safeRealpath(d)]))
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || skipReal.has(dir) || skipReal.has(safeRealpath(dir))) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** The node that bin/que runs: $QUE_NODE, else the first `node` on PATH. */
export function resolveNode(): string | null {
  return process.env.QUE_NODE || findOnPath('node', process.env.PATH)
}

/** The bundled CLI: Resources/cli/index.js in a packaged app, else out/cli/index.js. */
export function defaultCliScript(): string {
  return cliScriptFrom(__dirname)
}

/**
 * What bin/que runs the CLI with. In a packaged app: the app's own binary as
 * Node, so no separate Node install is needed. In development: $QUE_NODE or
 * the first `node` on PATH.
 */
export function cliRunnerFrom(
  dir: string,
  node: () => string | null = resolveNode
): { nodePath: string | null; runAsNode: boolean } {
  const res = packagedResourcesDir(dir)
  if (res) return { nodePath: appExecutable(res), runAsNode: true }
  return { nodePath: node(), runAsNode: false }
}

export function resolveCliRunner(): { nodePath: string | null; runAsNode: boolean } {
  return cliRunnerFrom(__dirname)
}

export function hooksSettings(): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {}
  for (const event of HOOK_EVENT_NAMES) {
    hooks[event] = [{ hooks: [{ type: 'command', command: 'que hook', timeout: 5 }] }]
  }
  return { hooks }
}

/**
 * Another claude wrapper on PATH (one that looks past its own directory and
 * runs the next claude it finds) can hand the command straight back to this
 * script, in the same process, since wrappers exec. The script notices that
 * re-entry by its pid, skips every claude it already handed off to, and adds
 * --settings only on the first pass, so the chain ends at the real executable.
 * The depth cap turns a wrapper that spawns instead of exec'ing into an error
 * rather than an endless loop.
 */
const MAX_WRAPPER_DEPTH = 16

function claudeScript(paths: QuePaths): string {
  return `#!/bin/sh
# que wrapper for Claude Code. Inside a que workspace terminal it adds que's
# hook settings for this session only, plus the instructions file
# (QUE_INSTRUCTIONS) and permission mode (QUE_PERMISSION_MODE) when set;
# anywhere else it is transparent. When
# another claude wrapper on PATH hands the command back here (same pid: they
# exec), the claude already tried is skipped and --settings is not added twice.
QUE_BIN=${shQuote(paths.binDir)}
QUE_HOOKS=${shQuote(paths.hooksJson)}
QUE_CLAUDE_DEPTH=$((\${QUE_CLAUDE_DEPTH:-0} + 1))
export QUE_CLAUDE_DEPTH
if [ "$QUE_CLAUDE_DEPTH" -gt ${MAX_WRAPPER_DEPTH} ]; then
  echo "que: $QUE_CLAUDE_DEPTH claude wrappers have handed off to each other without reaching Claude Code; set QUE_REAL_CLAUDE to the real executable" >&2
  exit 127
fi
if [ "\${QUE_CLAUDE_PID-}" = "$$" ]; then
  REENTERED=1
else
  REENTERED=""
  QUE_CLAUDE_TRIED=""
fi
QUE_CLAUDE_PID=$$
export QUE_CLAUDE_PID
REAL=""
if [ -z "$REENTERED" ] && [ -n "$QUE_REAL_CLAUDE" ] && [ -x "$QUE_REAL_CLAUDE" ]; then
  REAL="$QUE_REAL_CLAUDE"
else
  set -f
  OLD_IFS=$IFS
  IFS=:
  for d in $PATH; do
    [ -n "$d" ] || continue
    [ "$d" = "$QUE_BIN" ] && continue
    c="$d/claude"
    [ -f "$c" ] && [ -x "$c" ] || continue
    [ "$c" -ef "$0" ] && continue
    SKIP=""
    for t in $QUE_CLAUDE_TRIED; do
      if [ "$c" -ef "$t" ]; then
        SKIP=1
        break
      fi
    done
    [ -n "$SKIP" ] && continue
    REAL="$c"
    break
  done
  IFS=$OLD_IFS
  set +f
fi
if [ -z "$REAL" ]; then
  echo "que: could not find the claude executable on PATH (outside $QUE_BIN)" >&2
  exit 127
fi
QUE_CLAUDE_TRIED="\${QUE_CLAUDE_TRIED:+$QUE_CLAUDE_TRIED:}$REAL"
export QUE_CLAUDE_TRIED
if [ -n "$QUE_WORKSPACE_ID" ] && [ -z "$REENTERED" ]; then
  # Your own --permission-mode or --dangerously-skip-permissions (before any
  # --) wins over que's. Extra flags go in front of yours, last first.
  OWN_MODE=""
  for a in "$@"; do
    case "$a" in
      --) break ;;
      --permission-mode|--permission-mode=*|--dangerously-skip-permissions) OWN_MODE=1 ;;
    esac
  done
  if [ -n "\${QUE_PERMISSION_MODE-}" ] && [ -z "$OWN_MODE" ]; then
    set -- --permission-mode "$QUE_PERMISSION_MODE" "$@"
  fi
  if [ -n "\${QUE_INSTRUCTIONS-}" ] && [ -f "$QUE_INSTRUCTIONS" ]; then
    set -- --append-system-prompt-file "$QUE_INSTRUCTIONS" "$@"
  fi
  exec "$REAL" --settings "$QUE_HOOKS" "$@"
fi
exec "$REAL" "$@"
`
}

export function queScript(opts: WrapperOptions): string {
  const runner = opts.nodePath ? shQuote(opts.nodePath) : '/usr/bin/env node'
  const env = opts.runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
  return `#!/bin/sh
# que CLI launcher for workspace terminals and hooks.
${env}exec ${runner} ${shQuote(opts.cliScript)} "$@"
`
}

// zsh startup files for workspace terminals (ZDOTDIR points here). Each one
// sources the user's own file at top level, then the last ones put que's bin
// directory back in front of PATH, since profiles commonly prepend to it.
const ZSH_RESTORE_USER = `__que_zdotdir="$ZDOTDIR"
ZDOTDIR="$__que_user_zdotdir"`
const ZSH_BACK_TO_QUE = `__que_user_zdotdir="$ZDOTDIR"
ZDOTDIR="$__que_zdotdir"`
const ZSH_PREPEND = `if [[ -n "\${QUE_HOME-}" ]]; then
  path=("$QUE_HOME/bin" \${path:#\${(b)QUE_HOME}/bin})
  export PATH
fi`

function zshFiles(): Record<string, string> {
  const header = '# que: workspace terminal startup; sources your own file of the same name.\n'
  return {
    '.zshenv': `${header}if [[ -n "\${QUE_USER_ZDOTDIR-}" ]]; then
  __que_user_zdotdir="$QUE_USER_ZDOTDIR"
else
  __que_user_zdotdir="$HOME"
fi
${ZSH_RESTORE_USER}
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
${ZSH_BACK_TO_QUE}
`,
    '.zprofile': `${header}${ZSH_RESTORE_USER}
[[ -r "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
${ZSH_BACK_TO_QUE}
`,
    '.zshrc': `${header}${ZSH_RESTORE_USER}
[[ -r "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
${ZSH_BACK_TO_QUE}
${ZSH_PREPEND}
`,
    '.zlogin': `${header}${ZSH_RESTORE_USER}
[[ -r "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
${ZSH_PREPEND}
if [[ -n "\${QUE_USER_ZDOTDIR-}" ]]; then ZDOTDIR="$QUE_USER_ZDOTDIR"; else unset ZDOTDIR; fi
unset __que_zdotdir __que_user_zdotdir QUE_USER_ZDOTDIR
`
  }
}

export function zshDir(paths: QuePaths): string {
  return join(paths.shellDir, 'zsh')
}

function writeFile(path: string, content: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, path)
}

/** Writes bin/claude, bin/que, hooks.json, and the zsh startup files under QUE_HOME. */
export function installWrapper(opts: WrapperOptions): void {
  const { paths } = opts
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 })
  const zdir = zshDir(paths)
  fs.mkdirSync(zdir, { recursive: true, mode: 0o700 })
  writeFile(join(paths.binDir, 'claude'), claudeScript(paths), 0o755)
  writeFile(join(paths.binDir, 'que'), queScript(opts), 0o755)
  writeFile(paths.hooksJson, `${JSON.stringify(hooksSettings(), null, 2)}\n`, 0o644)
  for (const [name, content] of Object.entries(zshFiles())) {
    writeFile(join(zdir, name), content, 0o644)
  }
}
