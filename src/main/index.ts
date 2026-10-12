import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, nativeImage, powerMonitor, safeStorage, Tray } from 'electron'
import log from 'electron-log/main'
import type {
  BackupCountsDto,
  BackupInspectionDto,
  BackupProgressDto,
  ChangeNoticeDto,
  MutationEnvelope,
  SafetyBackupDto
} from '../shared/types'
import type { IpcHandlerMap } from './ipc/registry'
import {
  ArchiveSafetyBackupRebuilder,
  BACKUP_FORMAT_VERSION,
  BackupError,
  BackupExporter,
  BackupInspector,
  RestoreCoordinator,
  StartupRestoreRecovery,
  type BackupCompatibilityPolicy,
  type BackupInspection,
  type MaintenanceLease,
  type MaintenancePort
} from './backup'
import { DomainError } from './domain/errors'
import {
  DatabaseManager,
  DomainStore,
  SqliteBackupDatabaseAdapter,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaFingerprint,
  schemaFingerprintForVersion
} from './persistence'
import { broadcastBackupProgress, broadcastChange, registerIpcHandlers } from './ipc/registry'
import {
  EncryptedCredentialStore,
  ExternalEventCacheStore,
  SyncMetadataStore,
  WecomCalendarService
} from './integrations/wecom-calendar'
import { configureAppPaths, type AppPaths } from './platform/paths'
import { createMainWindow, registerRendererProtocol } from './window'

const PRODUCT_APPLICATION_ID = 'io.local.personaltodo'

// CI/remote desktop hosts can lack a usable GPU runtime. This opt-in keeps
// production defaults intact while making packaged smoke tests deterministic.
if (process.env.PERSONAL_TODO_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
}

interface PendingInspection {
  inspection: BackupInspection
  confirmationToken: string
  expiresAtMs: number
  displayName: string
}

class MainMaintenanceGate implements MaintenancePort {
  private active = false

  assertOrdinaryAccess(): void {
    if (this.active) {
      throw new DomainError('MAINTENANCE_MODE', '数据正在安全切换，请等待恢复完成后重试。', undefined, true)
    }
  }

  async acquireWriteMaintenance(): Promise<MaintenanceLease> {
    if (this.active) {
      throw new DomainError('MAINTENANCE_MODE', '已有数据维护操作正在进行。', undefined, true)
    }
    this.active = true
    let released = false
    return {
      upgradeToExclusive: async () => undefined,
      release: async () => {
        if (released) return
        released = true
        this.active = false
      }
    }
  }
}

let mainWindow: BrowserWindow | null = null
let database: DatabaseManager | null = null
let removeIpcHandlers: (() => void) | null = null
let midnightTimer: NodeJS.Timeout | null = null
let tray: Tray | null = null
let isQuitting = false

