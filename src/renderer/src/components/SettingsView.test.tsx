import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeQuietState } from '@renderer/testing/fixtures'
import App from '../App'

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** A window an hour either side of now, and the quiet state the daemon reports for it. */
function tonight(): { start: string; end: string; state: ReturnType<typeof makeQuietState> } {
  const start = new Date(Date.now() - 3_600_000)
  const end = new Date(Date.now() + 3_600_000)
  start.setSeconds(0, 0)
  end.setSeconds(0, 0)
  return {
    start: hhmm(start),
    end: hhmm(end),
    // Unlocked: the main window (and so Settings) only shows during quiet hours then.
    state: makeQuietState({
      inQuietHours: true,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      unlockedUntil: new Date(Date.now() + 600_000).toISOString()
    })
  }
}

async function openSettings(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  render(<App />)
  await user.click(await screen.findByRole('button', { name: 'Settings' }))
  return screen.findByTestId('settings-view')
}

describe('SettingsView', () => {
  describe('rendering', () => {
    it('loads the config: quiet hours, per-day overrides, notifications, protected branches and the path', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        protectedBranches: ['main', 'release'],
        quietHours: {
          enabled: true,
          default: { start: '20:30', end: '06:45' },
          days: { friday: { start: '23:00', end: '09:00' }, saturday: 'none' },
          unlockMinutes: 15
        },
        notifications: { chimeOnComplete: false, chimeOnNeedsInput: true, morningSummary: true }
      })

      await openSettings(user)

      expect(await screen.findByTestId('settings-quiet-start')).toHaveValue('20:30')
      expect(screen.getByTestId('settings-quiet-end')).toHaveValue('06:45')
      expect(screen.getByTestId('settings-quiet-enabled')).toBeChecked()
      expect(screen.getByTestId('settings-unlock-minutes')).toHaveValue(15)
      expect(screen.getByTestId('settings-day-friday-mode')).toHaveValue('custom')
      expect(screen.getByTestId('settings-day-friday-start')).toHaveValue('23:00')
      expect(screen.getByTestId('settings-day-saturday-mode')).toHaveValue('none')
      expect(screen.getByTestId('settings-day-monday-mode')).toHaveValue('inherit')
      expect(screen.getByTestId('settings-chime-complete')).not.toBeChecked()
      expect(screen.getByTestId('settings-chime-needs-input')).toBeChecked()
      expect(screen.getByTestId('settings-morning-summary')).toBeChecked()
      expect(screen.getByTestId('settings-protected-branches')).toHaveValue('main, release')
      expect(screen.getByTestId('settings-path')).toHaveTextContent(
        '/Users/dev/.config/que/config.toml'
      )
      expect(screen.queryByText('Overnight tasks')).not.toBeInTheDocument()
    })
  })

  describe('user interactions', () => {
    it('saves the changes as a config patch, removing overrides set back to the default', async () => {
      const user = userEvent.setup()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: '19:00', end: '07:00' },
          days: { saturday: 'none' },
          unlockMinutes: 20
        }
      })
      await openSettings(user)

      await user.clear(await screen.findByTestId('settings-quiet-start'))
      await user.type(screen.getByTestId('settings-quiet-start'), '20:00')
      await user.selectOptions(screen.getByTestId('settings-day-saturday-mode'), 'inherit')
      await user.selectOptions(screen.getByTestId('settings-day-monday-mode'), 'custom')
      await user.clear(screen.getByTestId('settings-day-monday-end'))
      await user.type(screen.getByTestId('settings-day-monday-end'), '06:30')
      await user.click(screen.getByTestId('settings-chime-complete'))
      await user.clear(screen.getByTestId('settings-protected-branches'))
      await user.type(screen.getByTestId('settings-protected-branches'), 'main, release, hotfix')
      await user.click(screen.getByTestId('settings-save'))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toHaveLength(1)
      })
      const [{ patch, applyTonight }] = fakeBridge.configSetCalls()
      expect(applyTonight).toBe(false)
      expect(patch).toMatchObject({
        quiet_hours: {
          enabled: true,
          default: ['20:00', '07:00'],
          unlock_minutes: 20,
          monday: ['19:00', '06:30'],
          saturday: null,
          sunday: null
        },
        notifications: { chime_on_complete: false },
        protected_branches: ['main', 'release', 'hotfix']
      })
      // The queue's defaults are the config file's business now.
      expect(patch).not.toHaveProperty('concurrency')
      expect(patch).not.toHaveProperty('max_turns')
      expect(patch).not.toHaveProperty('max_budget_usd')
      expect(patch).not.toHaveProperty('default_permission_mode')
      expect(await screen.findByTestId('settings-saved')).toHaveTextContent('Saved')
    })

    it('refuses to save an empty window or a bad number, saying why', async () => {
      const user = userEvent.setup()
      await openSettings(user)

      await user.clear(await screen.findByTestId('settings-quiet-end'))
      await user.type(screen.getByTestId('settings-quiet-end'), '19:00')
      await user.clear(screen.getByTestId('settings-unlock-minutes'))
      await user.type(screen.getByTestId('settings-unlock-minutes'), '0')
      await user.click(screen.getByTestId('settings-save'))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Quiet hours: start and end must differ')
      expect(alert).toHaveTextContent('Unlock minutes must be a positive number')
      expect(fakeBridge.configSetCalls()).toEqual([])
    })
  })

  describe('apply tonight', () => {
    it("asks before a change that ends tonight's quiet hours early, and applies it tonight on Yes", async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-quiet-enabled'))
      await user.click(screen.getByTestId('settings-save'))

      const confirm = await screen.findByTestId('settings-apply-tonight-confirm')
      expect(within(confirm).getByRole('heading')).toHaveTextContent('Apply tonight?')
      expect(fakeBridge.configSetCalls()).toEqual([])
      await user.click(within(confirm).getByRole('button', { name: 'Yes, tonight' }))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          expect.objectContaining({ applyTonight: true })
        ])
      })
      expect(screen.queryByTestId('settings-apply-tonight-confirm')).not.toBeInTheDocument()
    })

    it('saves for tomorrow on No', async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-quiet-enabled'))
      await user.click(screen.getByTestId('settings-save'))
      await user.click(await screen.findByRole('button', { name: 'No, from tomorrow' }))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toEqual([
          expect.objectContaining({ applyTonight: false })
        ])
      })
    })

    it("does not ask when the change leaves tonight's window as long", async () => {
      const user = userEvent.setup()
      const t = tonight()
      fakeBridge.setConfig({
        quietHours: {
          enabled: true,
          default: { start: t.start, end: t.end },
          days: {},
          unlockMinutes: 20
        }
      })
      fakeBridge.setQuietState(t.state)
      await openSettings(user)

      await user.click(await screen.findByTestId('settings-chime-complete'))
      await user.click(screen.getByTestId('settings-save'))

      await waitFor(() => {
        expect(fakeBridge.configSetCalls()).toHaveLength(1)
      })
      expect(screen.queryByTestId('settings-apply-tonight-confirm')).not.toBeInTheDocument()
    })
  })
})

