import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { DatabaseManager, migrationChecksum } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'
import { buildIdentity, SqliteBackupDatabaseAdapter, schemaFingerprintForVersion } from '../../../src/main/persistence/backup-database-adapter'
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/persistence/migrations'

const dates = new FixedDateProvider('2026-09-08', Date.UTC(2026, 8, 8))

it('schema 2 备份可导入新版，原位升级保留完成时间与历史并将开始时间设为空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'todo-start-upgrade-'))
  const legacyPath = join(root, 'legacy.sqlite3')
  try {
    const legacy = new BetterSqlite3(legacyPath)
    for (const migration of MIGRATIONS.filter((item) => item.version <= 2)) {
      legacy.exec(migration.sql)
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(migration.version, migration.name, migrationChecksum(migration.sql), 1)
    }
    legacy.pragma('user_version = 2')
    legacy.pragma(`application_id = ${APPLICATION_ID}`)
    legacy.exec("INSERT INTO tasks(id,title,planned_on,status,created_on,created_at_utc,updated_at_utc) VALUES ('legacy-task','升级前的单日任务','2026-09-08','TODO','2026-09-07',1,1)")
    legacy.exec("INSERT INTO task_schedule_history(id,task_id,old_planned_on,new_planned_on,changed_on,changed_at_utc) VALUES ('history','legacy-task','2026-09-07','2026-09-08','2026-09-07',1)")
    const identity = buildIdentity(legacy, '2026-09-08')
    expect(identity.schemaFingerprint).toBe(schemaFingerprintForVersion(2))
    legacy.close()
    const adapter = new SqliteBackupDatabaseAdapter(null, dates)
    expect((await adapter.inspectUntrustedReadonly(legacyPath, identity)).canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
    const candidate = join(root, 'candidate.sqlite3')
    const imported = await adapter.importIntoFreshCurrentSchema(legacyPath, candidate, 2)
    expect(imported).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, canonicalDomainDigest: identity.canonicalDomainDigest, objectCounts: identity.objectCounts })
    for (const databasePath of [legacyPath, candidate]) {
      const manager = new DatabaseManager(databasePath)
      try {
        const store = new DomainStore(manager, dates)
        expect(store.getTodaySnapshot().dueToday[0]).toMatchObject({ id: 'legacy-task', plannedOn: '2026-09-08', plannedStartOn: null })
        expect(store.getTaskDetail('legacy-task').history[0]).toMatchObject({ oldValue: '2026-09-07', newValue: '2026-09-08', oldPlannedStartOn: null, newPlannedStartOn: null })
        expect(buildIdentity(manager.connection, '2026-09-08').canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
      } finally { manager.close() }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('新版备份保留区间、仅开始日期和开始时间改期历史', async () => {
  const root = mkdtempSync(join(tmpdir(), 'todo-start-roundtrip-'))
  const manager = new DatabaseManager(':memory:')
  try {
    const store = new DomainStore(manager, dates)
    const task = store.createTask({ title: '跨日任务', plannedStartOn: '2026-09-07', plannedOn: '2026-09-10' }).value
    store.createTask({ title: '待分配', plannedStartOn: '2026-09-09' })
    store.setTaskSchedule({ id: task.id, expectedVersion: task.version, plannedOn: '2026-09-10', plannedStartOn: '2026-09-08' })
    const adapter = new SqliteBackupDatabaseAdapter(manager, dates)
    const snapshot = join(root, 'snapshot.sqlite3')
    await adapter.createConsistentSnapshot(snapshot)
    const identity = await adapter.validateTrustedSnapshot(snapshot)
    const candidate = join(root, 'candidate.sqlite3')
    expect((await adapter.importIntoFreshCurrentSchema(snapshot, candidate, CURRENT_SCHEMA_VERSION)).canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
    const restored = new DatabaseManager(candidate)
    try {
      const restoredStore = new DomainStore(restored, dates)
      expect(restoredStore.getTaskDetail(task.id)).toMatchObject({ plannedStartOn: '2026-09-08', plannedOn: '2026-09-10' })
      expect(restoredStore.getTaskDetail(task.id).history[0]).toMatchObject({ oldPlannedStartOn: '2026-09-07', newPlannedStartOn: '2026-09-08' })
      expect(restoredStore.getPlanningSnapshot()[0]).toMatchObject({ plannedStartOn: '2026-09-09', plannedOn: null })
    } finally { restored.close() }
  } finally { manager.close(); rmSync(root, { recursive: true, force: true }) }
})
