import { _electron as electron } from '@playwright/test'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDirectory, '..')
const packageMetadata = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8'))
const productName = packageMetadata.build?.productName
const expectedVersion = packageMetadata.version
if (typeof productName !== 'string' || !productName.trim()) throw new Error('build.productName must be configured')
const executablePath = process.env.PERSONAL_TODO_PACKAGED_EXE
  ? resolve(process.env.PERSONAL_TODO_PACKAGED_EXE)
  : join(workspaceRoot, 'release', 'win-unpacked', `${productName}.exe`)
const testDirectoryPrefix = 'personal-todo-packaged-smoke-'
const localAppDataRoot = await mkdtemp(join(tmpdir(), testDirectoryPrefix))
const productDataRoot = join(localAppDataRoot, 'personal-todo')
const databasePath = join(productDataRoot, 'data', 'app.sqlite3')
const legacyDatabasePath = process.env.PERSONAL_TODO_LEGACY_DATABASE
  ? resolve(process.env.PERSONAL_TODO_LEGACY_DATABASE)
  : null
const expectedLegacyTaskTitle = process.env.PERSONAL_TODO_EXPECT_LEGACY_TASK?.trim() || null
const taskTitle = `打包版迁移烟测 ${Date.now()}`
let application = null

try {
  assertSafeTestDirectory(localAppDataRoot)
  await access(executablePath)
  if (legacyDatabasePath) await seedLegacyDatabase(legacyDatabasePath, databasePath)

  application = await launchPackagedApplication()
  const firstPage = await getReadyPage(application)
  await verifyShellAndPreload(firstPage)
  if (expectedLegacyTaskTitle) await verifyTaskThroughPreload(firstPage, expectedLegacyTaskTitle)
  await createTask(firstPage, taskTitle)
  await verifyTaskThroughPreload(firstPage, taskTitle)
  const hidden = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    return !window.isDestroyed() && !window.isVisible()
  })
  if (!hidden) throw new Error('Close must hide the packaged window without destroying it')
  await application.evaluate(({ app }) => app.emit('second-instance', {}, [], ''))
  const shown = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  if (!shown) throw new Error('Second instance must restore the hidden window')
  const preferences = await firstPage.evaluate(() => globalThis.todoApi.app.getPreferences())
  if (!preferences.ok || typeof preferences.data.launchAtLogin !== 'boolean') throw new Error('Login preferences unavailable')
  await closeApplication(application)
  application = null

  await verifySqliteFile(databasePath)

  application = await launchPackagedApplication()
  const secondPage = await getReadyPage(application)
  await verifyShellAndPreload(secondPage)
  if (expectedLegacyTaskTitle) await verifyTaskThroughPreload(secondPage, expectedLegacyTaskTitle)
  await verifyTaskThroughPreload(secondPage, taskTitle)
  await secondPage.locator('article.task-card').filter({ hasText: taskTitle }).waitFor({ state: 'visible' })
  await closeApplication(application)
  application = null

  console.log(`Packaged smoke passed: ${executablePath}`)
  console.log(`Verified SQLite create/read cycle: ${databasePath}`)
  if (legacyDatabasePath) console.log(`Verified packaged application opened isolated legacy database copy: ${legacyDatabasePath}`)
} finally {
  if (application) await closeApplication(application)
  await removeIsolatedLocalAppData(localAppDataRoot)
}

async function launchPackagedApplication() {
  return electron.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-compositing'],
    cwd: dirname(executablePath),
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataRoot,
      ELECTRON_RENDERER_URL: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      PERSONAL_TODO_DISABLE_GPU: '1',
      NODE_ENV: 'test'
    }
  })
}

async function getReadyPage(runningApplication) {
  const page = await runningApplication.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.locator('#root').waitFor({ state: 'visible' })
  return page
}