describe('SettingsView tickets', () => {
  it('loads the filter, interval, prompt and learned projects, and saves the jira patch', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig({
      jira: {
        jql: 'assignee = currentUser()',
        pollMinutes: 7,
        site: null,
        startPrompt: 'Plan first.',
        projects: { APP: 'uploader', WEB: 'site' }
      }
    })
    await openSettings(user)

    expect(await screen.findByTestId('settings-tickets-jql')).toHaveValue(
      'assignee = currentUser()'
    )
    expect(screen.getByTestId('settings-tickets-poll')).toHaveValue(7)
    expect(screen.getByTestId('settings-tickets-prompt')).toHaveValue('Plan first.')
    const learned = screen.getByTestId('settings-tickets-projects')
    expect(learned).toHaveTextContent('APP → uploader')
    expect(learned).toHaveTextContent('WEB → site')

    await user.clear(screen.getByTestId('settings-tickets-poll'))
    await user.type(screen.getByTestId('settings-tickets-poll'), '10')
    await user.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    const patch = fakeBridge.configSetCalls()[0].patch
    expect(patch).toMatchObject({
      jira: { jql: 'assignee = currentUser()', poll_minutes: 10, start_prompt: 'Plan first.' }
    })
    expect(patch.jira).not.toHaveProperty('projects')
  })

  it('saves the site as null when blank and as the trimmed host otherwise', async () => {
    const user = userEvent.setup()
    await openSettings(user)
    const site = await screen.findByTestId('settings-jira-site')
    expect(site).toHaveValue('')
    expect(site).toHaveAttribute('placeholder', 'team.example.net')

    await user.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    expect(fakeBridge.configSetCalls()[0].patch.jira).toMatchObject({ site: null })

    await user.type(site, '  team.example.net ')
    await user.click(screen.getByTestId('settings-save'))
    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(2))
    expect(fakeBridge.configSetCalls()[1].patch.jira).toMatchObject({ site: 'team.example.net' })
  })

  it('says when no projects are learned, and refuses an empty prompt', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    expect(await screen.findByText('No projects learned yet.')).toBeInTheDocument()
    await user.clear(screen.getByTestId('settings-tickets-prompt'))
    await user.click(screen.getByTestId('settings-save'))

    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'The start prompt cannot be empty'
    )
    expect(fakeBridge.configSetCalls()).toEqual([])
  })
})

