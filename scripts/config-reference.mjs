// Regenerates the defaults blocks in docs/configuration.md from the real
// defaults in src/shared/config.ts, so the reference cannot drift. The blocks
// sit between `<!-- generated:config-defaults -->` and `<!-- /generated -->`.
//
//   node scripts/config-reference.mjs           rewrite the blocks
//   node scripts/config-reference.mjs --check   exit 1 if they are stale
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'docs/configuration.md')
const tmp = mkdtempSync(join(os.tmpdir(), 'que-config-ref-'))
const outfile = join(tmp, 'config.js')
buildSync({
  entryPoints: [join(root, 'src/shared/config.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // smol-toml resolves from the repo's node_modules.
  nodePaths: [join(root, 'node_modules')],
  logLevel: 'error'
})
const config = createRequire(import.meta.url)(outfile)
rmSync(tmp, { recursive: true, force: true })

const HOME = '/Users/you/.que'
const d = config.defaultConfig({ queHome: HOME })
const toml = (v) => JSON.stringify(v).replace(/,/g, ', ')

const userDefaults = `# ~/.config/que/config.toml (or $QUE_CONFIG). Every key is optional;
# these are the defaults.
worktree_root = ${toml(d.worktreeRoot.replace(HOME, '~/.que'))}
stall_timeout_minutes = ${d.stallTimeoutMinutes}
status_poll_seconds = ${d.statusPollSeconds}
pr_poll_seconds = ${d.prPollSeconds}
concurrency = ${d.concurrency}
max_turns = ${d.maxTurns}
max_budget_usd = ${d.maxBudgetUsd}
# default_permission_mode = "acceptEdits"   # unset: que.toml or Claude Code decides
allow_bypass_permissions = ${d.allowBypassPermissions}
protected_branches = ${toml(d.protectedBranches)}
# instructions_file = "~/.config/que/instructions.md"   # unset: no instructions

[quiet_hours]
enabled = ${d.quietHours.enabled}
default = ${toml([d.quietHours.default.start, d.quietHours.default.end])}
unlock_minutes = ${d.quietHours.unlockMinutes}
# friday = ["21:00", "09:00"]   # a per-day override (sunday … saturday)
# saturday = "none"             # no quiet hours that night

[notifications]
chime_on_complete = ${d.notifications.chimeOnComplete}
chime_on_needs_input = ${d.notifications.chimeOnNeedsInput}
morning_summary = ${d.notifications.morningSummary}

[jira]
jql = ${JSON.stringify(d.jira.jql)}
poll_minutes = ${d.jira.pollMinutes}
start_prompt = ${JSON.stringify(d.jira.startPrompt)}
# [jira.projects]                # learned the first time you pick a project for a ticket
# APP = "uploader"               # tracker project key = que project name

# [repos.uploader]               # a name for \`que work -r uploader\`
# path = "~/code/uploader"
# default_branch = "main"`

// The block must parse back to exactly the defaults (worktree_root aside, which
// expands ~ against the real home).
const parsed = config.parseConfig(userDefaults, { queHome: HOME })
if (!parsed.ok) throw new Error(`generated defaults do not parse: ${JSON.stringify(parsed.errors)}`)
parsed.config.worktreeRoot = d.worktreeRoot
if (JSON.stringify(parsed.config) !== JSON.stringify(d)) {
  throw new Error('generated defaults do not round-trip to defaultConfig()')
}

const repoExample = `# <repo>/que.toml. Every key is optional; none has a default.
setup = "npm ci"                       # run inside a new worktree
teardown = "./scripts/teardown.sh"     # run inside a worktree before removal
default_branch = "main"                # base for new workspaces (else origin's HEAD)
worktree_include = [".env.local"]      # gitignored files copied into new worktrees
permission_mode = "acceptEdits"        # ${config.PERMISSION_MODES.join(' | ')}
test = "npm test"                      # the command a task must make pass
instructions = "Keep changes small."   # appended to every task brief for this repo
allowed_tools = ["Bash(npm test)"]     # passed to claude as --allowedTools`
const repoParsed = config.parseRepoConfig(repoExample)
if (!repoParsed.ok)
  throw new Error(`que.toml example does not parse: ${JSON.stringify(repoParsed.errors)}`)

const blocks = { 'config-defaults': userDefaults, 'repo-example': repoExample }
let stale = false
for (const file of [target, join(root, 'README.md')]) {
  const current = readFileSync(file, 'utf8')
  let next = current
  for (const [name, body] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(<!-- /generated -->)`)
    if (!re.test(next)) throw new Error(`${file} has no generated:${name} block`)
    next = next.replace(re, `$1\`\`\`toml\n${body}\n\`\`\`\n$2`)
  }
  if (next === current) continue
  stale = true
  if (!process.argv.includes('--check')) {
    writeFileSync(file, next)
    console.log(`wrote ${file}`)
  }
}
if (process.argv.includes('--check')) {
  if (stale) {
    console.error('the generated config blocks are stale; run npm run docs')
    process.exit(1)
  }
  console.log('the generated config blocks are up to date')
}
