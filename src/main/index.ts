import { spawn } from 'node:child_process'
import os from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { DaemonClient } from '../shared/client'
import { loginShellPath, mergePath } from '../shared/login-path'
import { queHome } from '../shared/paths'
import type { EventName, MethodName, Report } from '../shared/protocol'
import type { QuietState, UpdateInfo } from '../shared/types'
import { createBoardWindow } from './board'
import { installMenu } from './menu'
import { createTray, type QueTray } from './tray'
import { checkForUpdate } from './update-check'

// The daemon owns every terminal and workspace. This process only proxies the
// allowed calls and their events between the renderer and the daemon;
// quitting leaves terminals alive.

let mainWindow: BrowserWindow | null = null
/** The quiet board, while quiet hours are locked. */
let boardWindow: BrowserWindow | null = null
let quiet: QuietState | null = null
let client: DaemonClient | null = null
let connecting: Promise<DaemonClient> | null = null
let tray: QueTray | null = null
const e2e = process.env.QUE_E2E === '1'
// Everything que keeps lives under QUE_HOME, the app's own data (window
// storage, caches) included, so a test QUE_HOME isolates all of it.
app.setPath('userData', join(queHome(), 'app'))
/** A newer release, once the update check has found one. */
let update: UpdateInfo | null = null

/** Methods the renderer may call through the preload bridge. */
const ALLOWED: ReadonlySet<MethodName> = new Set<MethodName>([
  'term.create',
  'term.list',
  'term.attach',
  'term.detach',
  'term.write',
  'term.resize',
  'term.kill',
  'term.snapshot',
  'project.add',
  'project.list',
  'project.remove',
  'workspace.create',
  'workspace.list',
  'workspace.get',
  'workspace.remove',
  'workspace.openTerminal',
  'workspace.createPr',
  'workspace.start',
  'workspace.rename',
  'workspace.canRenameBranch',
  'workspace.diff',
  'workspace.prThread',
  'workspace.files',
  'workspace.readFile',
  'workspace.watch',
  'workspace.unwatch',
  'task.add',
  'task.list',
  'task.get',
  'task.stop',
  'task.remove',
  'queue.open',
  'queue.close',
  'queue.state',
  'report.get',
  'quiet.state',
  'quiet.unlock',
  'quiet.lock',
  'quiet.log',
  'config.get',
  'config.set',
  'instructions.get',
  'instructions.set',
  'tickets.list',
  'tickets.sync',
  'tickets.start',
  'tickets.projectFor'
])
const FORWARDED_EVENTS: EventName[] = [
  'term.data',
  'term.exit',
  'term.created',
  'term.killed',
  'workspace.created',
  'workspace.updated',
  'workspace.removed',
  'workspace.status',
  'workspace.changed',
  'task.created',
  'task.status',
  'task.updated',
  'queue.state',
  'project.added',
  'project.removed',
  'quiet.changed',
  'config.changed',
  'tickets.synced'
]
/** Events after which the tray title is recomputed. */
const TRAY_EVENTS: EventName[] = [
  'workspace.created',
  'workspace.status',
  'workspace.removed',
  'task.created',
  'task.status'
]

function getClient(): Promise<DaemonClient> {
  if (client?.connected) return Promise.resolve(client)
  if (!connecting) {
    connecting = DaemonClient.connectOrStart({ log: (m) => console.log(`[daemon] ${m}`) })
      .then((c) => {
        client = c
        for (const ev of FORWARDED_EVENTS) {
          c.on(ev, (data) => sendToRenderer('que:event', ev, data))
        }
        for (const ev of TRAY_EVENTS) c.on(ev, () => tray?.refresh(c))
        tray?.refresh(c)
        c.on('quiet.changed', (q) => applyQuiet(q))
        c.on('quiet.morningSummary', ({ report }) => morningSummary(report))
        void c.request('quiet.state').then(applyQuiet, () => {})
        c.onClose(() => {
          if (client === c) client = null
          sendToRenderer('que:event', 'daemon.disconnected', {})
        })
        return c
      })
      .finally(() => {
        connecting = null
      })
  }
  return connecting
}

/** Quiet hours are on and detail is not unlocked: only the board shows. */
function isLocked(): boolean {
  return Boolean(quiet?.inQuietHours && !quiet.unlockedUntil)
}

function showBoard(): void {
  if (!boardWindow || boardWindow.isDestroyed()) {
    boardWindow = createBoardWindow({ e2e })
    boardWindow.on('closed', () => {
      boardWindow = null
    })
    const win = boardWindow
    win.once('ready-to-show', () => {
      if (win.isDestroyed() || !isLocked()) return
      if (e2e) win.showInactive()
      else win.show()
    })
  } else if (e2e) boardWindow.showInactive()
  else boardWindow.show()
}

function closeBoard(): void {
  const win = boardWindow
  boardWindow = null
  if (win && !win.isDestroyed()) win.close()
}

/**
 * Locked: the main window hides (its terminals stay running in the daemon)
 * and the board shows. Unlocked or work hours: the reverse, with no prompt.
 */
function applyQuiet(q: QuietState): void {
  const wasLocked = isLocked()
  quiet = q
  tray?.setQuiet(q)
  if (isLocked()) {
    mainWindow?.hide()
    showBoard()
  } else {
    closeBoard()
    if (wasLocked) showWindow()
  }
}

