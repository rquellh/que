// The review journey end to end: a workspace made from the CLI with a file
// edited in its worktree; the top bar's toggle opens the review pane on Changes,
// a full-height column at the window's right edge beside the terminals, which
// stay as they are; clicking the file opens its diff as a
// tab beside the terminal tab (once, however often it is clicked); with the
// edit and a second file committed, the Commits menu narrows the list to one
// commit and back, and the base menu compares against another branch; the Files
// tab shows the worktree as a tree with an untracked file under a folded
// directory, opens an unchanged file as a read-only tab and a changed one as its
// diff, collapses a directory, and Refresh drops a deleted file; the pane
// drags wider; Pull request shows no pull request, then one appears (through
// the fake GitHub CLI) with its checks and conversation, and Refresh picks up a
// new comment; the app quits and relaunches on the same home and the pane, its
// tab, its width, the chosen base, the diff tab and the file tab come back; ⌘W
// closes the diff tab and the file tab, and the pane closes and opens again on
// the tab it was left on.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Project, Workspace } from '../../src/shared/types'
import {
  fakeCheckRun,
  fakeComment,
  fakeLineComment,
  fakeReview,
  setFakePullRequest
} from '../../src/testing/fakes'
import { AppShellPage } from './pages/AppShellPage'
import { ChangesPage } from './pages/ChangesPage'
import { DiffPage } from './pages/DiffPage'
import { FilesPage } from './pages/FilesPage'
import { FileViewPage } from './pages/FileViewPage'
import { PullRequestPage } from './pages/PullRequestPage'
import { ReviewPage } from './pages/ReviewPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { TopBarPage } from './pages/TopBarPage'
import { type LaunchedApp, launchApp, newQueHome } from './utils/app'
import { queJson } from './utils/que'
import { makeRepo } from './utils/repo'

let launched: LaunchedApp