async function verifyShellAndPreload(page) {
  await page.getByRole('heading', { name: '今天要把什么做好？' }).waitFor({ state: 'visible' })
  await page.getByText('本地数据已自动保存').waitFor({ state: 'visible' })

  const result = await page.evaluate(async () => {
    const api = globalThis.todoApi
    if (!api?.app?.getBootstrap || !api?.tasks?.list) return { apiAvailable: false }
    const bootstrap = await api.app.getBootstrap()
    return {
      apiAvailable: true,
      bootstrapOk: bootstrap.ok,
      localDate: bootstrap.ok ? bootstrap.data.localDate : null,
      appVersion: bootstrap.ok ? bootstrap.data.appVersion : null,
      externalResources: performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => /^https?:\/\//i.test(url))
    }
  })

  if (!result.apiAvailable || !result.bootstrapOk || !/^\d{4}-\d{2}-\d{2}$/.test(result.localDate ?? '')) {
    throw new Error(`Packaged preload/bootstrap verification failed: ${JSON.stringify(result)}`)
  }
  if (result.appVersion !== expectedVersion) {
    throw new Error(`Packaged application version mismatch: expected ${expectedVersion}, received ${result.appVersion}`)
  }
  if (result.externalResources.length > 0) {
    throw new Error(`Packaged first screen requested external resources: ${result.externalResources.join(', ')}`)
  }
}

async function createTask(page, title) {
  const quickInput = page.getByLabel('快速添加今日任务')
  await quickInput.fill(title)
  await quickInput.press('Enter')
  await page.locator('article.task-card').filter({ hasText: title }).waitFor({ state: 'visible' })
}

async function verifyTaskThroughPreload(page, title) {
  const result = await page.evaluate(async (expectedTitle) => {
    const response = await globalThis.todoApi.tasks.list({ pageSize: 500 })
    return response.ok
      ? { ok: true, found: response.data.items.some((task) => task.title === expectedTitle) }
      : { ok: false, error: response.error }
  }, title)
  if (!result.ok || !result.found) {
    throw new Error(`Packaged SQLite task read failed: ${JSON.stringify(result)}`)
  }
}

async function verifySqliteFile(path) {
  const fileStat = await stat(path)
  if (!fileStat.isFile() || fileStat.size < 100) {
    throw new Error(`SQLite file is missing or unexpectedly small: ${path}`)
  }
  const bytes = await readFile(path)
  if (bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    throw new Error(`SQLite file header is invalid: ${path}`)
  }
}

async function seedLegacyDatabase(source, destination) {
  if (resolve(source) === resolve(destination)) {
    throw new Error('Legacy database source must not be the smoke-test destination')
  }
  await verifySqliteFile(source)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  await verifySqliteFile(destination)
}

async function closeApplication(runningApplication) {
  const childProcess = runningApplication.process()
  try {
    await Promise.race([
      runningApplication.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged Electron close timed out')), 10_000))
    ])
  } catch {
    if (!childProcess.killed) childProcess.kill()
  }
  await waitForExit(childProcess, 5_000)
  await delay(300)
}

async function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null) return
  await Promise.race([
    new Promise((resolveExit) => childProcess.once('exit', resolveExit)),
    delay(timeoutMs)
  ])
  if (childProcess.exitCode === null && !childProcess.killed) childProcess.kill()
}

async function removeIsolatedLocalAppData(directory) {
  assertSafeTestDirectory(directory)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    await delay(150 + attempt * 50)
    const exists = await access(directory).then(() => true, () => false)
    if (!exists) return
  }
  throw new Error(`Failed to clean packaged smoke directory: ${directory}`)
}

function assertSafeTestDirectory(directory) {
  if (!isAbsolute(directory)) throw new Error(`Smoke directory must be absolute: ${directory}`)
  const resolvedDirectory = resolve(directory)
  const resolvedTemporaryRoot = resolve(tmpdir())
  const pathFromTemporaryRoot = relative(resolvedTemporaryRoot, resolvedDirectory)
  const insideTemporaryRoot = pathFromTemporaryRoot !== '' &&
    pathFromTemporaryRoot !== '..' &&
    !pathFromTemporaryRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromTemporaryRoot)
  if (!insideTemporaryRoot || !basename(resolvedDirectory).startsWith(testDirectoryPrefix)) {
    throw new Error(`Refusing to operate on a non-smoke directory: ${resolvedDirectory}`)
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
