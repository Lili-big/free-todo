import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const mainEntry = join(workspaceRoot, 'out', 'main', 'index.js')
const testDirectoryPrefix = 'personal-todo-e2e-'

export interface RunningTodoApp {
  application: ElectronApplication
  page: Page
  localAppDataRoot: string
  productDataRoot: string
}

export async function createIsolatedLocalAppData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), testDirectoryPrefix))
  assertSafeTestDirectory(directory)
  return directory
}

export async function launchTodoApp(localAppDataRoot: string): Promise<RunningTodoApp> {
  assertSafeTestDirectory(localAppDataRoot)
  const packagedExecutable = process.env.PERSONAL_TODO_PACKAGED_EXE
    ? resolve(process.env.PERSONAL_TODO_PACKAGED_EXE)
    : undefined
  await access(packagedExecutable ?? mainEntry)

  const application = await electron.launch({
    // This Codex host lacks the Windows GPU/sandbox runtime used by Electron
    // child processes. These switches are test-harness compatibility only;
    // production BrowserWindow remains sandbox:true and never receives them.
    executablePath: packagedExecutable,
    args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing', ...(packagedExecutable ? [] : [mainEntry])],
    cwd: packagedExecutable ? dirname(packagedExecutable) : workspaceRoot,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataRoot,
      ELECTRON_RENDERER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      PERSONAL_TODO_DISABLE_GPU: '1',
      NODE_ENV: 'test'
    }
  })

  try {
    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#root')).toBeVisible()

    return {
      application,
      page,
      localAppDataRoot,
      productDataRoot: join(localAppDataRoot, 'personal-todo')
    }
  } catch (error) {
    await terminateApplication(application)
    throw error
  }
}

export async function closeTodoApp(running: RunningTodoApp | null | undefined): Promise<void> {
  if (!running) return
  await terminateApplication(running.application)
}

async function terminateApplication(application: ElectronApplication): Promise<void> {
  const process = application.process()
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Electron close timed out')), 10_000))
    ])
  } catch {
    if (!process.killed) process.kill()
    await new Promise<void>((resolveExit) => {
      if (process.exitCode !== null) return resolveExit()
      process.once('exit', () => resolveExit())
      setTimeout(resolveExit, 5_000)
    })
  }
  if (process.exitCode === null) {
    await new Promise<void>((resolveExit) => {
      process.once('exit', () => resolveExit())
      setTimeout(resolveExit, 3_000)
    })
  }
  // Give Chromium helper processes time to release and flush session files.
  await delay(300)
}

export async function removeIsolatedLocalAppData(directory: string): Promise<void> {
  assertSafeTestDirectory(directory)
  // Chromium helpers can flush session state a fraction after the main process
  // exits. Remove, observe, and repeat so a late write cannot recreate residue.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    await delay(150 + attempt * 50)
    const stillExists = await access(directory).then(() => true, () => false)
    if (!stillExists) return
  }
  throw new Error(`未能清理本次测试数据目录：${directory}`)
}

export async function assertUsesOnlyLocalResources(page: Page): Promise<void> {
  const externalResources = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => /^https?:\/\//i.test(url)))
  expect(externalResources, '离线首屏不应请求 HTTP(S) 资源').toEqual([])
}

function assertSafeTestDirectory(directory: string): void {
  if (!isAbsolute(directory)) throw new Error(`测试数据目录必须是绝对路径：${directory}`)
  const resolvedDirectory = resolve(directory)
  const resolvedTemporaryRoot = resolve(tmpdir())
  const pathFromTemporaryRoot = relative(resolvedTemporaryRoot, resolvedDirectory)
  const insideTemporaryRoot = pathFromTemporaryRoot !== '' && pathFromTemporaryRoot !== '..' && !pathFromTemporaryRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromTemporaryRoot)
  if (!insideTemporaryRoot || !basename(resolvedDirectory).startsWith(testDirectoryPrefix)) {
    throw new Error(`拒绝操作非本测试创建的目录：${resolvedDirectory}`)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
