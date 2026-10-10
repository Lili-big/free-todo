import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

import {
  BackupExporter,
  BackupInspector,
  RestoreCoordinator,
  serializeBackupManifest,
  sha256File,
  writeBackupZip,
  type BackupCompatibilityPolicy,
} from '../../../src/main/backup'
import { FixedDateProvider } from '../../../src/main/domain/local-date'
import {
  buildIdentity,
  currentSchemaFingerprint,
  SqliteBackupDatabaseAdapter,
} from '../../../src/main/persistence/backup-database-adapter'
import { DatabaseManager } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'
import { CURRENT_SCHEMA_VERSION } from '../../../src/main/persistence/migrations'

const TODAY = '2026-09-02'
const NOW_UTC = Date.UTC(2026, 8, 2, 1, 2, 3)
const PRODUCT_APPLICATION_ID = 'io.local.personaltodo'

describe('AC-16/AC-17 real SQLite backup and restore', () => {
  let root: string
  let dates: FixedDateProvider
  let computerAManager: DatabaseManager
  let computerAAdapter: SqliteBackupDatabaseAdapter
  let computerBManager: DatabaseManager
  let computerBAdapter: SqliteBackupDatabaseAdapter

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), '个人待办-AC16-'))
    dates = new FixedDateProvider(TODAY, NOW_UTC)
    const computerADirectory = resolve(root, '电脑A-中文用户', 'data')
    const computerBDirectory = resolve(root, '电脑B-新机', 'data')
    await mkdir(computerADirectory, { recursive: true })
    await mkdir(computerBDirectory, { recursive: true })

    computerAManager = new DatabaseManager(resolve(computerADirectory, 'app.sqlite3'))
    computerAAdapter = new SqliteBackupDatabaseAdapter(computerAManager, dates)
    seedGoldenDataset(new DomainStore(computerAManager, dates))

    computerBManager = new DatabaseManager(resolve(computerBDirectory, 'app.sqlite3'))
    computerBAdapter = new SqliteBackupDatabaseAdapter(computerBManager, dates)
    const bStore = new DomainStore(computerBManager, dates)
    bStore.createTask({
      title: '电脑 B 恢复前独有任务',
      notes: '恢复成功后不应与 A 数据混合',
      plannedOn: TODAY,
    })
    bStore.setSetting('calendar.defaultView', 'WEEK')
  })

  afterEach(async () => {
    computerAManager.close()
    computerBManager.close()
    await rm(root, { recursive: true, force: true })
  })

  it('exports A, strictly inspects it on B, rebuilds a fresh candidate, and atomically restores the same domain dataset', async () => {
    const compatibility = compatibilityPolicy()
    const backupPath = resolve(root, '传输目录', '电脑A-完整数据.todo-backup')
    await mkdir(resolve(root, '传输目录'), { recursive: true })
    const exporterA = new BackupExporter({
      database: computerAAdapter,
      compatibility,
      privateTemporaryRoot: resolve(root, '电脑A-导出临时'),
      sourceTimeZone: () => 'Asia/Shanghai',
    })
    const exported = await exporterA.exportTo(backupPath)

    expect(exported.manifest.objectCounts).toMatchObject({
      goalCategories: 1,
      goals: 2,
      projects: 2,
      tasks: expect.any(Number),
      taskStatusEvents: 2,
      taskScheduleEvents: 2,
      recurrenceSeries: 1,
      recurrenceRuleVersions: 2,
      settings: 2,
      dailyReviewStates: 1,
      projectStatusEvents: 2,
      goalStatusEvents: 2,
    })
    expect(exported.manifest.objectCounts.tasks).toBeGreaterThanOrEqual(6)

    const inspectorB = new BackupInspector({
      database: computerBAdapter,
      compatibility,
      privateInspectionRoot: resolve(root, '电脑B-检查临时'),
    })
    const inspection = await inspectorB.inspect(backupPath)
    expect(inspection.manifest.canonicalDomainDigest).toBe(
      exported.manifest.canonicalDomainDigest,
    )
    expect(inspection.manifest.objectCounts).toEqual(exported.manifest.objectCounts)

    // Exercise the version-specific reader and fresh-schema candidate import directly.
    const claimed = await inspectorB.claimForRestore(
      inspection.inspectionToken,
      resolve(root, '电脑B-私有候选分析'),
    )
    const explicitCandidatePath = resolve(root, '电脑B-显式候选.sqlite3')
    const candidateIdentity = await computerBAdapter.importIntoFreshCurrentSchema(
      claimed.extractedDatabasePath,
      explicitCandidatePath,
      claimed.manifest.schemaVersion,
    )
    expect(candidateIdentity.canonicalDomainDigest).toBe(
      exported.manifest.canonicalDomainDigest,
    )
    expect(candidateIdentity.objectCounts).toEqual(exported.manifest.objectCounts)
    assertGoldenRows(explicitCandidatePath)

    // Inspect again to obtain a fresh one-use token for the real durable switch.
    const secondInspection = await inspectorB.inspect(backupPath)
    const beforeB = buildIdentity(computerBManager.connection, TODAY)
    const exporterB = new BackupExporter({
      database: computerBAdapter,
      compatibility,
      privateTemporaryRoot: resolve(root, '电脑B-安全备份临时'),
      sourceTimeZone: () => 'Asia/Shanghai',
    })
    const restoreRoot = resolve(root, '电脑B-应用数据', 'data', '.restore')
    const stagingRoot = resolve(root, '电脑B-应用数据', 'data', '.restore-staging')
    const safetyRoot = resolve(root, '电脑B-应用数据', 'backups', 'safety')
    await mkdir(restoreRoot, { recursive: true })
    await mkdir(stagingRoot, { recursive: true })
    await mkdir(safetyRoot, { recursive: true })
    const restore = new RestoreCoordinator({
      database: computerBAdapter,
      maintenance: {
        async acquireWriteMaintenance() {
          return { async upgradeToExclusive() {}, async release() {} }
        },
      },
      exporter: exporterB,
      inspector: inspectorB,
      primaryDatabasePath: computerBManager.path,
      restoreRootPath: restoreRoot,
      restoreStagingRootPath: stagingRoot,
      safetyBackupRootPath: safetyRoot,
      diskSpace: { async availableBytes() { return Number.MAX_SAFE_INTEGER } },
      dataEpoch: { rotate: () => { computerBManager.rotateDataEpoch() } },
    })
    const restored = await restore.restore(secondInspection)
    const afterB = buildIdentity(computerBManager.connection, TODAY)

    expect(restored.canonicalDomainDigest).toBe(exported.manifest.canonicalDomainDigest)
    expect(afterB.canonicalDomainDigest).toBe(exported.manifest.canonicalDomainDigest)
    expect(afterB.objectCounts).toEqual(exported.manifest.objectCounts)
    expect(restored.safetyBackup.manifest.canonicalDomainDigest).toBe(
      beforeB.canonicalDomainDigest,
    )
    expect(restored.safetyBackup.manifest.canonicalDomainDigest).not.toBe(
      restored.canonicalDomainDigest,
    )
    expect(
      computerBManager.connection
        .prepare("SELECT count(*) AS count FROM tasks WHERE title = '电脑 B 恢复前独有任务'")
        .get(),
    ).toEqual({ count: 0 })
    assertGoldenRows(computerBManager.path)
  })

  it('rejects damaged, higher-version, and invalid-relation backups without modifying B primary', async () => {
    const compatibility = compatibilityPolicy()
    const validBackup = resolve(root, 'valid.todo-backup')
    const exporterA = new BackupExporter({
      database: computerAAdapter,
      compatibility,
      privateTemporaryRoot: resolve(root, 'export-temp'),
      sourceTimeZone: () => 'Asia/Shanghai',
    })
    const exported = await exporterA.exportTo(validBackup)
    const inspectorB = new BackupInspector({
      database: computerBAdapter,
      compatibility,
      privateInspectionRoot: resolve(root, 'inspect-temp'),
    })
    const primaryBefore = await capturePrimaryState()

    const damaged = resolve(root, 'damaged.todo-backup')
    const validBytes = await readFile(validBackup)
    await writeFile(damaged, validBytes.subarray(0, Math.max(1, validBytes.length - 37)))
    await expect(inspectorB.inspect(damaged)).rejects.toThrow()
    await expectPrimaryUnchanged(primaryBefore)

    const sourceSnapshot = resolve(root, 'source-for-negative-cases.sqlite3')
    await computerAAdapter.createConsistentSnapshot(sourceSnapshot)
    const snapshotHash = await sha256File(sourceSnapshot)
    const snapshotSize = (await stat(sourceSnapshot)).size

    const higherVersion = resolve(root, 'higher-version.todo-backup')
    await writeBackupZip(
      higherVersion,
      serializeBackupManifest({
        ...exported.manifest,
        schemaVersion: CURRENT_SCHEMA_VERSION + 1,
        dataSha256: snapshotHash,
        dataSizeBytes: snapshotSize,
      }),
      sourceSnapshot,
      new Date('2026-09-02T01:02:03.000Z'),
    )
    await expect(inspectorB.inspect(higherVersion)).rejects.toThrow(/schema|supported/iu)
    await expectPrimaryUnchanged(primaryBefore)

    const invalidDatabase = resolve(root, 'invalid-relation.sqlite3')
    await computerAAdapter.createConsistentSnapshot(invalidDatabase)
    injectOrphanHistoryRow(invalidDatabase)
    const invalidRelation = resolve(root, 'invalid-relation.todo-backup')
    await writeBackupZip(
      invalidRelation,
      serializeBackupManifest({
        ...exported.manifest,
        dataSha256: await sha256File(invalidDatabase),
        dataSizeBytes: (await stat(invalidDatabase)).size,
      }),
      invalidDatabase,
      new Date('2026-09-02T01:02:03.000Z'),
    )
    await expect(inspectorB.inspect(invalidRelation)).rejects.toMatchObject({
      code: 'BACKUP_INVALID_RELATION',
    })
    await expectPrimaryUnchanged(primaryBefore)
  })

  function compatibilityPolicy(): BackupCompatibilityPolicy {
    const fingerprint = currentSchemaFingerprint()
    return {
      applicationId: PRODUCT_APPLICATION_ID,
      applicationVersion: '1.0.0-test',
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      supportedSchemaVersions: new Set([CURRENT_SCHEMA_VERSION]),
      supportedBackupFormatVersions: new Set([1]),
      schemaFingerprints: new Map([[CURRENT_SCHEMA_VERSION, fingerprint]]),
    }
  }

  async function capturePrimaryState(): Promise<{
    digest: string
    counts: Readonly<Record<string, number>>
    family: Readonly<Record<string, { size: number; mtimeMs: number; sha256: string } | null>>
  }> {
    const identity = buildIdentity(computerBManager.connection, TODAY)
    const family: Record<string, { size: number; mtimeMs: number; sha256: string } | null> = {}
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${computerBManager.path}${suffix}`
      if (!existsSync(path)) {
        family[suffix] = null
      } else {
        const info = await stat(path)
        family[suffix] = { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256File(path) }
      }
    }
    return { digest: identity.canonicalDomainDigest, counts: identity.objectCounts, family }
  }

  async function expectPrimaryUnchanged(
    before: Awaited<ReturnType<typeof capturePrimaryState>>,
  ): Promise<void> {
    const after = await capturePrimaryState()
    expect(after.digest).toBe(before.digest)
    expect(after.counts).toEqual(before.counts)
    expect(after.family).toEqual(before.family)
  }
})

function seedGoldenDataset(store: DomainStore): void {
  const category = store.createGoalCategory('工作').value
  const goal = store.createGoal({
    name: '建立稳定的产品交付节奏',
    description: '未来状态：每个项目都有清晰下一步',
    categoryId: category.id,
    priority: 'P0',
    period: { kind: 'CUSTOM', startOn: '2026-09-01', endOn: '2026-12-31' },
  }).value
  const secondGoal = store.createGoal({ name: '阅读与学习', priority: 'P2' }).value
  const pausedGoal = store.changeGoalStatus({
    id: secondGoal.id,
    expectedVersion: secondGoal.version,
    status: 'PAUSED',
  }).value
  store.changeGoalStatus({ id: pausedGoal.id, expectedVersion: pausedGoal.version, status: 'ACTIVE' })

  const project = store.createProject({
    name: '发布个人待办 V1',
    description: '以完整备份作为跨电脑迁移边界',
    goalId: goal.id,
  }).value
  const statusProject = store.createProject({ name: '已验收的试点', goalId: goal.id }).value
  const completedProject = store.changeProjectStatus({
    id: statusProject.id,
    expectedVersion: statusProject.version,
    status: 'COMPLETED',
  }).value
  store.changeProjectStatus({
    id: completedProject.id,
    expectedVersion: completedProject.version,
    status: 'ACTIVE',
  })

  const parent = store.createTask({
    title: '客户需求确认',
    notes: '父任务无日期，持续保留在项目中',
    projectId: project.id,
  }).value
  const child = store.createChildTask({
    title: '确认首页功能清单',
    notes: '中文、emoji 🎯 与换行\n都必须原样迁移',
    parentId: parent.id,
    parentExpectedVersion: parent.version,
    plannedOn: TODAY,
    important: true,
    urgent: true,
  }).value
  const rescheduled = store.setTaskSchedule({
    id: child.id,
    expectedVersion: child.version,
    plannedOn: '2026-09-03',
  }).value
  const rescheduledBack = store.setTaskSchedule({
    id: rescheduled.id,
    expectedVersion: rescheduled.version,
    plannedOn: TODAY,
  }).value
  const done = store.changeTaskStatus({
    id: rescheduledBack.id,
    expectedVersion: rescheduledBack.version,
    status: 'DONE',
  }).value
  store.changeTaskStatus({ id: done.id, expectedVersion: done.version, status: 'TODO' })

  store.createTask({ title: 'Q2 重要不紧急', important: true, urgent: false })
  store.createTask({
    title: 'Q3 不重要但紧急',
    plannedOn: '2026-09-01',
    important: false,
    urgent: true,
  })
  store.createTask({
    title: 'Q4 不重要不紧急',
    plannedOn: '2026-09-10',
  })

  const series = store.createRecurrenceSeries({
    title: '每日客户跟进',
    notes: '重复模板备注',
    projectId: project.id,
    important: true,
    urgent: false,
    startOn: TODAY,
    pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null },
  }).value
  const occurrence = store
    .listTasks({ pageSize: 500 })
    .items.find((task) => task.recurrence?.seriesId === series.id)
  if (occurrence === undefined) throw new Error('Golden recurrence instance was not materialized')
  store.updateTaskContent({
    id: occurrence.id,
    expectedVersion: occurrence.version,
    title: '今日客户跟进（单次例外）',
  })
  store.updateRecurrenceFromDate({
    id: series.id,
    expectedVersion: series.version,
    effectiveOn: '2026-09-03',
    title: '工作日客户跟进',
    pattern: { kind: 'WEEKLY', weekdays: [1, 2, 3, 4, 5], monthlyDay: null },
  })

  store.setSetting('calendar.defaultView', 'MONTH')
  store.setSetting('today.reviewCardEnabled', true)
  store.startReview(TODAY)
  store.finishReview(TODAY)
}

function assertGoldenRows(databasePath: string): void {
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true })
  try {
    expect(
      database
        .prepare("SELECT notes FROM tasks WHERE title = '确认首页功能清单'")
        .get(),
    ).toEqual({ notes: '中文、emoji 🎯 与换行\n都必须原样迁移' })
    expect(
      database
        .prepare('SELECT is_important, is_urgent FROM tasks WHERE parent_task_id IS NOT NULL')
        .get(),
    ).toEqual({ is_important: 1, is_urgent: 1 })
    expect(
      database.prepare('SELECT count(*) AS count FROM recurrence_rule_versions').get(),
    ).toEqual({ count: 2 })
    expect(
      database.prepare('SELECT count(*) AS count FROM task_schedule_history').get(),
    ).toEqual({ count: 2 })
    expect(
      database.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('calendar.defaultView'),
    ).toEqual({ value_json: '"MONTH"' })
  } finally {
    database.close()
  }
}

function injectOrphanHistoryRow(databasePath: string): void {
  const database = new BetterSqlite3(databasePath)
  try {
    database.pragma('journal_mode = DELETE')
    database.pragma('foreign_keys = OFF')
    database
      .prepare(
        `INSERT INTO task_status_history(id, task_id, old_status, new_status, changed_on, changed_at_utc)
         VALUES ('orphan-history', 'missing-task', 'TODO', 'DONE', ?, ?)`,
      )
      .run(TODAY, NOW_UTC)
  } finally {
    database.close()
  }
}
