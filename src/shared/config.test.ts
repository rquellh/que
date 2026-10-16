import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultJira,
  mergeConfigPatch,
  parseConfig,
  parseConfigAssignment,
  parseRepoConfig,
  parseWorktreeInclude,
  stringifyConfig
} from './config'

const env = { queHome: '/Users/dev/.que' }

describe('parseConfig', () => {
  it('falls back to the defaults for an empty file', () => {
    expect(parseConfig('', env)).toEqual({
      ok: true,
      config: {
        worktreeRoot: '/Users/dev/.que/worktrees',
        stallTimeoutMinutes: 5,
        statusPollSeconds: 10,
        prPollSeconds: 60,
        repos: {},
        concurrency: 2,
        maxTurns: 50,
        maxBudgetUsd: 5,
        defaultPermissionMode: undefined,
        allowBypassPermissions: false,
        protectedBranches: ['main', 'master', 'release'],
        quietHours: {
          enabled: true,
          default: { start: '19:00', end: '07:00' },
          days: {},
          unlockMinutes: 20
        },
        notifications: { chimeOnComplete: true, chimeOnNeedsInput: false, morningSummary: false },
        jira: defaultJira(),
        startPrompt: ''
      }
    })
  })

  it('reads every field, the repo registry, and ignores unknown keys', () => {
    const r = parseConfig(
      `worktree_root = "/Volumes/work/trees"
stall_timeout_minutes = 0.5
status_poll_seconds = 30
theme = "dark"
concurrency = 3
max_turns = 80
max_budget_usd = 12.5
default_permission_mode = "plan"
allow_bypass_permissions = true
protected_branches = ["main", "production"]
start_prompt = "Read .que/brief.md and ask before editing."

[repos.uploader]
path = "/Users/dev/code/uploader"
default_branch = "develop"

[repos.api]
path = "/Users/dev/code/api"
`,
      env
    )

    expect(r).toEqual({
      ok: true,
      config: {
        worktreeRoot: '/Volumes/work/trees',
        stallTimeoutMinutes: 0.5,
        statusPollSeconds: 30,
        prPollSeconds: 60,
        repos: {
          uploader: { path: '/Users/dev/code/uploader', defaultBranch: 'develop' },
          api: { path: '/Users/dev/code/api', defaultBranch: undefined }
        },
        concurrency: 3,
        maxTurns: 80,
        maxBudgetUsd: 12.5,
        defaultPermissionMode: 'plan',
        allowBypassPermissions: true,
        protectedBranches: ['main', 'production'],
        quietHours: expect.objectContaining({ enabled: true }),
        notifications: expect.objectContaining({ chimeOnComplete: true }),
        jira: defaultJira(),
        startPrompt: 'Read .que/brief.md and ask before editing.'
      }
    })
  })

  describe('quiet hours and notifications', () => {
    it('reads the window, per-weekday overrides, fractional unlock minutes and the toggles', () => {
      const r = parseConfig(
        `[quiet_hours]
enabled = true
default = ["20:30", "06:45"]
monday = ["21:00", "06:30"]
saturday = "none"
unlock_minutes = 0.05

[notifications]
chime_on_complete = false
chime_on_needs_input = true
morning_summary = true
`,
        env
      )

      expect(r.ok && r.config.quietHours).toEqual({
        enabled: true,
        default: { start: '20:30', end: '06:45' },
        days: { monday: { start: '21:00', end: '06:30' }, saturday: 'none' },
        unlockMinutes: 0.05
      })
      expect(r.ok && r.config.notifications).toEqual({
        chimeOnComplete: false,
        chimeOnNeedsInput: true,
        morningSummary: true
      })
    })

    it('reports bad times, an empty window, unknown days and bad toggles by key', () => {
      const r = parseConfig(
        `[quiet_hours]
default = ["7pm", "07:00"]
tuesday = ["22:00", "22:00"]
wednesday = ["25:00", "06:00"]
thursday = "off"
caturday = "none"
unlock_minutes = 0

[notifications]
chime_on_complete = "yes"
`,
        env
      )

      expect(r).toEqual({
        ok: false,
        errors: [
          { key: 'quiet_hours.caturday', message: 'is not a quiet_hours key' },
          { key: 'quiet_hours.default', message: '7pm is not a 24-hour HH:MM time' },
          { key: 'quiet_hours.unlock_minutes', message: 'must be a positive number' },
          { key: 'quiet_hours.tuesday', message: 'start and end must differ' },
          { key: 'quiet_hours.wednesday', message: '25:00 is not a 24-hour HH:MM time' },
          { key: 'quiet_hours.thursday', message: 'must be ["HH:MM", "HH:MM"] (start, end)' },
          { key: 'notifications.chime_on_complete', message: 'must be true or false' }
        ]
      })
    })
  })

  it('reports each invalid value by key', () => {
    const r = parseConfig(
      `stall_timeout_minutes = -1
status_poll_seconds = "often"
[repos.uploader]
default_branch = "main"
`,
      env
    )

    expect(r).toEqual({
      ok: false,
      errors: [
        { key: 'stall_timeout_minutes', message: 'must be a positive number' },
        { key: 'status_poll_seconds', message: 'must be a positive number' },
        { key: 'repos.uploader.path', message: 'is required' }
      ]
    })
  })

  it('reports bad task settings by key', () => {
    const r = parseConfig(
      `concurrency = 1.5
default_permission_mode = "yolo"
allow_bypass_permissions = "yes"
protected_branches = "main"
start_prompt = 3
`,
      env
    )

    expect(r).toEqual({
      ok: false,
      errors: [
        { key: 'concurrency', message: 'must be a whole number' },
        {
          key: 'default_permission_mode',
          message: 'must be one of default, acceptEdits, plan, bypassPermissions, dontAsk, auto'
        },
        { key: 'allow_bypass_permissions', message: 'must be true or false' },
        { key: 'protected_branches', message: 'must be a list of strings' },
        { key: 'start_prompt', message: 'must be a string' }
      ]
    })
  })

  describe('instructions_file', () => {
    it('reads an absolute path as is', () => {
      const r = parseConfig('instructions_file = "/Users/dev/notes/delegation.md"', env)
      expect(r).toMatchObject({
        ok: true,
        config: { instructionsFile: '/Users/dev/notes/delegation.md' }
      })
    })

    it('expands a leading ~ to the home directory', () => {
      const r = parseConfig('instructions_file = "~/.config/que/instructions.md"', env)
      expect(r).toMatchObject({
        ok: true,
        config: { instructionsFile: join(os.homedir(), '.config/que/instructions.md') }
      })
    })

    it('treats an empty string as unset', () => {
      const r = parseConfig('instructions_file = ""', env)
      expect(r.ok).toBe(true)
      expect(r.ok && r.config.instructionsFile).toBeUndefined()
    })

    it('reports a value that is not a string by key', () => {
      expect(parseConfig('instructions_file = 3', env)).toEqual({
        ok: false,
        errors: [{ key: 'instructions_file', message: 'must be a path' }]
      })
    })

    it('round-trips through a `que config set` patch', () => {
      const patch = parseConfigAssignment('instructions_file=~/notes/delegation.md')
      expect(patch).toEqual({ instructions_file: '~/notes/delegation.md' })

      const merged = mergeConfigPatch({ concurrency: 3 }, patch)
      expect(parseConfig(stringifyConfig(merged), env)).toMatchObject({
        ok: true,
        config: { concurrency: 3, instructionsFile: join(os.homedir(), 'notes/delegation.md') }
      })
      const removed = mergeConfigPatch(merged, parseConfigAssignment('instructions_file=null'))
      expect(removed).toEqual({ concurrency: 3 })
    })
  })

  it('reads an empty or blank start_prompt as off, and round-trips it', () => {
    for (const text of ['start_prompt = ""\n', 'start_prompt = "  "\n']) {
      const r = parseConfig(text, env)
      expect(r.ok && r.config.startPrompt).toBe('')
    }
    const set = parseConfig('start_prompt = "Read .que/brief.md first."\n', env)
    expect(set.ok && set.config.startPrompt).toBe('Read .que/brief.md first.')
    const again = parseConfig(stringifyConfig({ start_prompt: '' }), env)
    expect(again.ok && again.config.startPrompt).toBe('')
  })

  it('reports a TOML syntax error without a key', () => {
    const r = parseConfig('stall_timeout_minutes = = 3', env)

    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors[0].key).toBe('')
  })
})

