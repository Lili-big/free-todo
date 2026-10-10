import { DomainError } from '../../../src/main/domain/errors'
import { FixedDateProvider } from '../../../src/main/domain/local-date'
import { DatabaseManager, migrationChecksum } from '../../../src/main/persistence/database-manager'
import { DomainStore } from '../../../src/main/persistence/domain-store'
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/main/persistence/migrations'

describe('SQLite schema and migration ledger', () => {
  let manager: DatabaseManager

  beforeEach(() => {
    manager = new DatabaseManager(':memory:')
  })

  afterEach(() => manager.close())

  it('keeps the published V1 database identity and migration immutable for in-place upgrades', () => {
    expect(APPLICATION_ID).toBe(0x5054444f)
    expect(CURRENT_SCHEMA_VERSION).toBe(2)
    expect(MIGRATIONS).toHaveLength(2)
    expect(migrationChecksum(MIGRATIONS[0].sql)).toBe(
      '838f2eb21672e78e9fe435c23cf8d7d84bdf68174c4ff33681ef14c527ebd1f3'
    )
  })

  it('initializes a verified schema with required pragmas', () => {
    expect(manager.connection.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(manager.connection.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
    expect(manager.connection.pragma('foreign_keys', { simple: true })).toBe(1)
    const ledger = manager.connection.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    expect(ledger).toEqual(MIGRATIONS.map(({ version, name }) => ({ version, name })))
    expect(() => manager.integrityCheck()).not.toThrow()
  })

  it('enforces task status/date shape and real relationships in SQLite', () => {
    const now = 1
    expect(() =>
      manager.connection
        .prepare(
          `INSERT INTO tasks(id,title,status,is_important,is_urgent,created_on,created_at_utc,updated_at_utc)
           VALUES ('bad','bad','DONE',0,0,'2026-09-02',?,?)`
        )
        .run(now, now)
    ).toThrow()
    expect(() =>
      manager.connection
        .prepare(
          `INSERT INTO goals(id,name,period_kind,period_start_on,period_end_on,status,created_at_utc,updated_at_utc)
           VALUES ('g','g','CUSTOM','2026-10-01','2026-09-01','ACTIVE',?,?)`
        )
        .run(now, now)
    ).toThrow()
  })

  it('uses a deferred composite FK so a whole task tree can move, but a child cannot diverge', () => {
    const store = new DomainStore(manager, new FixedDateProvider('2026-09-02', 100))
    const first = store.createProject({ name: 'A' }).value
    const second = store.createProject({ name: 'B' }).value
    const parent = store.createTask({ title: 'parent', projectId: first.id }).value
    const child = store.createChildTask({ title: 'child', parentId: parent.id, parentExpectedVersion: parent.version }).value

    expect(() =>
      manager.immediate((database) => {
        database.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(second.id, child.id)
      })
    ).toThrow(DomainError)

    let token = ''
    try {
      store.moveTaskTree({ id: parent.id, expectedVersion: parent.version, projectId: second.id })
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError)
      const domain = error as DomainError
      expect(domain.code).toBe('CONFIRMATION_REQUIRED')
      token = String(domain.details?.confirmationToken)
    }
    const moved = store.moveTaskTree({
      id: parent.id,
      expectedVersion: parent.version,
      projectId: second.id,
      confirmationToken: token
    }).value
    expect(moved.project?.id).toBe(second.id)
    expect(moved.children).toHaveLength(1)
    expect(moved.children[0]?.project?.id).toBe(second.id)
  })

  it('rejects grandchildren and recurrence instances participating in a task tree', () => {
    const store = new DomainStore(manager, new FixedDateProvider('2026-09-02', 100))
    const parent = store.createTask({ title: 'parent' }).value
    const child = store.createChildTask({ title: 'child', parentId: parent.id, parentExpectedVersion: parent.version }).value
    expect(() =>
      store.createChildTask({ title: 'grandchild', parentId: child.id, parentExpectedVersion: child.version })
    ).toThrowError(expect.objectContaining({ code: 'TASK_DEPTH_EXCEEDED' }))

    store.createRecurrenceSeries({
      title: 'daily',
      startOn: '2026-09-02',
      pattern: { kind: 'DAILY', weekdays: [], monthlyDay: null }
    })
    const instance = store.listTasks().items.find((task) => task.recurrence !== null)
    expect(instance).toBeDefined()
    expect(() =>
      store.changeTaskParent({ id: instance!.id, expectedVersion: instance!.version, parentId: parent.id })
    ).toThrowError(expect.objectContaining({ code: 'RECURRENCE_RELATION_FORBIDDEN' }))
  })
})