/** Runs git in a directory and returns its trimmed output; commits as a fixed test author. */
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=que e2e',
      '-c',
      'user.email=e2e@que.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd: dir, encoding: 'utf8' }
  ).trim()
}

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('The review pane lists the changes beside the terminals, opens diffs as tabs, and survives a relaunch', async () => {
  const repo = makeRepo({ origin: true })
  // The tracker polls every second here, so a pull request shows up right after it is seeded.
  const queHome = newQueHome('pr_poll_seconds = 1\n[quiet_hours]\nenabled = false\n')
  const prsFile = join(queHome, 'fake-gh-prs.json')
  let project: Project
  let workspace: Workspace
  let shell: AppShellPage
  let sidebar: SidebarPage
  let topbar: TopBarPage
  let terminal: TerminalPage
  let review: ReviewPage
  let changes: ChangesPage
  let diff: DiffPage
  let files: FilesPage
  let fileView: FileViewPage
  let pr: PullRequestPage
  let termId = ''
  let widened = 0
  let sha1 = ''
  let sha2 = ''

  const pages = (): void => {
    shell = new AppShellPage(launched.window)
    sidebar = new SidebarPage(launched.window)
    topbar = new TopBarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    review = new ReviewPage(launched.window)
    changes = new ChangesPage(launched.window)
    diff = new DiffPage(launched.window)
    files = new FilesPage(launched.window)
    fileView = new FileViewPage(launched.window)
    pr = new PullRequestPage(launched.window)
  }

  await test.step('A project and a workspace from the CLI', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    workspace = queJson<Workspace>(
      queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
    expect(workspace.projectId).toBe(project.id)
  })

  await test.step('Launch the app and open the workspace', async () => {
    launched = await launchApp({ queHome })
    pages()
    await sidebar.waitForLoad()
    await sidebar.waitForWorkspaceStatus(workspace.id, 'idle')
    await sidebar.workspaceOpen(workspace.id).click()
    termId = await terminal.waitForActiveTerminal()
  })

  await test.step('Edit a file; the toggle opens the review pane on Changes beside the terminal', async () => {
    writeFileSync(join(workspace.path, 'README.md'), '# uploader\n\nRetries with backoff.\n')
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'false')
    await topbar.reviewToggle.click()
    await expect(review.root).toBeVisible()
    await expect(review.root).toHaveAttribute('data-tab', 'changes')
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'true')
    expect(await review.state()).toMatchObject({ open: true, tab: 'changes' })
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(terminal.viewport).toBeVisible()
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(changes.summary).toHaveText('Commits 0 vs origin/main')
    await expect(changes.commits).toHaveText('0')
    await expect(changes.base).toHaveText('origin/main')
    await expect(changes.summary).toHaveAttribute('title', /· 1 file ·/)
    await expect(changes.file(0)).toContainText('README.md')
    await expect(changes.file(0)).toContainText('+2')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'README.md')
  })

  await test.step('The pane runs the full height of the window, like the sidebar', async () => {
    const shellBox = await shell.root.boundingBox()
    const paneBox = await review.root.boundingBox()
    const sidebarBox = await sidebar.root.boundingBox()
    expect(shellBox).not.toBeNull()
    expect(paneBox).not.toBeNull()
    expect(sidebarBox).not.toBeNull()
    expect(paneBox?.y).toBe(0)
    expect(paneBox?.height).toBe(shellBox?.height)
    expect(sidebarBox?.y).toBe(0)
    expect(sidebarBox?.height).toBe(shellBox?.height)
    // The pane sits at the window's right edge; the top bar ends where it begins.
    expect((paneBox?.x ?? 0) + (paneBox?.width ?? 0)).toBe(
      (shellBox?.x ?? 0) + (shellBox?.width ?? 0)
    )
    const topbarBox = await topbar.root.boundingBox()
    expect((topbarBox?.x ?? 0) + (topbarBox?.width ?? 0)).toBeLessThanOrEqual(paneBox?.x ?? 0)
  })

  await test.step('Clicking the file opens its diff as a tab beside the terminal tab', async () => {
    await changes.file(0).click()
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(terminal.pane(0).diffTabs).toHaveCount(1)
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(diff.root).toHaveAttribute('data-path', 'README.md')
    await expect(diff.header).toContainText('README.md · +2')
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await expect(changes.file(0)).toHaveAttribute('data-active', 'true')
    await expect
      .poll(async () => (await terminal.panes())[0]?.activeTab)
      .toBe('view:diff:README.md')
    await launched.window.screenshot({ path: 'test-results/review-changes.png' })
  })

  await test.step('Back on the terminal, the file again focuses the same diff tab', async () => {
    await terminal.tabSelect(termId).click()
    await expect(terminal.viewport).toBeVisible()
    await expect(changes.file(0)).toHaveAttribute('data-active', 'false')
    await changes.file(0).click()
    await expect(diff.tabs).toHaveCount(1)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Retries with backoff.')
  })

  await test.step('Two commits: the summary counts them and the list shows both files', async () => {
    git(workspace.path, 'add', 'README.md')
    git(workspace.path, 'commit', '--quiet', '-m', 'Document retries')
    writeFileSync(join(workspace.path, 'NOTES.md'), '# notes\n\nBackoff caps at 30s.\n')
    git(workspace.path, 'add', 'NOTES.md')
    git(workspace.path, 'commit', '--quiet', '-m', 'Add notes')
    sha2 = git(workspace.path, 'rev-parse', 'HEAD')
    sha1 = git(workspace.path, 'rev-parse', 'HEAD~1')
    // No Refresh: the daemon watches the worktree, and the commits reach Changes on their own.
    await expect(changes.summary).toHaveText('Commits 2 vs origin/main')
    await expect(changes.summary).toHaveAttribute('title', /· 2 files ·/)
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveAttribute('data-path', 'README.md')
    await expect(changes.file(2)).toHaveCount(0)
  })

  await test.step('The Commits menu narrows the list to one commit, and All commits restores it', async () => {
    await changes.commitsMenu.click()
    await expect(changes.commitItems).toHaveCount(3)
    await expect(changes.commitItems.nth(0)).toHaveAttribute('data-testid', 'changes-commit-all')
    await expect(changes.commitAll).toHaveAttribute('aria-checked', 'true')
    await expect(changes.commitItems.nth(1)).toHaveAttribute(
      'data-testid',
      `changes-commit-${sha2}`
    )
    await expect(changes.commitItems.nth(2)).toHaveAttribute(
      'data-testid',
      `changes-commit-${sha1}`
    )
    await expect(changes.commit(sha2)).toContainText(`${sha2.slice(0, 7)} Add notes`)
    await expect(changes.commit(sha1)).toContainText(`${sha1.slice(0, 7)} Document retries`)
    await expect(changes.commit(sha1)).toHaveAttribute('aria-checked', 'false')
    await changes.commit(sha1).click()
    await expect(changes.commitItems).toHaveCount(0)
    await expect(changes.summary).toHaveText(`Commit ${sha1.slice(0, 7)} vs origin/main`)
    await expect(changes.commits).toHaveText(sha1.slice(0, 7))
    await expect(changes.file(0)).toHaveAttribute('data-path', 'README.md')
    await expect(changes.file(1)).toHaveCount(0)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await changes.commitsMenu.click()
    await expect(changes.commit(sha1)).toHaveAttribute('aria-checked', 'true')
    await changes.commitAll.click()
    await expect(changes.summary).toHaveText('Commits 2 vs origin/main')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveAttribute('data-path', 'README.md')
  })

  await test.step('The base menu compares against another branch', async () => {
    git(repo, 'branch', 'release', sha1)
    await changes.refresh.click()
    await changes.baseMenu.click()
    await expect(changes.baseOption(0)).toHaveAttribute('data-ref', 'origin/main')
    await expect(changes.baseOption(0)).toHaveAttribute('aria-checked', 'true')
    await expect(changes.baseRef('main')).toHaveAttribute('aria-checked', 'false')
    await expect(changes.baseRef('release')).toHaveAttribute('aria-checked', 'false')
    await launched.window.screenshot({ path: 'test-results/changes-menus.png' })
    await changes.baseRef('release').click()
    await expect(changes.baseOptions).toHaveCount(0)
    await expect(changes.summary).toHaveText('Commits 1 vs release')
    await expect(changes.base).toHaveText('release')
    await expect(changes.file(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(changes.file(1)).toHaveCount(0)
  })

  await test.step('An untracked file: the Files tab shows the tree, changed files marked', async () => {
    mkdirSync(join(workspace.path, 'src/upload'), { recursive: true })
    writeFileSync(join(workspace.path, 'src/upload/retry.ts'), 'export const retries = 3\n')
    // No Refresh: the write reaches Changes through the watcher, so the tree opens knowing it.
    await expect(changes.file(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
    await review.tabFiles.click()
    await expect(review.root).toHaveAttribute('data-tab', 'files')
    await expect(review.tabFiles).toHaveAttribute('aria-selected', 'true')
    expect(await review.state()).toMatchObject({ open: true, tab: 'files' })
    await expect(files.summary).toHaveText('Files 4 · 2 changed')
    await expect(files.count).toHaveText('4')
    await expect(files.rows).toHaveCount(5)
    // Directories first, the one-entry chain folded into one row, open because it holds a change.
    await expect(files.row(0)).toHaveAttribute('data-path', 'src/upload')
    await expect(files.row(0)).toHaveAttribute('data-kind', 'dir')
    await expect(files.row(0)).toHaveAttribute('aria-expanded', 'true')
    await expect(files.row(0)).toHaveAttribute('aria-level', '1')
    await expect(files.row(0)).toContainText('src/upload')
    await expect(files.rowCount(0)).toHaveText('1')
    await expect(files.row(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
    await expect(files.row(1)).toHaveAttribute('data-kind', 'file')
    await expect(files.row(1)).toHaveAttribute('aria-level', '2')
    await expect(files.row(1)).toContainText('retry.ts?')
    // Then the root files, case-insensitively: README.md after que.toml.
    await expect(files.row(2)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(files.row(2)).toHaveAttribute('aria-level', '1')
    await expect(files.row(2)).toContainText('NOTES.mdA')
    await expect(files.row(3)).toHaveAttribute('data-path', 'que.toml')
    await expect(files.row(3)).toHaveText('que.toml')
    await expect(files.row(4)).toHaveAttribute('data-path', 'README.md')
    await expect(files.row(4)).toHaveText('README.md')
    await expect(terminal.tab(termId)).toBeVisible()
  })

  await test.step('An unchanged file opens as a read-only tab; a changed one opens its diff', async () => {
    await files.rowByPath('que.toml').click()
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.tabs).toHaveCount(1)
    await expect(terminal.tab(termId)).toBeVisible()
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe('view:file:que.toml')
    await expect(fileView.root('que.toml')).toBeVisible()
    await expect(fileView.header).toHaveText('que.toml')
    // The line number, then the line.
    await expect(fileView.text).toHaveText('1setup = "true"')
    await expect(files.rowByPath('que.toml')).toHaveAttribute('data-active', 'true')
    await files.rowByPath('que.toml').click()
    await expect(fileView.tabs).toHaveCount(1)
    await files.rowByPath('NOTES.md').click()
    await expect(diff.tab('NOTES.md')).toHaveAttribute('data-active', 'true')
    await expect(diff.patch).toContainText('+Backoff caps at 30s.')
    await expect(fileView.tab('NOTES.md')).toHaveCount(0)
    await expect(files.rowByPath('NOTES.md')).toHaveAttribute('data-active', 'true')
    await expect(files.rowByPath('que.toml')).toHaveAttribute('data-active', 'false')
    // Closing the diff tab selects its neighbour, the file tab.
    await diff.tabClose('NOTES.md').click()
    await expect(diff.tabs).toHaveCount(1)
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
    await launched.window.screenshot({ path: 'test-results/files-tab.png' })
  })

  await test.step('A directory row collapses and opens again', async () => {
    await files.rowByPath('src/upload').click()
    await expect(files.rowByPath('src/upload')).toHaveAttribute('aria-expanded', 'false')
    await expect(files.rowByPath('src/upload/retry.ts')).toHaveCount(0)
    await expect(files.rows).toHaveCount(4)
    await files.rowByPath('src/upload').click()
    await expect(files.rowByPath('src/upload')).toHaveAttribute('aria-expanded', 'true')
    await expect(files.row(1)).toHaveAttribute('data-path', 'src/upload/retry.ts')
  })

  await test.step('Refresh drops a deleted file and its directory', async () => {
    rmSync(join(workspace.path, 'src'), { recursive: true })
    await files.refresh.click()
    await expect(files.rowByPath('src/upload')).toHaveCount(0)
    await expect(files.count).toHaveText('3')
    await expect(files.summary).toHaveText('Files 3 · 1 changed')
    await expect(files.row(0)).toHaveAttribute('data-path', 'NOTES.md')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
  })

  await test.step('Dragging the resizer 80px left widens the pane by about 80px', async () => {
    const before = (await review.state()).width
    expect(before).toBe(320)
    const box = await review.resizer.boundingBox()
    expect(box).not.toBeNull()
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number }
    await launched.window.mouse.move(x + width / 2, y + height / 2)
    await launched.window.mouse.down()
    await launched.window.mouse.move(x + width / 2 - 80, y + height / 2, { steps: 6 })
    await launched.window.mouse.up()
    await expect.poll(async () => (await review.state()).width).toBeGreaterThanOrEqual(before + 76)
    widened = (await review.state()).width
    expect(widened).toBeLessThanOrEqual(before + 84)
    await expect(review.resizer).toHaveAttribute('aria-valuenow', String(widened))
    await launched.window.screenshot({ path: 'test-results/review-pane.png' })
  })

  await test.step('The Pull request tab switches the pane over: no pull request yet', async () => {
    await review.tabPr.click()
    await expect(review.root).toHaveAttribute('data-tab', 'pr')
    await expect(review.tabPr).toHaveAttribute('aria-selected', 'true')
    await expect(review.tabChanges).toHaveAttribute('aria-selected', 'false')
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(pr.empty).toHaveText('No pull request yet')
    await expect(pr.create).toHaveText('Create draft PR')
    expect(await review.state()).toMatchObject({ open: true, tab: 'pr' })
    await expect(diff.tab('README.md')).toBeVisible()
  })

  await test.step('A pull request appears: its checks and conversation fill the pane', async () => {
    setFakePullRequest(prsFile, workspace.branch, {
      number: 7,
      url: 'https://github.com/rquellh/que/pull/7',
      title: 'Add retry logic',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      updatedAt: '2026-10-14T03:05:00Z',
      statusCheckRollup: [
        fakeCheckRun({ name: 'build' }),
        fakeCheckRun({
          name: 'lint',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/rquellh/que/actions/runs/42'
        })
      ],
      comments: [
        fakeComment({
          author: 'reviewer',
          body: 'Looks close. One nit below.',
          createdAt: '2026-10-14T03:00:00Z'
        })
      ],
      reviews: [
        fakeReview({
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          body: 'Please add a test for the retry cap.',
          submittedAt: '2026-10-14T03:02:00Z'
        })
      ],
      lineComments: [
        fakeLineComment({
          author: 'reviewer',
          body: 'Backoff should be capped.',
          path: 'README.md',
          line: 3,
          createdAt: '2026-10-14T03:01:00Z'
        })
      ]
    })
    await expect(pr.headerLink).toContainText('#7 · open · Add retry logic', { timeout: 15_000 })
    await expect(pr.headerLink).toHaveAttribute('href', 'https://github.com/rquellh/que/pull/7')
    await expect(pr.review).toHaveAttribute('data-review', 'changes_requested')
    await expect(pr.checksSummary).toHaveText('1 passing · 1 failing')
    await expect(pr.check(0)).toHaveAttribute('data-state', 'failing')
    await expect(pr.check(0)).toContainText('lint')
    await expect(pr.checkLink(0)).toHaveAttribute(
      'href',
      'https://github.com/rquellh/que/actions/runs/42'
    )
    await expect(pr.check(1)).toHaveAttribute('data-state', 'passing')
    await expect(pr.check(1)).toContainText('build')
    // Oldest first: the comment, the line comment, then the review.
    await expect(pr.comment(0)).toHaveAttribute('data-kind', 'comment')
    await expect(pr.comment(0)).toContainText('Looks close. One nit below.')
    await expect(pr.comment(1)).toHaveAttribute('data-kind', 'line')
    await expect(pr.comment(1)).toContainText('README.md:3')
    await expect(pr.comment(1)).toContainText('Backoff should be capped.')
    await expect(pr.comment(2)).toHaveAttribute('data-kind', 'review')
    await expect(pr.comment(2)).toContainText('changes requested')
    await expect(pr.comment(2)).toContainText('Please add a test for the retry cap.')
    await expect(pr.footerLink).toHaveAttribute('href', 'https://github.com/rquellh/que/pull/7')
    await launched.window.screenshot({ path: 'test-results/review-pull-request-filled.png' })
  })

  await test.step('Refresh fetches the conversation again and shows a new comment', async () => {
    setFakePullRequest(prsFile, workspace.branch, {
      comments: [
        fakeComment({
          author: 'reviewer',
          body: 'Looks close. One nit below.',
          createdAt: '2026-10-14T03:00:00Z'
        }),
        fakeComment({
          author: 'author',
          body: 'Capped it; test added.',
          createdAt: '2026-10-14T03:10:00Z'
        })
      ]
    })
    await pr.refresh.click()
    await expect(pr.comment(3)).toContainText('Capped it; test added.')
    await expect(pr.comment(3)).toHaveAttribute('data-kind', 'comment')
  })

  await test.step('Back on the Files tab with the diff tab selected, before the quit', async () => {
    await review.tabFiles.click()
    await expect(review.root).toHaveAttribute('data-tab', 'files')
    await diff.tabSelect('README.md').click()
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'false')
  })

  await test.step('Quit the app; relaunch on the same home: the pane, the diff tab and the file tab come back', async () => {
    await launched.app.close() // the app only, NOT launched.close(), which also stops the daemon
    launched = await launchApp({ queHome: launched.queHome })
    pages()
    await sidebar.waitForLoad()
    await sidebar.workspaceOpen(workspace.id).click()
    await expect(review.root).toHaveAttribute('data-tab', 'files')
    expect(await review.state()).toEqual({ open: true, tab: 'files', width: widened })
    await expect(files.summary).toHaveText('Files 3 · 1 changed')
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'false')
    await expect(terminal.pane(0).diffTabs).toHaveCount(1)
    await expect(diff.tab('README.md')).toHaveAttribute('data-active', 'true')
    await review.tabPr.click()
    await expect(review.root).toHaveAttribute('data-tab', 'pr')
    expect(await review.state()).toEqual({ open: true, tab: 'pr', width: widened })
    await expect(pr.headerLink).toContainText('#7 · open · Add retry logic')
    // The base chosen before the quit is remembered: README.md is unchanged against it.
    await review.tabChanges.click()
    await expect(changes.base).toHaveText('release')
    await expect(changes.summary).toHaveText('Commits 1 vs release')
    await expect(diff.empty).toHaveText('No changes in README.md')
    await changes.baseMenu.click()
    await expect(changes.baseRef('release')).toHaveAttribute('aria-checked', 'true')
    await changes.baseRef('origin/main').click()
    await expect(changes.summary).toHaveText('Commits 2 vs origin/main')
    await expect(diff.patch).toContainText('+Retries with backoff.')
    await expect(terminal.tab(termId)).toBeVisible()
    await review.tabPr.click()
    await expect(review.root).toHaveAttribute('data-tab', 'pr')
    // The file tab came back too and still shows the file.
    await fileView.tabSelect('que.toml').click()
    await expect(fileView.tab('que.toml')).toHaveAttribute('data-active', 'true')
    await expect(fileView.text).toHaveText('1setup = "true"')
  })

  await test.step('⌘W closes the selected diff tab; the terminal tab is active again', async () => {
    await diff.tabSelect('README.md').click()
    await launched.window.keyboard.press('Meta+w')
    await expect(diff.tabs).toHaveCount(0)
    await expect(diff.root).toHaveCount(0)
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(terminal.viewport).toBeVisible()
    await expect(terminal.tab(termId)).toBeVisible()
    await expect(fileView.tab('que.toml')).toBeVisible()
  })

  await test.step('⌘W closes the selected file tab too', async () => {
    await fileView.tabSelect('que.toml').click()
    await expect(fileView.root('que.toml')).toBeVisible()
    await launched.window.keyboard.press('Meta+w')
    await expect(fileView.tabs).toHaveCount(0)
    await expect(fileView.root('que.toml')).toHaveCount(0)
    await expect.poll(async () => (await terminal.panes())[0]?.activeTab).toBe(termId)
    await expect(terminal.viewport).toBeVisible()
  })

  await test.step('The toggle closes the pane and opens it again on the tab it was left on', async () => {
    await topbar.reviewToggle.click()
    await expect(review.root).toHaveCount(0)
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'false')
    await topbar.reviewToggle.click()
    await expect(review.root).toHaveAttribute('data-tab', 'pr')
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('The close button closes the pane; the toggle opens it again, then Changes', async () => {
    await review.close.click()
    await expect(review.root).toHaveCount(0)
    expect((await review.state()).open).toBe(false)
    await expect(topbar.reviewToggle).toHaveAttribute('aria-pressed', 'false')
    await topbar.reviewToggle.click()
    await review.tabChanges.click()
    await expect(review.root).toHaveAttribute('data-tab', 'changes')
    await expect(changes.file(1)).toContainText('README.md')
    expect(await review.state()).toEqual({ open: true, tab: 'changes', width: widened })
  })
})
