import { describe, expect, it } from 'vitest'
import { makeTask } from '../testing/fixtures'
import { buildClaudeArgs, buildPrompt, resolvePermissionMode, SYSTEM_PROMPT } from './runner'

describe('buildPrompt', () => {
  it('is the brief, then the repo instructions, then the definition of done with the test command', () => {
    const prompt = buildPrompt(makeTask({ brief: 'Add retry logic to the uploader.\n' }), {
      instructions: 'Follow docs/STYLE.md.',
      test: 'npm test'
    })

    const parts = prompt.split('\n\n')
    expect(parts[0]).toBe('Add retry logic to the uploader.')
    expect(parts[1]).toBe('Follow docs/STYLE.md.')
    expect(parts[2]).toMatch(/^Definition of done:/)
    expect(parts[2]).toContain('Work only inside this worktree')
    expect(parts[2]).toContain('Run the test command `npm test` and make it pass.')
    expect(parts[2]).toContain('Commit your work with a clear message. Do not push.')
    expect(parts[2]).toContain('suitable for a pull request description')
  })

  it('leaves out instructions the repo does not have', () => {
    const prompt = buildPrompt(makeTask({ brief: 'Fix the flaky upload test' }), {})

    expect(prompt.split('\n\n')).toHaveLength(2)
    expect(prompt).toContain('Run the repository tests if it has any')
  })
})

describe('SYSTEM_PROMPT', () => {
  it('forbids questions and pushing', () => {
    expect(SYSTEM_PROMPT).toContain('You cannot ask questions. If you are blocked, explain why')
    expect(SYSTEM_PROMPT).toContain('Never push')
  })
})

describe('resolvePermissionMode', () => {
  const user = { defaultPermissionMode: undefined, allowBypassPermissions: false }

  it('prefers que.toml, then the user default, then acceptEdits', () => {
    expect(
      resolvePermissionMode(
        { permissionMode: 'plan' },
        { ...user, defaultPermissionMode: 'default' }
      ).mode
    ).toBe('plan')
    expect(resolvePermissionMode({}, { ...user, defaultPermissionMode: 'default' }).mode).toBe(
      'default'
    )
    expect(resolvePermissionMode({}, user)).toEqual({ mode: 'acceptEdits', warning: null })
  })

  it('honours bypassPermissions only when the repo sets it and the user allows it', () => {
    expect(
      resolvePermissionMode(
        { permissionMode: 'bypassPermissions' },
        { ...user, allowBypassPermissions: true }
      )
    ).toEqual({ mode: 'bypassPermissions', warning: null })
  })

  it.each([
    [
      'the repo asks but the user has not allowed it',
      { permissionMode: 'bypassPermissions' as const },
      user
    ],
    [
      'only the user default asks for it',
      {},
      { defaultPermissionMode: 'bypassPermissions' as const, allowBypassPermissions: true }
    ]
  ])('downgrades to acceptEdits with a warning when %s', (_, repo, config) => {
    const r = resolvePermissionMode(repo, config)

    expect(r.mode).toBe('acceptEdits')
    expect(r.warning).toContain('allow_bypass_permissions')
  })
})

describe('buildClaudeArgs', () => {
  const base = {
    prompt: 'Add retry logic',
    sessionId: '5f0c1d2e-0000-4000-8000-9a8b7c6d5e4f',
    resume: false,
    permissionMode: 'acceptEdits' as const,
    maxTurns: 40,
    maxBudgetUsd: 2.5,
    systemPromptFile: '/Users/dev/.que/system.md',
    settingsFile: '/Users/dev/.que/hooks.json',
    allowedTools: [] as string[]
  }

  it('runs headless with stream-json, hooks, caps, and a fixed session id', () => {
    expect(buildClaudeArgs(base)).toEqual([
      '-p',
      'Add retry logic',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-hook-events',
      '--session-id',
      '5f0c1d2e-0000-4000-8000-9a8b7c6d5e4f',
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      '--max-turns',
      '40',
      '--max-budget-usd',
      '2.5',
      '--append-system-prompt-file',
      '/Users/dev/.que/system.md',
      '--settings',
      '/Users/dev/.que/hooks.json'
    ])
  })

  it('resumes instead of starting a session, and passes allowed tools', () => {
    const args = buildClaudeArgs({
      ...base,
      resume: true,
      allowedTools: ['Bash(npm test)', 'Edit']
    })

    expect(args).not.toContain('--session-id')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      '5f0c1d2e-0000-4000-8000-9a8b7c6d5e4f'
    ])
    expect(args.slice(-2)).toEqual(['--allowedTools', 'Bash(npm test),Edit'])
  })
})