describe('parseRepoConfig', () => {
  it('reads setup, teardown, default branch, and worktree_include merged with .worktreeinclude', () => {
    const r = parseRepoConfig(
      `setup = "npm ci"
teardown = "docker compose down"
default_branch = "trunk"
worktree_include = [".env", "config/local"]
permission_mode = "bypassPermissions"
instructions = "Follow docs/STYLE.md."
test = "npm test"
allowed_tools = ["Bash(npm test)", "Edit"]
`,
      '# local secrets\n.env\n\n.npmrc\n'
    )

    expect(r).toEqual({
      ok: true,
      config: {
        setup: 'npm ci',
        teardown: 'docker compose down',
        defaultBranch: 'trunk',
        worktreeInclude: ['.env', 'config/local', '.npmrc'],
        permissionMode: 'bypassPermissions',
        instructions: 'Follow docs/STYLE.md.',
        test: 'npm test',
        allowedTools: ['Bash(npm test)', 'Edit']
      }
    })
  })

  it('rejects a worktree_include that is not a list of strings', () => {
    expect(parseRepoConfig('worktree_include = ".env"')).toEqual({
      ok: false,
      errors: [{ key: 'worktree_include', message: 'must be a list of strings' }]
    })
  })
})

describe('parseWorktreeInclude', () => {
  it('keeps one path per line, skipping blanks and comments', () => {
    expect(parseWorktreeInclude('.env\n  # comment\n\n  .env.local  \n')).toEqual([
      '.env',
      '.env.local'
    ])
  })
})