const paths = configureAppPaths()
log.transports.file.resolvePathFn = () => join(paths.logsDir, 'main.log')
log.transports.console.level = false
log.initialize()
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.on('window-all-closed', () => undefined)

  void bootstrapApplication().catch((error: unknown) => {
    reportInternalError('startup', error)
    dialog.showErrorBox(
      '逐个锤无法安全启动',
      '数据库未能通过完整性检查，或上次数据恢复尚未安全收口。应用已停止写入，请保留数据目录并查看日志后再处理。'
    )
    app.quit()
  })
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.ico'))
  tray = new Tray(icon)
  tray.setToolTip('逐个锤')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开逐个锤', click: showMainWindow },
    { type: 'separator' },
    { label: '彻底退出', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

async function bootstrapApplication(): Promise<void> {
  await app.whenReady()
  await createPrivateRoots(paths)

  const compatibility = createCompatibilityPolicy()
  const backupDatabase = new SqliteBackupDatabaseAdapter(null)
  const safetyRebuilder = new ArchiveSafetyBackupRebuilder({
    database: backupDatabase,
    compatibility,
    safetyBackupRootPath: paths.safetyBackupDir,
    privateTemporaryRoot: join(paths.dataDir, '.safety-rebuild-tmp')
  })

  const recoveryReport = await new StartupRestoreRecovery({
    database: backupDatabase,
    safetyBackupRecovery: safetyRebuilder,
    primaryDatabasePath: paths.databaseFile,
    restoreRootPath: paths.restoreDir,
    safetyBackupRootPath: paths.safetyBackupDir
  }).recoverPendingOperations()
  log.info(
    `[startup-recovery] recovered=${recoveryReport.recoveredOperationIds.length} ` +
    `committed=${recoveryReport.committedOperationIds.length} corrupt=${recoveryReport.corruptJournalOperationIds.length}`
  )

  database = new DatabaseManager(paths.databaseFile)
  backupDatabase.attachPrimary(database)
  const store = new DomainStore(database)
  const gate = new MainMaintenanceGate()

  const exporter = new BackupExporter({
    database: backupDatabase,
    compatibility,
    privateTemporaryRoot: join(paths.dataDir, '.backup-tmp')
  })
  const inspector = new BackupInspector({
    database: backupDatabase,
    compatibility,
    privateInspectionRoot: join(paths.dataDir, '.inspection-tmp')
  })
  const restoreCoordinator = new RestoreCoordinator({
    database: backupDatabase,
    maintenance: gate,
    exporter,
    inspector,
    primaryDatabasePath: paths.databaseFile,
    restoreRootPath: paths.restoreDir,
    restoreStagingRootPath: join(paths.dataDir, '.restore-staging'),
    safetyBackupRootPath: paths.safetyBackupDir,
    dataEpoch: { rotate: () => { database?.rotateDataEpoch() } }
  })

  const pendingInspections = new Map<string, PendingInspection>()
  const wecomCalendar = WecomCalendarService.fromStores(
    new EncryptedCredentialStore(paths.wecomCalendarDir, safeStorage),
    new ExternalEventCacheStore(paths.wecomCalendarDir),
    new SyncMetadataStore(paths.wecomCalendarDir)
  )
  removeIpcHandlers = registerIpcHandlers(
    createHandlers({ store, gate, exporter, inspector, restoreCoordinator, pendingInspections, paths, wecomCalendar }),
    (traceId, error) => reportInternalError(traceId, error)
  )

  await registerRendererProtocol()
  const initialMaintenance = store.reconcile()
  if (initialMaintenance.change.tags.length > 0) broadcastChange(initialMaintenance.change)
  mainWindow = createMainWindow()
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  createTray()
  log.info(`[startup] ready schema=${CURRENT_SCHEMA_VERSION}`)

  const reconcileVisibleApplication = (): void => {
    if (!database) return
    try {
      gate.assertOrdinaryAccess()
      const result = store.reconcile()
      if (result.change.tags.length > 0) broadcastChange(result.change)
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'MAINTENANCE_MODE')) reportInternalError('maintenance', error)
    }
    scheduleMidnightSweep(reconcileVisibleApplication)
  }

  mainWindow.on('focus', reconcileVisibleApplication)
  mainWindow.on('closed', () => { mainWindow = null })
  powerMonitor.on('resume', reconcileVisibleApplication)
  scheduleMidnightSweep(reconcileVisibleApplication)

  app.on('activate', () => {
    showMainWindow()
    reconcileVisibleApplication()
  })

  app.on('before-quit', () => {
    isQuitting = true
    tray?.destroy()
    tray = null
    if (midnightTimer) clearTimeout(midnightTimer)
    removeIpcHandlers?.()
    database?.close()
    database = null
  })
}

interface HandlerDependencies {
  store: DomainStore
  gate: MainMaintenanceGate
  exporter: BackupExporter
  inspector: BackupInspector
  restoreCoordinator: RestoreCoordinator
  pendingInspections: Map<string, PendingInspection>
  paths: AppPaths
  wecomCalendar: WecomCalendarService
}

