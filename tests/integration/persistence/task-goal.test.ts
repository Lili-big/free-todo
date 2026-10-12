import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { DatabaseManager, migrationChecksum } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'
import { buildIdentity, SqliteBackupDatabaseAdapter } from '../../../src/main/persistence/backup-database-adapter'
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/persistence/migrations'
import { FixedDateProvider } from '../../../src/main/domain/local-date'

const dates = new FixedDateProvider('2026-09-08', Date.UTC(2026, 8, 8))

it('links tasks independently of projects, preserves links on moves, and safely unlinks deleted goals', async () => {
  const manager = new DatabaseManager(':memory:')
  try {
    const store = new DomainStore(manager, dates)
    const goal = store.createGoal({ name: '成为 API 产品经理' }).value
    const project = store.createProject({ name: '客户 A', goalId: goal.id }).value
    const unrelated = store.createTask({ title: '客户杂事', projectId: project.id }).value
    const task = store.createTask({ title: '学习 OpenAPI', goalId: goal.id }).value
    expect(task.project).toBeNull()
    expect(task.goal?.id).toBe(goal.id)
    expect(store.listTasks({ goalId: goal.id }).items.map((item) => item.id)).toEqual([task.id])
    expect(unrelated.goal).toBeNull()
    const moved = store.moveTaskTree({ id: task.id, expectedVersion: task.version, projectId: project.id }).value
    expect(moved.goal?.id).toBe(goal.id)
    const unlinked = store.updateTaskContent({ id: task.id, expectedVersion: moved.version, goalId: null }).value
    expect(unlinked.goal).toBeNull()
    const relinked = store.updateTaskContent({ id: task.id, expectedVersion: unlinked.version, goalId: goal.id }).value
    const before = buildIdentity(manager.connection, '2026-09-08')
    const root = mkdtempSync(join(tmpdir(), 'todo-goal-roundtrip-'))
    try {
      const adapter = new SqliteBackupDatabaseAdapter(manager, dates)
      const source = join(root, 'snapshot.sqlite3')
      await adapter.createConsistentSnapshot(source)
      const restored = await adapter.importIntoFreshCurrentSchema(source, join(root, 'restored.sqlite3'), CURRENT_SCHEMA_VERSION)
      expect(restored.canonicalDomainDigest).toBe(before.canonicalDomainDigest)
    } finally { rmSync(root, { recursive: true, force: true }) }
    store.removeGoal({ id: goal.id, expectedVersion: goal.version })
    expect(store.getTaskDetail(task.id).goal).toBeNull()
    expect(store.getTaskDetail(task.id).version).toBeGreaterThan(relinked.version)
    expect(store.getProjectDetail(project.id).goal).toBeNull()
  } finally { manager.close() }
})

it('imports V1 backups without changing their domain digest and upgrades V1 installations in place', async () => {
  const root = mkdtempSync(join(tmpdir(), 'todo-goal-upgrade-'))
  const path = join(root, 'legacy.sqlite3')
  try {
    const legacy = new BetterSqlite3(path)
    legacy.exec(MIGRATIONS[0].sql)
    legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(1, MIGRATIONS[0].name, migrationChecksum(MIGRATIONS[0].sql), 1)
    legacy.pragma(`user_version = 1`)
    legacy.pragma(`application_id = ${APPLICATION_ID}`)
    legacy.exec("INSERT INTO tasks(id,title,status,created_on,created_at_utc,updated_at_utc) VALUES ('legacy-task','旧版任务','TODO','2026-09-08',1,1)")
    const identity = buildIdentity(legacy, '2026-09-08')
    legacy.close()
    const adapter = new SqliteBackupDatabaseAdapter(null, dates)
    const inspected = await adapter.inspectUntrustedReadonly(path, identity)
    expect(inspected.canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
    const imported = await adapter.importIntoFreshCurrentSchema(path, join(root, 'new.sqlite3'), 1)
    expect(imported.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(imported.canonicalDomainDigest).toBe(identity.canonicalDomainDigest)
    const upgraded = new DatabaseManager(path)
    try {
      expect(upgraded.connection.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
      expect(new DomainStore(upgraded, dates).getTaskDetail('legacy-task')).toMatchObject({ title: '旧版任务', goal: null })
    } finally { upgraded.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