describe('config patches', () => {
  it('deep-merges a patch into the file table, removing keys set to null, without mutating it', () => {
    const raw = {
      concurrency: 2,
      quiet_hours: { enabled: true, default: ['19:00', '07:00'], saturday: 'none' },
      repos: { uploader: { path: '/Users/dev/code/uploader' } }
    }
    const before = structuredClone(raw)

    const merged = mergeConfigPatch(raw, {
      concurrency: 4,
      quiet_hours: { default: ['20:00', '06:00'], saturday: null, monday: ['21:00', '06:30'] }
    })

    expect(merged).toEqual({
      concurrency: 4,
      quiet_hours: { enabled: true, default: ['20:00', '06:00'], monday: ['21:00', '06:30'] },
      repos: { uploader: { path: '/Users/dev/code/uploader' } }
    })
    expect(raw).toEqual(before)
    expect(parseConfig(stringifyConfig(merged), env)).toMatchObject({
      ok: true,
      config: {
        concurrency: 4,
        quietHours: {
          default: { start: '20:00', end: '06:00' },
          days: { monday: expect.any(Object) }
        }
      }
    })
  })

  it('reads `que config set` assignments: dotted keys, booleans, numbers, lists and null', () => {
    expect(parseConfigAssignment('quiet_hours.default=19:30,07:15')).toEqual({
      quiet_hours: { default: ['19:30', '07:15'] }
    })
    expect(parseConfigAssignment('notifications.chime_on_complete=false')).toEqual({
      notifications: { chime_on_complete: false }
    })
    expect(parseConfigAssignment('quiet_hours.unlock_minutes=0.5')).toEqual({
      quiet_hours: { unlock_minutes: 0.5 }
    })
    expect(parseConfigAssignment('protected_branches=production')).toEqual({
      protected_branches: ['production']
    })
    expect(parseConfigAssignment('quiet_hours.saturday=none')).toEqual({
      quiet_hours: { saturday: 'none' }
    })
    expect(parseConfigAssignment('quiet_hours.saturday=null')).toEqual({
      quiet_hours: { saturday: null }
    })
    expect(() => parseConfigAssignment('concurrency')).toThrow('expected key=value')
  })
})