function createHandlers(dependencies: HandlerDependencies): IpcHandlerMap {
  const { store, gate, exporter, inspector, restoreCoordinator, pendingInspections, paths, wecomCalendar } = dependencies

  const read = <T>(operation: () => T): T => {
    gate.assertOrdinaryAccess()
    return operation()
  }
  const mutate = <T>(operation: () => MutationEnvelope<T>): MutationEnvelope<T> => {
    gate.assertOrdinaryAccess()
    const result = operation()
    if (result.change.tags.length > 0) broadcastChange(result.change)
    return result
  }

  return {
    'app:bootstrap': () => read(() => store.getBootstrap(app.getVersion())),
    'app:reconcile': () => mutate(() => store.reconcile()),
    'app:preferences': () => ({ launchAtLogin: app.getLoginItemSettings().openAtLogin }),
    'app:set-launch-at-login': (input) => {
      const enabled = (input as { enabled: boolean }).enabled
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] })
      return { launchAtLogin: app.getLoginItemSettings().openAtLogin }
    },
    'today:snapshot': () => read(() => store.getTodaySnapshot()),
    'today:review-snapshot': () => read(() => store.getMorningReviewSnapshot()),
    'today:dismiss-review': (input) => mutate(() => store.dismissReviewCard((input as { expectedLocalDate: string }).expectedLocalDate)),
    'today:finish-review': (input) => mutate(() => store.finishReview((input as { expectedLocalDate: string }).expectedLocalDate)),
    'planning:snapshot': () => read(() => store.getPlanningSnapshot()),
    'tasks:list': (input) => read(() => store.listTasks(input as Parameters<DomainStore['listTasks']>[0])),
    'tasks:detail': (input) => read(() => store.getTaskDetail((input as { id: string }).id)),
    'tasks:create': (input) => mutate(() => store.createTask(input as Parameters<DomainStore['createTask']>[0])),
    'tasks:update-content': (input) => mutate(() => store.updateTaskContent(input as Parameters<DomainStore['updateTaskContent']>[0])),
    'tasks:set-schedule': (input) => mutate(() => store.setTaskSchedule(input as Parameters<DomainStore['setTaskSchedule']>[0])),
    'tasks:change-status': (input) => mutate(() => store.changeTaskStatus(input as Parameters<DomainStore['changeTaskStatus']>[0])),
    'tasks:create-child': (input) => mutate(() => store.createChildTask(input as Parameters<DomainStore['createChildTask']>[0])),
    'tasks:change-parent': (input) => mutate(() => store.changeTaskParent(input as Parameters<DomainStore['changeTaskParent']>[0])),
    'tasks:create-parent-and-attach': (input) => mutate(() => store.createParentAndAttach(input as Parameters<DomainStore['createParentAndAttach']>[0])),
    'tasks:move-tree': (input) => mutate(() => store.moveTaskTree(input as Parameters<DomainStore['moveTaskTree']>[0])),
    'tasks:create-next-step': (input) => mutate(() => store.createNextStep(input as Parameters<DomainStore['createNextStep']>[0])),
    'calendar:range': (input) => read(() => {
      const value = input as { startOn: string; endOn: string; includeCancelled?: boolean }
      return store.getCalendarRange(value.startOn, value.endOn, value.includeCancelled)
    }),
    'quadrants:snapshot': () => read(() => store.getQuadrantSnapshot()),
    'projects:list': () => read(() => store.listProjects()),
    'projects:detail': (input) => read(() => store.getProjectDetail((input as { id: string }).id)),
    'projects:create': (input) => mutate(() => store.createProject(input as Parameters<DomainStore['createProject']>[0])),
    'projects:update': (input) => mutate(() => store.updateProject(input as Parameters<DomainStore['updateProject']>[0])),
    'projects:change-status': (input) => mutate(() => store.changeProjectStatus(input as Parameters<DomainStore['changeProjectStatus']>[0])),
    'projects:remove': (input) => mutate(() => store.removeProject(input as Parameters<DomainStore['removeProject']>[0])),
    'goal-categories:list': () => read(() => store.listGoalCategories()),
    'goal-categories:create': (input) => mutate(() => store.createGoalCategory((input as { name: string }).name)),
    'goal-categories:rename': (input) => mutate(() => {
      const value = input as { id: string; name: string }
      return store.renameGoalCategory(value.id, value.name)
    }),
    'goal-categories:remove': (input) => mutate(() => store.removeGoalCategory((input as { id: string }).id)),
    'goals:list': (input) => read(() => store.listGoals(input as Parameters<DomainStore['listGoals']>[0])),
    'goals:detail': (input) => read(() => store.getGoalDetail((input as { id: string }).id)),
    'goals:create': (input) => mutate(() => store.createGoal(input as Parameters<DomainStore['createGoal']>[0])),
    'goals:update': (input) => mutate(() => store.updateGoal(input as Parameters<DomainStore['updateGoal']>[0])),
    'goals:change-status': (input) => mutate(() => store.changeGoalStatus(input as Parameters<DomainStore['changeGoalStatus']>[0])),
    'goals:remove': (input) => mutate(() => store.removeGoal(input as Parameters<DomainStore['removeGoal']>[0])),
    'recurrences:list': () => read(() => store.listRecurrenceSeries()),
    'recurrences:detail': (input) => read(() => store.getRecurrenceSeries((input as { id: string }).id)),
    'recurrences:create': (input) => mutate(() => store.createRecurrenceSeries(input as Parameters<DomainStore['createRecurrenceSeries']>[0])),
    'recurrences:update': (input) => mutate(() => store.updateRecurrenceFromDate(input as Parameters<DomainStore['updateRecurrenceFromDate']>[0])),
    'recurrences:set-enabled': (input) => mutate(() => store.setRecurrenceEnabledFromDate(input as Parameters<DomainStore['setRecurrenceEnabledFromDate']>[0])),
    'recurrences:apply-occurrence': (input) => mutate(() => store.applyProjectedOccurrence(input as Parameters<DomainStore['applyProjectedOccurrence']>[0])),
    'wecom-calendar:connect': (input) => wecomCalendar.connect(input as Parameters<WecomCalendarService['connect']>[0]),
    'wecom-calendar:disconnect': () => wecomCalendar.disconnect(),
    'wecom-calendar:sync': (input) => wecomCalendar.sync(input as Parameters<WecomCalendarService['sync']>[0]),
    'wecom-calendar:status': () => wecomCalendar.getStatus(),
    'wecom-calendar:range': (input) => wecomCalendar.getRange(input as Parameters<WecomCalendarService['getRange']>[0]),
    'backups:export': async () => {
      gate.assertOrdinaryAccess()
      const choice = await (mainWindow ? dialog.showSaveDialog(mainWindow, {
        title: '导出完整备份',
        defaultPath: `逐个锤完整备份-${localDateForFileName()}.todo-backup`,
        filters: [{ name: '逐个锤完整备份', extensions: ['todo-backup'] }],
        properties: ['createDirectory', 'dontAddToRecent', 'showOverwriteConfirmation']
      }) : dialog.showSaveDialog({
        title: '导出完整备份',
        defaultPath: `逐个锤完整备份-${localDateForFileName()}.todo-backup`,
        filters: [{ name: '逐个锤完整备份', extensions: ['todo-backup'] }],
        properties: ['createDirectory', 'dontAddToRecent', 'showOverwriteConfirmation']
      }))
      if (choice.canceled || !choice.filePath) return { cancelled: true }
      gate.assertOrdinaryAccess()
      const operationId = randomUUID()
      sendProgress(operationId, 'SNAPSHOTTING', 20, '正在创建一致性快照…')
      const exported = await backupAction(() => exporter.exportTo(choice.filePath))
      sendProgress(operationId, 'DONE', 100, '备份已导出并完成复验。')
      return {
        cancelled: false,
        displayName: basename(exported.destinationPath),
        sha256: exported.archiveSha256,
        counts: toBackupCounts(exported.manifest.objectCounts)
      }
    },
    'backups:inspect': async () => {
      gate.assertOrdinaryAccess()
      const choice = await (mainWindow ? dialog.showOpenDialog(mainWindow, {
        title: '选择要检查的完整备份',
        filters: [{ name: '逐个锤完整备份', extensions: ['todo-backup'] }],
        properties: ['openFile', 'dontAddToRecent']
      }) : dialog.showOpenDialog({
        title: '选择要检查的完整备份',
        filters: [{ name: '逐个锤完整备份', extensions: ['todo-backup'] }],
        properties: ['openFile', 'dontAddToRecent']
      }))
      const selected = choice.filePaths[0]
      if (choice.canceled || !selected) return { cancelled: true }
      gate.assertOrdinaryAccess()
      const inspected = await backupAction(() => inspector.inspect(selected))
      const confirmationToken = randomUUID()
      const expiresAtMs = Date.parse(inspected.expiresAtUtc)
      const record: PendingInspection = {
        inspection: inspected,
        confirmationToken,
        expiresAtMs,
        displayName: basename(selected)
      }
      pendingInspections.set(inspected.inspectionToken, record)
      cleanupPendingInspections(pendingInspections)
      return toInspectionDto(record)
    },
    'backups:restore': async (input) => {
      const value = input as { inspectionToken: string; confirmationToken: string }
      const record = pendingInspections.get(value.inspectionToken)
      if (!record || record.confirmationToken !== value.confirmationToken || Date.now() > record.expiresAtMs) {
        pendingInspections.delete(value.inspectionToken)
        throw new DomainError('VALIDATION_FAILED', '恢复确认已失效，请重新选择并检查备份。')
      }
      pendingInspections.delete(value.inspectionToken)
      const progressId = randomUUID()
      sendProgress(progressId, 'SAFETY_BACKUP', 15, '正在创建恢复前安全备份…')
      const restored = await backupAction(() => restoreCoordinator.restore(record.inspection))
      sendProgress(restored.operationId, 'REOPENING', 90, '新数据库已校验，正在恢复正常写入…')
      if (!database) throw new DomainError('DATABASE_ERROR', '数据库未打开')
      const notice: ChangeNoticeDto = {
        dataEpoch: database.dataEpoch,
        revision: database.metadata.revision,
        reason: 'database-restored',
        tags: ['ALL']
      }
      broadcastChange(notice, true)
      broadcastChange(notice)
      sendProgress(restored.operationId, 'DONE', 100, '完整恢复已完成。')
      return {
        operationId: restored.operationId,
        safetyBackup: await toSafetyBackupDto(restored.safetyBackup.destinationPath, restored.safetyBackup.manifest.schemaVersion, restored.safetyBackup.manifest.createdAtUtc),
        restoredCounts: toBackupCounts(record.inspection.manifest.objectCounts)
      }
    },
    'backups:list-safety': async () => {
      gate.assertOrdinaryAccess()
      return listSafetyBackups(paths.safetyBackupDir)
    }
  }
}

