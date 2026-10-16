// Sessions (loose terminals) above projects → workspaces with their status badges,
// the report entry, the project context menu, and the new-workspace and
// remove-project dialogs.
import { expect, type Locator, type Page } from '@playwright/test'

export class SidebarPage {
  page: Page
  root: Locator
  resizer: Locator
  search: Locator
  searchToggle: Locator
  sortButton: Locator
  sessionsNoMatch: Locator
  projectsNoMatch: Locator
  emptyState: Locator
  addProjectButton: Locator
  sessionsAdd: Locator
  session: (id: string) => Locator
  sessionOpen: (id: string) => Locator
  reportButton: Locator
  newWorkspaceDialog: Locator
  newWorkspaceBrief: Locator
  newWorkspaceStart: Locator
  newWorkspaceName: Locator
  newWorkspaceNewName: Locator
  newWorkspaceSlug: Locator
  newWorkspaceSubmit: Locator
  removeProjectDialog: Locator
  removeProjectSubmit: Locator
  project: (id: string) => Locator
  projectToggle: (id: string) => Locator
  projectMenuRemove: (id: string) => Locator
  projectAddWorkspace: (id: string) => Locator
  workspace: (id: string) => Locator
  workspaceOpen: (id: string) => Locator
  workspaceName: (id: string) => Locator
  workspaceStatus: (id: string) => Locator
  workspacePr: (id: string) => Locator
  workspaceMenu: (id: string) => Locator

  constructor(page: Page) {
    this.page = page
    this.root = page.getByTestId('sidebar')
    this.resizer = page.getByTestId('sidebar-resizer')
    this.search = page.getByTestId('sidebar-search')
    this.searchToggle = page.getByTestId('sidebar-search-toggle')
    this.sortButton = page.getByTestId('sidebar-sort')
    this.sessionsNoMatch = page.getByTestId('sidebar-sessions-nomatch')
    this.projectsNoMatch = page.getByTestId('sidebar-projects-nomatch')
    this.emptyState = page.getByTestId('sidebar-empty')
    this.addProjectButton = page.getByTestId('sidebar-add-project')
    this.sessionsAdd = page.getByTestId('sidebar-sessions-add')
    this.session = (id: string) => page.getByTestId(`sidebar-session-${id}`)
    this.sessionOpen = (id: string) => page.getByTestId(`sidebar-session-${id}-open`)
    this.reportButton = page.getByTestId('sidebar-report')
    this.newWorkspaceDialog = page.getByTestId('dialog-new-workspace')
    this.newWorkspaceBrief = page.getByTestId('dialog-new-workspace-brief')
    this.newWorkspaceStart = page.getByTestId('dialog-new-workspace-start')
    this.newWorkspaceName = page.getByTestId('dialog-new-workspace-name')
    this.newWorkspaceNewName = page.getByTestId('dialog-new-workspace-new-name')
    this.newWorkspaceSlug = page.getByTestId('dialog-new-workspace-slug')
    this.newWorkspaceSubmit = page.getByTestId('dialog-new-workspace-submit')
    this.removeProjectDialog = page.getByTestId('dialog-remove-project')
    this.removeProjectSubmit = page.getByTestId('dialog-remove-project-submit')
    this.project = (id: string) => page.getByTestId(`sidebar-project-${id}`)
    this.projectToggle = (id: string) => page.getByTestId(`sidebar-project-${id}-toggle`)
    this.projectMenuRemove = (id: string) => page.getByTestId(`sidebar-project-${id}-menu-remove`)
    this.projectAddWorkspace = (id: string) =>
      page.getByTestId(`sidebar-project-${id}-add-workspace`)
    this.workspace = (id: string) => page.getByTestId(`sidebar-workspace-${id}`)
    this.workspaceOpen = (id: string) => page.getByTestId(`sidebar-workspace-${id}-open`)
    this.workspaceName = (id: string) => page.getByTestId(`sidebar-workspace-${id}-name`)
    this.workspaceStatus = (id: string) => page.getByTestId(`sidebar-workspace-${id}-status`)
    this.workspacePr = (id: string) => page.getByTestId(`sidebar-workspace-${id}-pr`)
    this.workspaceMenu = (id: string) => page.getByTestId(`sidebar-workspace-${id}-menu`)
  }

  async waitForLoad() {
    await this.root.waitFor({ state: 'visible' })
    await Promise.race([
      this.page
        .getByTestId(/^sidebar-project-/)
        .first()
        .waitFor({ state: 'visible' })
        .catch(() => {}),
      this.emptyState.waitFor({ state: 'visible' }).catch(() => {})
    ])
  }

  // Waits for a badge, naming the workspace and the last status seen on failure.
  async waitForWorkspaceStatus(id: string, status: string, timeout = 30_000) {
    const badge = this.workspaceStatus(id)
    await badge.waitFor({ state: 'visible', timeout })
    await expect(badge, `workspace ${id} never reached ${status}`).toHaveAttribute(
      'data-status',
      status,
      { timeout }
    )
  }
}