describe('SettingsView instructions', () => {
  it('loads the file the config names into the editor and saves edits through the bridge', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig(
      { instructionsFile: '/Users/dev/notes/delegation.md' },
      { instructions_file: '/Users/dev/notes/delegation.md' }
    )
    fakeBridge.seedInstructions('Delegate broad searches to a smaller model.\n')
    await openSettings(user)

    expect(await screen.findByTestId('settings-instructions-file')).toHaveValue(
      '/Users/dev/notes/delegation.md'
    )
    const content = screen.getByTestId('settings-instructions-content')
    await waitFor(() => {
      expect(content).toHaveValue('Delegate broad searches to a smaller model.\n')
    })
    expect(content).toBeEnabled()
    expect(screen.queryByTestId('settings-instructions-unset')).not.toBeInTheDocument()

    await user.type(content, 'Run tests before a commit.')
    await user.click(screen.getByRole('button', { name: 'Save instructions' }))

    expect(await screen.findByTestId('settings-instructions-saved')).toHaveTextContent('Saved')
    expect(fakeBridge.instructionsSetCalls()).toEqual([
      'Delegate broad searches to a smaller model.\nRun tests before a commit.'
    ])
    expect(fakeBridge.configSetCalls()).toEqual([])
  })

  it('disables the editor with a hint until a file is set, then saves the path as a config patch', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    const content = await screen.findByTestId('settings-instructions-content')
    expect(content).toBeDisabled()
    expect(screen.getByTestId('settings-instructions-unset')).toHaveTextContent(
      'Set a file above and save to edit the instructions here.'
    )
    expect(screen.getByRole('button', { name: 'Save instructions' })).toBeDisabled()

    await user.type(screen.getByTestId('settings-instructions-file'), '~/notes/delegation.md')
    await user.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    expect(fakeBridge.configSetCalls()[0].patch).toMatchObject({
      instructions_file: '~/notes/delegation.md'
    })
    await waitFor(() => expect(content).toBeEnabled())
    expect(screen.queryByTestId('settings-instructions-unset')).not.toBeInTheDocument()
  })

  it('refuses a relative path, saying why', async () => {
    const user = userEvent.setup()
    await openSettings(user)

    await user.type(await screen.findByTestId('settings-instructions-file'), 'notes/delegation.md')
    await user.click(screen.getByTestId('settings-save'))

    expect(await screen.findByTestId('settings-error')).toHaveTextContent(
      'The instructions file must be an absolute path or start with ~'
    )
    expect(fakeBridge.configSetCalls()).toEqual([])
  })

  it('removes the key when the path is cleared', async () => {
    const user = userEvent.setup()
    fakeBridge.setConfig(
      { instructionsFile: '/Users/dev/notes/delegation.md' },
      { instructions_file: '/Users/dev/notes/delegation.md' }
    )
    await openSettings(user)

    await user.clear(await screen.findByTestId('settings-instructions-file'))
    await user.click(screen.getByTestId('settings-save'))

    await waitFor(() => expect(fakeBridge.configSetCalls()).toHaveLength(1))
    expect(fakeBridge.configSetCalls()[0].patch).toMatchObject({ instructions_file: null })
    await waitFor(() => {
      expect(screen.getByTestId('settings-instructions-content')).toBeDisabled()
    })
  })
})