function createCompatibilityPolicy(): BackupCompatibilityPolicy {
  const memory = new DatabaseManager(':memory:')
  try {
    const fingerprint = schemaFingerprint(memory.connection)
    return {
      applicationId: PRODUCT_APPLICATION_ID,
      applicationVersion: app.getVersion(),
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      supportedSchemaVersions: new Set(MIGRATIONS.map((migration) => migration.version)),
      supportedBackupFormatVersions: new Set([BACKUP_FORMAT_VERSION]),
      schemaFingerprints: new Map(MIGRATIONS.map(({ version }) => [version, version === CURRENT_SCHEMA_VERSION ? fingerprint : schemaFingerprintForVersion(version)]))
    }
  } finally {
    memory.close()
  }
}

async function createPrivateRoots(appPaths: AppPaths): Promise<void> {
  await Promise.all([
    mkdir(join(appPaths.dataDir, '.backup-tmp'), { recursive: true }),
    mkdir(join(appPaths.dataDir, '.inspection-tmp'), { recursive: true }),
    mkdir(join(appPaths.dataDir, '.restore-staging'), { recursive: true }),
    mkdir(join(appPaths.dataDir, '.safety-rebuild-tmp'), { recursive: true })
  ])
}

function toBackupCounts(counts: Readonly<Record<string, number>>): BackupCountsDto {
  const value = (key: string): number => Number.isInteger(counts[key]) ? counts[key] ?? 0 : 0
  return {
    goals: value('goals'),
    goalCategories: value('goalCategories'),
    projects: value('projects'),
    tasks: value('tasks'),
    taskStatusEvents: value('taskStatusEvents'),
    taskScheduleEvents: value('taskScheduleEvents'),
    recurrenceSeries: value('recurrenceSeries'),
    settings: value('settings')
  }
}

