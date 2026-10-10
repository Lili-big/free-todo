import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { SqliteBackupDatabaseAdapter } from '../../../src/main/persistence/backup-database-adapter'
import { DatabaseManager } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'

describe('SqliteBackupDatabaseAdapter', () => {
  let directory: string
  let manager: DatabaseManager
  let adapter: SqliteBackupDatabaseAdapter

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), '个人待办-迁移-'))
    manager = new DatabaseManager(join(directory, '主数据.sqlite3'))
    const dates = new FixedDateProvider('2026-09-02', Date.UTC(2026, 8, 2))
    adapter = new SqliteBackupDatabaseAdapter(manager, dates)
    const store = new DomainStore(manager, dates)
    const category = store.createGoalCategory('学习').value
    const goal = store.createGoal({ name: '掌握新技能', categoryId: category.id, priority: 'P1' }).value
    const project = store.createProject({ name: '完成作品', goalId: goal.id }).value
    const parent = store.createTask({ title: '功能列表', projectId: project.id }).value
    store.createChildTask({
      title: '实现中文数据迁移',
      notes: '用户文本必须原样保留',
      parentId: parent.id,
      parentExpectedVersion: parent.version,
      plannedOn: '2026-09-02'
    })
  })

  afterEach(() => {
    manager.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('creates an online snapshot and preserves the canonical identity through a fresh-schema import', async () => {
    const snapshot = join(directory, '完整备份.sqlite3')
    await adapter.createConsistentSnapshot(snapshot)
    const sourceIdentity = await adapter.validateTrustedSnapshot(snapshot)
    expect(sourceIdentity.applicationId).toBe('io.local.personaltodo')
    expect(sourceIdentity.objectCounts.tasks).toBe(2)

    const inspected = await adapter.inspectUntrustedReadonly(snapshot, sourceIdentity)
    expect(inspected.canonicalDomainDigest).toBe(sourceIdentity.canonicalDomainDigest)

    const candidate = join(directory, '恢复候选.sqlite3')
    const imported = await adapter.importIntoFreshCurrentSchema(snapshot, candidate, sourceIdentity.schemaVersion)
    expect(imported.canonicalDomainDigest).toBe(sourceIdentity.canonicalDomainDigest)
    expect(imported.objectCounts).toEqual(sourceIdentity.objectCounts)
  })

  it('closes to DELETE journal mode and reopens the replaceable primary connection', async () => {
    const identity = await adapter.closePrimaryForFileSwitch()
    expect(identity.objectCounts.tasks).toBe(2)
    expect(() => manager.connection).toThrow()
    const reopened = await adapter.reopenPrimaryAfterFileSwitch()
    expect(reopened.canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
    await adapter.enablePrimaryWalMode()
    expect(String(manager.connection.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
  })
})
