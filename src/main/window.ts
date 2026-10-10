import { BrowserWindow, app, net, protocol, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_SCHEME = 'todo-app'

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: false }
  }
])

function rendererRoot(): string {
  return normalize(join(dirname(fileURLToPath(import.meta.url)), '../renderer'))
}

export async function registerRendererProtocol(): Promise<void> {
  // A production build launched directly for smoke/E2E has no Vite URL even
  // though Electron still reports app.isPackaged=false. Serve the built
  // renderer through the same locked-down protocol in that case.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return
  const root = rendererRoot()
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
    let target = normalize(join(root, requested))
    const rel = relative(root, target)
    if (rel.startsWith('..') || rel.includes(':')) return new Response('Not found', { status: 404 })
    if (!existsSync(target)) target = join(root, 'index.html')
    return net.fetch(pathToFileURL(target).toString())
  })
}

function installSessionGuards(): void {
  const currentSession = session.defaultSession
  const developmentRenderer = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  currentSession.setPermissionCheckHandler(() => false)
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    headers['Content-Security-Policy'] = [
      `default-src 'self'; script-src 'self'${developmentRenderer ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
    ]
    callback({ responseHeaders: headers })
  })
}

export function createMainWindow(): BrowserWindow {
  installSessionGuards()
  const preload = join(dirname(fileURLToPath(import.meta.url)), '../preload/index.cjs')
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f2ed',
    autoHideMenuBar: true,
    title: '逐个锤',
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!app.isPackaged && /^https?:\/\/localhost(?::\d+)?\//.test(url)) return { action: 'allow' }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = developmentUrl ? url === developmentUrl : url.startsWith(`${APP_SCHEME}://bundle/`)
    if (!allowed) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadURL(`${APP_SCHEME}://bundle/index.html`)
  }

  return window
}

export async function openAllowedExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  const allowedHosts = new Set<string>()
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) throw new Error('此外部链接未获允许。')
  await shell.openExternal(parsed.toString())
}