function toInspectionDto(record: PendingInspection): BackupInspectionDto {
  const { manifest, inspectionToken } = record.inspection
  return {
    inspectionToken,
    confirmationToken: record.confirmationToken,
    displayName: record.displayName,
    createdAtUtc: manifest.createdAtUtc,
    applicationVersion: manifest.applicationVersion,
    schemaVersion: manifest.schemaVersion,
    counts: toBackupCounts(manifest.objectCounts),
    canonicalDomainDigest: manifest.canonicalDomainDigest
  }
}

async function listSafetyBackups(directory: string): Promise<SafetyBackupDto[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const backups = await Promise.all(entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.todo-backup'))
    .map(async (entry) => {
      const filePath = join(directory, entry.name)
      const info = await stat(filePath)
      return {
        id: entry.name,
        displayName: entry.name,
        createdAtUtc: info.mtime.toISOString(),
        sizeBytes: info.size,
        schemaVersion: CURRENT_SCHEMA_VERSION
      } satisfies SafetyBackupDto
    }))
  return backups.sort((left, right) => right.createdAtUtc.localeCompare(left.createdAtUtc))
}

async function toSafetyBackupDto(filePath: string, schemaVersion: number, createdAtUtc: string): Promise<SafetyBackupDto> {
  return {
    id: basename(filePath),
    displayName: basename(filePath),
    createdAtUtc,
    sizeBytes: (await stat(filePath)).size,
    schemaVersion
  }
}

