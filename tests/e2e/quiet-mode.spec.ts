// Quiet mode end to end: a workspace with a running terminal made with the
// CLI, then quiet hours turned on (with `que config set`) around the current
// time. Launched inside them, the board is the only window shown, with the
// workspace counted and its row; the CLI's attach is refused (exit 3); Unlock
// brings the main window back with its countdown, and when the (six-second)
// unlock runs out the board returns on its own.
import { expect, test } from '@playwright/test'
import type { Workspace } from '../../src/shared/types'
import { QuietBoardPage } from './pages/QuietBoardPage'
import { TopBarPage } from './pages/TopBarPage'
import { findWindow, type LaunchedApp, launchApp, newQueHome, windowStates } from './utils/app'
import { que, queJson, queResult } from './utils/que'
import { makeRepo } from './utils/repo'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('quiet hours show only the board; an unlock brings detail back until it runs out', async () => {
  const repo = makeRepo()
  // A window an hour either side of now, and a 0.1-minute unlock.
  const now = Date.now()
  const windowEnd = hhmm(now + 60 * 60_000)
  const queHome = newQueHome()
  let workspace: Workspace
  let board: QuietBoardPage

  await test.step('Create a workspace with a running terminal with the CLI', async () => {
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'app-1500-quiet-board',
      '-r',
      repo,
      '--json'
    )
    expect(que(queHome, 'ws', 'terminal', workspace.id).trim()).toMatch(/^[0-9a-f-]{36}$/)
  })

  await test.step('Turn quiet hours on around now, with a 0.1-minute unlock', async () => {
    que(
      queHome,
      'config',
      'set',
      'quiet_hours.enabled=true',
      `quiet_hours.default=${hhmm(now - 60 * 60_000)},${windowEnd}`,
      'quiet_hours.unlock_minutes=0.1'
    )
    expect(que(queHome, 'quiet', 'status').trim()).toBe(`quiet hours until ${windowEnd}`)
  })

  await test.step('Launch: the board is the visible window, the main window is hidden', async () => {
    launched = await launchApp({ queHome })
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    await expect
      .poll(() => windowStates(launched.app))
      .toEqual(
        expect.arrayContaining([
          { board: true, visible: true },
          { board: false, visible: false }
        ])
      )
    await expect(board.header).toHaveText(
      new RegExp(`^que · quiet hours · \\d\\d:\\d\\d · detail unlocks at ${windowEnd}$`)
    )
    await expect(board.counts).toContainText('0 running · 0 paused · 0 stuck · 0 done')
    await expect(board.counts).toContainText('1 workspace · 0 working · 0 need input · 0 stuck')
    await expect(board.row(workspace.id)).toContainText('app-1500-quiet-board')
    await expect(board.row(workspace.id)).toHaveAttribute('data-state', 'idle')
    await expect(board.unlockButton).toHaveText('Unlock 0.1 min')
    await board.page.screenshot({ path: 'test-results/wp5-quiet-board.png' })
  })

  await test.step('The CLI refuses to attach while quiet, with exit code 3', async () => {
    const r = queResult(queHome, 'attach', workspace.id)
    expect(r.code).toBe(3)
    expect(r.stderr).toBe(`quiet hours until ${windowEnd}; run \`que unlock\` for 0.1 minutes\n`)
  })

  await test.step('Unlock: the main window comes back with the countdown', async () => {
    await board.unlockButton.click()
    const main = await findWindow(launched.app, false)
    const topbar = new TopBarPage(main)
    await expect.poll(() => windowStates(launched.app)).toEqual([{ board: false, visible: true }])
    await expect(topbar.unlockCountdown).toHaveText(/^🔓 unlocked · 0:0\d left$/)
    await expect(topbar.lockButton).toBeVisible()
  })

  await test.step('When the unlock runs out, the board returns with no prompt', async () => {
    await expect
      .poll(() => windowStates(launched.app), { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          { board: true, visible: true },
          { board: false, visible: false }
        ])
      )
    board = new QuietBoardPage(await findWindow(launched.app, true))
    await board.waitForLoad()
    expect(queResult(queHome, 'attach', workspace.id).code).toBe(3)
  })
})