/** One notification with the night's totals, when quiet hours end. */
function morningSummary(report: Report): void {
  if (e2e || !Notification.isSupported()) return
  const body = [
    `${report.totals.needsInput} need input`,
    `${report.workspaces.filter((w) => w.status === 'stuck').length} stuck`,
    `${report.groups.done.length} tasks done`,
    `${report.totals.prs} PRs`
  ].join(' · ')
  new Notification({ title: 'que · good morning', body }).show()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    // Under e2e the window must not steal OS focus, or stray keystrokes from
    // the desktop land in the terminal under test. During quiet hours it
    // starts hidden behind the board.
    show: !e2e && !isLocked(),
    backgroundColor: '#181818',
    title: 'que',
    // No native title bar: the app's chrome runs to the top, the traffic
    // lights sit over the sidebar's top strip, which drags the window.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 13, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Read by the preload to decide whether to expose the e2e test hook.
      additionalArguments: e2e ? ['--que-e2e'] : []
    }
  })
  if (e2e && !isLocked()) mainWindow.showInactive()

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links (pull requests) open in the browser, never inside the app window.
  const external = (url: string): void => {
    if (!e2e && /^https?:\/\//.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    external(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (ev, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    ev.preventDefault()
    external(url)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Brings que forward: the board while locked, else the main window. */
function showApp(): void {
  if (isLocked()) showBoard()
  else showWindow()
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  else if (e2e) mainWindow.showInactive()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  if (!e2e) app.focus({ steal: true })
}

/** Once per launch (and at most once a day, see update-check.ts): is there a newer release? */
function startUpdateCheck(): void {
  if (e2e || process.env.QUE_UPDATE_CHECK === '0') return
  void checkForUpdate({
    currentVersion: app.getVersion(),
    statePath: join(queHome(), 'state', 'update-check.json')
  }).then((info) => {
    update = info
    if (info) sendToRenderer('que:update', info)
  })
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of [mainWindow, boardWindow]) {
    if (!win || win.isDestroyed()) continue
    const wc = win.webContents
    if (wc.isDestroyed() || wc.isCrashed()) continue
    try {
      wc.send(channel, ...args)
    } catch {
      // The frame can be torn down mid-send during shutdown or reload.
    }
  }
}

function registerIpc(): void {
  ipcMain.handle('app:homedir', () => os.homedir())

  ipcMain.handle('dialog:openFolder', async () => {
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Fire-and-forget: the editor is found on PATH and outlives nothing here.
  ipcMain.handle('app:openInEditor', (_e, path: unknown) => {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('path must be absolute')
    const child = spawn('code', ['-n', path], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => console.error(`code -n ${path} failed: ${err.message}`))
    child.unref()
    return { ok: true }
  })

  ipcMain.handle('app:update', () => update)

  // Opens only the release page the check found; the renderer cannot pass a URL.
  ipcMain.handle('app:openUpdate', () => {
    if (update) void shell.openExternal(update.url)
    return { ok: true }
  })

  ipcMain.handle('app:trayTitle', () => {
    if (!e2e) throw new Error('app.trayTitle is only available under QUE_E2E=1')
    return tray?.title() ?? ''
  })

  ipcMain.handle('que:request', async (_e, method: MethodName, params: unknown) => {
    if (!ALLOWED.has(method)) throw new Error(`method not allowed: ${method}`)
    const c = await getClient()
    try {
      return { ok: true, result: await c.request(method, params as never) }
    } catch (err) {
      // Errors thrown across ipc lose their fields; return them as data.
      const e = err as { code?: string; message?: string }
      return { ok: false, error: { code: e.code ?? 'error', message: e.message ?? String(err) } }
    }
  })

  // Fire-and-forget path for keystrokes, avoiding a round trip per key.
  ipcMain.on('que:write', (_e, id: string, data: string) => {
    void getClient()
      .then((c) => c.request('term.write', { id, data }))
      .catch(() => {})
  })
}

app.whenReady().then(async () => {
  // A Finder launch has launchd's PATH; the daemon and editors inherit ours,
  // so resolve the login shell's once, before the first daemon start.
  if (!e2e) {
    const login = await loginShellPath()
    process.env.PATH = mergePath(process.env.PATH, login)
    console.log(login ? 'PATH: merged the login shell PATH' : 'PATH: login shell PATH unavailable')
  }
  registerIpc()
  installMenu()
  const quietCall = (method: 'quiet.unlock' | 'quiet.lock'): void => {
    void getClient()
      .then((c) => c.request(method))
      .catch((err) => console.error(`${method} failed:`, err))
  }
  tray = createTray({
    show: showApp,
    quit: () => app.quit(),
    unlock: () => quietCall('quiet.unlock'),
    lock: () => quietCall('quiet.lock')
  })
  try {
    const c = await getClient()
    applyQuiet(await c.request('quiet.state'))
  } catch (err) {
    console.error('failed to reach que daemon:', err)
  }
  if (!mainWindow) createWindow()
  startUpdateCheck()
  app.on('activate', () => {
    if (!mainWindow) createWindow()
    showApp()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  // Only the connection goes away; the daemon and its terminals keep running.
  client?.close()
})
