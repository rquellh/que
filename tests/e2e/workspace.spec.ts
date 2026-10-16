// The workspace journey end to end: the CLI creates a project and a workspace
// in the launched app's daemon, the workspace terminal shows up as a tab, and
// a Claude Code session typed into it (the fake, through que's hooks wrapper)
// reports needs input back to `que status`, and the report lists the workspace
// as waiting. And a workspace made from a brief in the dialog: under a random
// three-word name, titled with its first line in the sidebar (the brief on hover), and claude
// started on the brief itself in its only terminal.
import { expect, test } from '@playwright/test'
import type { StatusJson } from '../../src/cli/workspaces'
import type { TermInfo } from '../../src/shared/protocol'
import type { Project, Workspace } from '../../src/shared/types'
import { AppShellPage } from './pages/AppShellPage'
import { ReportPage } from './pages/ReportPage'
import { SidebarPage } from './pages/SidebarPage'
import { TerminalPage } from './pages/TerminalPage'
import { type LaunchedApp, launchApp, newQueHome } from './utils/app'
import { que, queJson } from './utils/que'
import { makeRepo } from './utils/repo'

let launched: LaunchedApp

test.afterEach(async () => {
  await launched?.close() // quits the app AND stops the test daemon
})

test('a claude session in a workspace terminal reports needs input to que status', async () => {
  const repo = makeRepo()
  let workspace: Workspace
  let termId = ''
  let terminal: TerminalPage
  let sidebar: SidebarPage
  const statusOf = () =>
    queJson<StatusJson>(launched.queHome, 'status', '--json').workspaces.find(
      (w) => w.id === workspace.id
    )

  await test.step('Launch the app on a fresh QUE_HOME', async () => {
    launched = await launchApp()
    await new AppShellPage(launched.window).waitForLoad()
    terminal = new TerminalPage(launched.window)
    sidebar = new SidebarPage(launched.window)
    await terminal.waitForActiveTerminal()
  })

  await test.step('Add the project and create a workspace with the CLI', async () => {
    const project = queJson<Project>(launched.queHome, 'project', 'add', repo, '--json')
    expect(project).toMatchObject({
      path: expect.stringContaining('que-e2e-repo-'),
      defaultBranch: 'main'
    })
    workspace = queJson<Workspace>(
      launched.queHome,
      'work',
      '--name',
      'APP-1432 retry logic',
      '-r',
      repo,
      '--json'
    )
    expect(workspace).toMatchObject({
      projectId: project.id,
      name: 'app-1432-retry-logic',
      branch: 'app-1432-retry-logic',
      status: 'idle'
    })
  })

  await test.step("Open the workspace's terminal; it appears as a tab under the workspace", async () => {
    termId = que(launched.queHome, 'ws', 'terminal', workspace.id).trim()
    await expect(sidebar.workspace(workspace.id)).toBeVisible()
    await sidebar.workspaceOpen(workspace.id).click()
    await expect(terminal.tab(termId)).toBeVisible()
    await terminal.tabSelect(termId).click()
    await expect.poll(() => terminal.activeTermId()).toBe(termId)
  })

  await test.step('Start claude in it; the session reports in', async () => {
    await terminal.input.focus()
    await launched.window.keyboard.type('claude')
    await launched.window.keyboard.press('Enter')
    await expect
      .poll(() => statusOf()?.sessionId ?? null, {
        message: 'no session reported',
        timeout: 30_000
      })
      .toMatch(/^[0-9a-f-]{36}$/)
  })

  await test.step('Ask for something that needs permission; que status says needs input', async () => {
    await launched.window.keyboard.type('/needs-input')
    await launched.window.keyboard.press('Enter')
    await expect.poll(() => statusOf()?.status, { timeout: 30_000 }).toBe('needs_input')
    await sidebar.waitForWorkspaceStatus(workspace.id, 'needs_input')
    await terminal.expectScreenToContain('Claude needs your permission to use Bash. Allow? (y/n)')
    await launched.window.screenshot({ path: 'test-results/workspace-needs-input.png' })
  })

  await test.step('The report lists the workspace as waiting for input', async () => {
    const report = new ReportPage(launched.window)
    await sidebar.reportButton.click()
    await report.waitForLoad()
    await expect(report.workspace(workspace.id)).toBeVisible()
    await expect(report.workspaceFacts(workspace.id)).toContainText('asked for input 1×')
    await expect(report.workspaceFacts(workspace.id)).toContainText('waiting since')
    await expect(report.totals).toContainText('1 need input')
  })
})

test('a workspace described in a brief gets a random name, is titled with it, and starts claude on it', async () => {
  const repo = makeRepo()
  const queHome = newQueHome()
  const brief = 'Raise the upload timeout\n\nThe upload test times out on slow CI runners.'
  let project: Project
  let workspace: Workspace
  let name = ''
  let sidebar: SidebarPage
  let terminal: TerminalPage

  await test.step('Register the project with the CLI and launch the app', async () => {
    project = queJson<Project>(queHome, 'project', 'add', repo, '--json')
    launched = await launchApp({ queHome })
    sidebar = new SidebarPage(launched.window)
    terminal = new TerminalPage(launched.window)
    await sidebar.waitForLoad()
    await expect(sidebar.project(project.id)).toBeVisible()
  })

  await test.step('Describe the work under a random name, drawing another once', async () => {
    await sidebar.projectAddWorkspace(project.id).click()
    await sidebar.newWorkspaceBrief.fill(brief)
    await expect(sidebar.newWorkspaceName).toHaveValue(/^[a-z]+-[a-z]+-[a-z]+$/)
    await sidebar.newWorkspaceNewName.click()
    await expect(sidebar.newWorkspaceName).toHaveValue(/^[a-z]+-[a-z]+-[a-z]+$/)
    name = await sidebar.newWorkspaceName.inputValue()
    await expect(sidebar.newWorkspaceStart).toBeChecked()
    await sidebar.newWorkspaceSubmit.click()
    await expect(sidebar.newWorkspaceDialog).toHaveCount(0)
    const created = queJson<Workspace[]>(queHome, 'ws', 'list', '--json').find(
      (w) => w.name === name
    )
    expect(created).toMatchObject({ title: 'Raise the upload timeout', brief })
    workspace = created as Workspace
  })

  await test.step('The sidebar shows the title, and the brief on hover', async () => {
    await expect(sidebar.workspaceName(workspace.id)).toHaveText('Raise the upload timeout')
    await expect(sidebar.workspaceOpen(workspace.id)).toHaveAttribute(
      'title',
      `${brief}\n${workspace.path}`
    )
  })

  await test.step('Claude starts on the brief itself in the only terminal', async () => {
    await expect
      .poll(() => launched.claudeCalls().some((argv) => argv.at(-1) === brief), {
        message: 'claude never started on the brief',
        timeout: 30_000
      })
      .toBe(true)
    const terms = queJson<TermInfo[]>(queHome, 'term', 'list', '--json').filter(
      (t) => t.workspaceId === workspace.id
    )
    expect(terms).toHaveLength(1)
    await expect.poll(() => terminal.activeTermId()).toBe(terms[0].id)
    await launched.window.screenshot({ path: 'test-results/workspace-from-brief.png' })
  })
})