function cleanupPendingInspections(records: Map<string, PendingInspection>): void {
  const now = Date.now()
  for (const [token, record] of records) {
    if (record.expiresAtMs < now) records.delete(token)
  }
}

async function backupAction<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (!(error instanceof BackupError)) {
      throw new DomainError('FILE_IO_ERROR', '备份文件操作失败，请检查磁盘空间与文件权限。', undefined, true)
    }
    if (error.code === 'MAINTENANCE_MODE') {
      throw new DomainError('MAINTENANCE_MODE', '数据维护正在进行，请稍后重试。', undefined, true)
    }
    if (error.code === 'BACKUP_DESTINATION_EXISTS') {
      throw new DomainError('FILE_IO_ERROR', '目标位置已有同名备份；为保护旧备份，请选择新的文件名。')
    }
    if (error.code.includes('INCOMPATIBLE')) {
      throw new DomainError('BACKUP_UNSUPPORTED_VERSION', '该备份由不兼容的应用或更高版本创建，请升级应用后重试。')
    }
    if (error.code === 'INSUFFICIENT_DISK_SPACE') {
      throw new DomainError('RESTORE_FAILED', '可用磁盘空间不足，未开始覆盖当前数据。', undefined, true)
    }
    if (
      error.code.includes('ZIP') || error.code.includes('MANIFEST') || error.code.includes('HASH') ||
      error.code.includes('SCHEMA') || error.code.includes('DOMAIN') || error.code === 'BACKUP_TOO_LARGE'
    ) {
      throw new DomainError('BACKUP_CORRUPTED', '备份未通过完整性与关联校验，当前数据没有被改写。')
    }
    if (error.code.startsWith('INSPECTION') || error.code === 'INSPECTED_FILE_CHANGED') {
      throw new DomainError('BACKUP_CORRUPTED', '备份在检查后发生变化，请重新选择文件。')
    }
    if (error.code.includes('RESTORE') || error.code.includes('RECOVERY') || error.code === 'ATOMIC_SWITCH_FAILED') {
      throw new DomainError('RESTORE_FAILED', '恢复未能安全完成；应用已保留或回滚到恢复前数据。', undefined, true)
    }
    throw new DomainError('FILE_IO_ERROR', '备份操作失败，请检查文件位置与权限。', undefined, true)
  }
}

function sendProgress(operationId: string, stage: BackupProgressDto['stage'], percent: number, message: string): void {
  log.info(`[backup:${operationId}] stage=${stage} percent=${percent}`)
  broadcastBackupProgress({ operationId, stage, percent, message })
}

function scheduleMidnightSweep(operation: () => void): void {
  if (midnightTimer) clearTimeout(midnightTimer)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0)
  midnightTimer = setTimeout(operation, Math.max(1_000, next.getTime() - now.getTime()))
}

function localDateForFileName(): string {
  const now = new Date()
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function reportInternalError(traceId: string, error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error
  // Deliberately omit message, stack, SQL parameters and paths from persistent diagnostics.
  log.error(`[personal-todo:${traceId}] ${kind}`)
}
