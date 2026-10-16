import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeBridge } from '@renderer/testing/fake-bridge'
import { makeProject, makeWorkspace } from '@renderer/testing/fixtures'
import App from '../App'

const uploader = makeProject()
const retry = makeWorkspace({
  id: 'ws_01hzx3k9c2qf',
  name: 'app-1432-retry-logic',
  sessionId: 'b3c1d2e4-0000-4000-8000-1a2b3c4d5e6f'
})

async function openRetry(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  fakeBridge.seedProject(uploader)
  fakeBridge.seedWorkspace(retry)
  render(<App />)
  await user.click(await screen.findByTestId(`sidebar-workspace-${retry.id}-open`))
}

describe('work-mode dialogs', () => {
  describe('new workspace', () => {
    it('offers a random name, draws another on New name, and slugs a typed one live', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'New workspace in uploader' }))
      const dialog = screen.getByRole('dialog', { name: 'New workspace' })
      const brief = within(dialog).getByRole('textbox', { name: 'What are you doing?' })
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })
      const submit = within(dialog).getByRole('button', { name: 'Create workspace' })
      expect(brief).toHaveFocus()
      expect((name as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
      expect(submit).toBeDisabled() // starting Claude needs a brief

      await user.type(brief, 'Retry uploads{Shift>}{Enter}{/Shift}Back off three times.')
      expect(submit).toBeEnabled()
      const drawn = new Set([(name as HTMLInputElement).value])
      for (let i = 0; i < 5; i++) {
        await user.click(within(dialog).getByRole('button', { name: 'New name' }))
        expect((name as HTMLInputElement).value).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)
        drawn.add((name as HTMLInputElement).value)
      }
      expect(drawn.size).toBeGreaterThan(1)

      await user.clear(name)
      await user.type(name, '!!!')
      expect(submit).toBeDisabled()
      expect(within(dialog).getByTestId('dialog-new-workspace-slug')).toHaveTextContent(
        /Use letters, digits/
      )
      await user.clear(name)
      await user.type(name, 'APP-1432 Retry logic')
      expect(within(dialog).getByTestId('dialog-new-workspace-slug')).toHaveTextContent(
        'Becomes app-1432-retry-logic'
      )
      expect(submit).toBeEnabled()
    })

    it('shows a name clash in the dialog and keeps it open', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      fakeBridge.seedWorkspace(makeWorkspace({ projectId: uploader.id, name: 'calm-amber-otter' }))
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'New workspace in uploader' }))
      const dialog = screen.getByRole('dialog', { name: 'New workspace' })
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })
      await user.type(within(dialog).getByRole('textbox', { name: 'What are you doing?' }), 'x')
      await user.clear(name)
      await user.type(name, 'calm-amber-otter')
      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'workspace calm-amber-otter already exists'
      )
      expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeInTheDocument()
    })

    it('creates the workspace from the brief and starts claude in its only terminal', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'New workspace in uploader' }))
      const dialog = screen.getByRole('dialog', { name: 'New workspace' })
      expect(
        within(dialog).getByRole('checkbox', { name: 'Start Claude with this brief' })
      ).toBeChecked()
      const name = (
        within(dialog).getByRole('textbox', { name: 'Branch and folder' }) as HTMLInputElement
      ).value
      await user.click(within(dialog).getByText('Advanced'))
      await user.type(within(dialog).getByRole('textbox', { name: /Base ref/ }), 'origin/release')

      await user.type(
        within(dialog).getByRole('textbox', { name: 'What are you doing?' }),
        'Add retry logic to the uploader{Shift>}{Enter}{/Shift}Back off exponentially.'
      )
      await user.keyboard('{Meta>}{Enter}{/Meta}')

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      })
      expect(fakeBridge.createWorkspaceCalls()).toEqual([
        {
          projectId: uploader.id,
          brief: 'Add retry logic to the uploader\nBack off exponentially.',
          name,
          baseRef: 'origin/release'
        }
      ])
      const [ws] = await window.que.workspace.list()
      expect(ws).toMatchObject({ name, title: 'Add retry logic to the uploader' })
      expect(fakeBridge.startCalls()).toEqual([ws.id])
      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(1)
      })
      expect(await window.que.term.list({ workspaceId: ws.id })).toHaveLength(1)
    })

    it('only opens a shell when start is off', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      await user.click(await screen.findByRole('button', { name: 'New workspace in uploader' }))
      const dialog = screen.getByRole('dialog', { name: 'New workspace' })
      const name = within(dialog).getByRole('textbox', { name: 'Branch and folder' })

      await user.click(
        within(dialog).getByRole('checkbox', { name: 'Start Claude with this brief' })
      )
      await user.clear(name)
      await user.type(name, 'fix-flaky-upload')
      await user.click(within(dialog).getByRole('button', { name: 'Create workspace' }))

      await waitFor(() => {
        expect(screen.getAllByRole('tab')).toHaveLength(1)
      })
      expect(fakeBridge.startCalls()).toEqual([])
      expect(screen.getByTestId('topbar-title')).toHaveTextContent('fix-flaky-upload')
    })

    it('returns focus to the opener when cancelled with Escape', async () => {
      const user = userEvent.setup()
      fakeBridge.seedProject(uploader)
      render(<App />)
      const opener = await screen.findByRole('button', { name: 'New workspace in uploader' })
      await user.click(opener)

      await user.keyboard('{Escape}')

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })
  })

  describe('review pane', () => {
    it('creates a draft PR from Pull request and shows its URL', async () => {
      const user = userEvent.setup()
      await openRetry(user)
      await user.click(await screen.findByRole('button', { name: 'Review pane' }))
      await user.click(screen.getByRole('tab', { name: 'Pull request' }))

      await user.click(await screen.findByRole('button', { name: 'Create draft PR' }))
      const dialog = screen.getByRole('dialog', { name: `Draft PR from ${retry.branch}` })
      await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Add retry logic')
      await user.click(within(dialog).getByRole('button', { name: 'Create draft PR' }))

      const link = await within(dialog).findByRole('link', { name: /pull\/41$/ })
      expect(link).toHaveAttribute('href', 'https://github.com/rquellh/que/pull/41')
      expect(fakeBridge.createPrCalls()).toEqual([{ id: retry.id, title: 'Add retry logic' }])
      expect(screen.getByTestId('topbar-pr')).toHaveTextContent('PR #41')
    })
  })
})
