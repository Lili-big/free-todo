import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'
import { canonicalDomainDigest, type CanonicalScalar, type CanonicalTable } from '../backup/canonical-domain-digest'
import type {
  BackupDatabasePort,
  DatabaseIdentity,
  ObjectCounts,
  UntrustedDatabaseExpectation
} from '../backup/types'
import { DomainError } from '../domain/errors'
import type { DateProvider } from '../domain/local-date'
import { SystemDateProvider } from '../domain/local-date'
import { DatabaseManager, inspectDatabaseHeader, migrationChecksum } from './database-manager'
import { assertDomainInvariants, domainColumnsForSchema, DOMAIN_TABLE_COLUMNS, DOMAIN_TABLE_ORDER } from './domain-validator'
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations'

const PRODUCT_APPLICATION_ID = 'io.local.personaltodo'
let cachedCurrentSchemaFingerprint: string | undefined

const PRIMARY_KEYS: Record<keyof typeof DOMAIN_TABLE_COLUMNS, readonly string[]> = {
  app_settings: ['key'],
  goal_categories: ['id'],
  goals: ['id'],
  projects: ['id'],
  recurrence_series: ['id'],
  recurrence_rule_versions: ['id'],
  tasks: ['id'],
  task_schedule_history: ['event_seq'],
  task_status_history: ['event_seq'],
  project_status_history: ['event_seq'],
  goal_status_history: ['event_seq'],
  daily_review_state: ['review_on']
}

/** Bridges the live DatabaseManager to the crash-safe backup/restore services. */
export class SqliteBackupDatabaseAdapter implements BackupDatabasePort {
  private primary: DatabaseManager | null

  constructor(
    primary: DatabaseManager | null = null,
    readonly dates: DateProvider = new SystemDateProvider()
  ) {
    this.primary = primary
  }

  attachPrimary(primary: DatabaseManager): void {
    this.primary = primary
  }

  detachPrimary(): void {
    this.primary = null
  }

  async createConsistentSnapshot(destinationPath: string): Promise<void> {
    if (existsSync(destinationPath)) throw new DomainError('FILE_IO_ERROR', '备份候选文件已存在')
    await this.requirePrimary().connection.backup(destinationPath)
  }

  async validateTrustedSnapshot(databasePath: string): Promise<DatabaseIdentity> {
    return this.validateClosedDatabase(databasePath)
  }

  async inspectUntrustedReadonly(
    databasePath: string,
    expectation: UntrustedDatabaseExpectation
  ): Promise<DatabaseIdentity> {
    const database = openUntrustedReadonly(databasePath)
    try {
      const fingerprint = schemaFingerprint(database)
      if (fingerprint !== expectation.schemaFingerprint) {
        throw new DomainError('BACKUP_CORRUPTED', '备份数据库结构与声明不一致')
      }
      validatePhysicalAndLedger(database, expectation.schemaVersion)
      const identity = buildIdentity(database, this.dates.today().toString())
      assertExpectedIdentity(identity, expectation)
      return identity
    } finally {
      database.close()
    }
  }

  async importIntoFreshCurrentSchema(
    sourceDatabasePath: string,
    candidateDatabasePath: string,
    sourceSchemaVersion: number
  ): Promise<DatabaseIdentity> {
    if (!MIGRATIONS.some((migration) => migration.version === sourceSchemaVersion)) {
      throw new DomainError('BACKUP_UNSUPPORTED_VERSION', '当前版本尚不支持该备份 schema', { sourceSchemaVersion })
    }
    if (existsSync(candidateDatabasePath)) throw new DomainError('FILE_IO_ERROR', '恢复候选数据库已存在')
    const source = openUntrustedReadonly(sourceDatabasePath)
    let candidate: DatabaseManager | null = null
    try {
      validatePhysicalAndLedger(source, sourceSchemaVersion)
      assertKnownSchemaFingerprint(source, sourceSchemaVersion)
      assertDomainInvariants(source, this.dates.today().toString())
      candidate = new DatabaseManager(candidateDatabasePath)
      candidate.immediate((target) => {
        for (const table of DOMAIN_TABLE_ORDER) {
          const columns = domainColumnsForSchema(table, sourceSchemaVersion)
          const columnSql = columns.map(quoteIdentifier).join(', ')
          const placeholders = columns.map(() => '?').join(', ')
          const rows = source.prepare(`SELECT ${columnSql} FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>
          const insert = target.prepare(`INSERT INTO ${quoteIdentifier(table)}(${columnSql}) VALUES (${placeholders})`)
          for (const row of rows) insert.run(...columns.map((column) => row[column]))
        }
      })
      candidate.integrityCheck()
      assertDomainInvariants(candidate.connection, this.dates.today().toString())
      candidate.closeForFileSwitch()
      candidate = null
      assertNoNonEmptySidecars(candidateDatabasePath)
      return await this.validateClosedDatabase(candidateDatabasePath)
    } finally {
      source.close()
      candidate?.close()
    }
  }

  async validateClosedDatabase(databasePath: string): Promise<DatabaseIdentity> {
    assertNoNonEmptySidecars(databasePath)
    const database = openUntrustedReadonly(databasePath)
    try {
      return buildIdentity(database, this.dates.today().toString())
    } finally {
      database.close()
    }
  }

  async closePrimaryForFileSwitch(): Promise<DatabaseIdentity> {
    const primary = this.requirePrimary()
    const beforeClose = buildIdentity(primary.connection, this.dates.today().toString())
    primary.integrityCheck()
    assertDomainInvariants(primary.connection, this.dates.today().toString())
    primary.closeForFileSwitch()
    assertNoNonEmptySidecars(primary.path)
    const closed = await this.validateClosedDatabase(primary.path)
    if (closed.canonicalDomainDigest !== beforeClose.canonicalDomainDigest) {
      throw new DomainError('DATABASE_ERROR', '数据库收口前后的领域摘要不一致')
    }
    return closed
  }

  async reopenPrimaryAfterFileSwitch(): Promise<DatabaseIdentity> {
    const primary = this.requirePrimary()
    primary.reopenForFileSwitch()
    primary.integrityCheck()
    assertDomainInvariants(primary.connection, this.dates.today().toString())
    // Core smoke reads intentionally use base tables only.
    primary.connection.prepare('SELECT count(*) AS count FROM tasks').get()
    primary.connection.prepare('SELECT count(*) AS count FROM projects').get()
    primary.connection.prepare('SELECT count(*) AS count FROM goals').get()
    return buildIdentity(primary.connection, this.dates.today().toString())
  }

  async enablePrimaryWalMode(): Promise<void> {
    this.requirePrimary().enableWalMode()
  }

  private requirePrimary(): DatabaseManager {
    if (this.primary === null) throw new DomainError('DATABASE_ERROR', '尚未绑定正式数据库')
    return this.primary
  }
}

export function schemaFingerprint(database: BetterSqlite3.Database): string {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex')
}

export function currentSchemaFingerprint(): string {
  if (cachedCurrentSchemaFingerprint !== undefined) return cachedCurrentSchemaFingerprint
  const reference = new DatabaseManager(':memory:')
  try {
    cachedCurrentSchemaFingerprint = schemaFingerprint(reference.connection)
    return cachedCurrentSchemaFingerprint
  } finally {
    reference.close()
  }
}

export function buildIdentity(database: BetterSqlite3.Database, today: string): DatabaseIdentity {
  const schemaVersion = database.pragma('user_version', { simple: true }) as number
  validatePhysicalAndLedger(database, schemaVersion)
  assertKnownSchemaFingerprint(database, schemaVersion)
  assertDomainInvariants(database, today)
  // All-null new fields carry no domain facts. Omitting them keeps legacy
  // backup digests identical when imported into the current schema.
  const hasGoalLinks = schemaVersion >= 2 && Boolean(database.prepare('SELECT 1 FROM tasks WHERE goal_id IS NOT NULL LIMIT 1').get())
  const hasTaskStarts = schemaVersion >= 3 && Boolean(database.prepare('SELECT 1 FROM tasks WHERE planned_start_on IS NOT NULL LIMIT 1').get())
  const hasHistoryStarts = schemaVersion >= 3 && Boolean(database.prepare('SELECT 1 FROM task_schedule_history WHERE old_planned_start_on IS NOT NULL OR new_planned_start_on IS NOT NULL LIMIT 1').get())
  const tables: CanonicalTable[] = DOMAIN_TABLE_ORDER.map((name) => {
    const columns = domainColumnsForSchema(name, schemaVersion).filter((column) => {
      if (name === 'tasks' && column === 'goal_id') return hasGoalLinks
      if (column === 'planned_start_on') return hasTaskStarts
      if (column === 'old_planned_start_on' || column === 'new_planned_start_on') return hasHistoryStarts
      return true
    })
    const columnSql = columns.map(quoteIdentifier).join(', ')
    const rows = database.prepare(`SELECT ${columnSql} FROM ${quoteIdentifier(name)}`).all() as Array<Record<string, CanonicalScalar>>
    return { name, primaryKey: PRIMARY_KEYS[name], columns, rows }
  })
  return {
    schemaVersion,
    applicationId: PRODUCT_APPLICATION_ID,
    schemaFingerprint: schemaFingerprint(database),
    canonicalDomainDigest: canonicalDomainDigest({ tables }),
    objectCounts: objectCounts(database)
  }
}

function objectCounts(database: BetterSqlite3.Database): ObjectCounts {
  const count = (table: string): number =>
    (database.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count
  return {
    goalCategories: count('goal_categories'),
    goals: count('goals'),
    projects: count('projects'),
    tasks: count('tasks'),
    taskChangeLogs: count('task_schedule_history') + count('task_status_history'),
    taskStatusEvents: count('task_status_history'),
    taskScheduleEvents: count('task_schedule_history'),
    recurrenceSeries: count('recurrence_series'),
    recurrenceRuleVersions: count('recurrence_rule_versions'),
    settings: count('app_settings'),
    dailyReviewStates: count('daily_review_state'),
    projectStatusEvents: count('project_status_history'),
    goalStatusEvents: count('goal_status_history')
  }
}

function openUntrustedReadonly(path: string): BetterSqlite3.Database {
  if (!existsSync(path) || statSync(path).size < 100) throw new DomainError('BACKUP_CORRUPTED', '备份数据库不存在或不完整')
  try {
    inspectDatabaseHeader(path)
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('BACKUP_UNSUPPORTED_VERSION', error.message, error.details)
    }
    throw error
  }
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
  database.pragma('query_only = ON')
  database.pragma('trusted_schema = OFF')
  database.pragma('foreign_keys = ON')
  return database
}

function validatePhysicalAndLedger(database: BetterSqlite3.Database, expectedVersion: number): void {
  const quick = database.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (quick.length !== 1 || quick[0]?.integrity_check !== 'ok') throw new DomainError('BACKUP_CORRUPTED', '备份数据库完整性检查失败')
  if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new DomainError('BACKUP_INVALID_RELATION', '备份数据库关联检查失败')
  }
  const version = database.pragma('user_version', { simple: true }) as number
  const applicationId = database.pragma('application_id', { simple: true }) as number
  if (version !== expectedVersion || applicationId !== APPLICATION_ID) {
    throw new DomainError('BACKUP_UNSUPPORTED_VERSION', '备份数据库版本或应用标识不匹配', { version, applicationId })
  }
  const rows = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{
    version: number
    name: string
    checksum: string
  }>
  if (
    rows.length !== expectedVersion ||
    MIGRATIONS.filter((migration) => migration.version <= expectedVersion).some((migration, index) => {
      const row = rows[index]
      return row === undefined || row.version !== migration.version || row.name !== migration.name || row.checksum !== migrationChecksum(migration.sql)
    })
  ) {
    throw new DomainError('BACKUP_CORRUPTED', '备份数据库迁移记录无效')
  }
}

function assertKnownSchemaFingerprint(database: BetterSqlite3.Database, version: number): void {
  if (schemaFingerprint(database) !== schemaFingerprintForVersion(version)) {
    throw new DomainError('BACKUP_CORRUPTED', '数据库结构不匹配')
  }
}

export function schemaFingerprintForVersion(version: number): string {
  if (version === CURRENT_SCHEMA_VERSION) return currentSchemaFingerprint()
  if (!MIGRATIONS.some((migration) => migration.version === version)) throw new DomainError('BACKUP_UNSUPPORTED_VERSION', '不支持的数据库版本')
  const reference = new BetterSqlite3(':memory:')
  try {
    for (const migration of MIGRATIONS) if (migration.version <= version) reference.exec(migration.sql)
    return schemaFingerprint(reference)
  } finally { reference.close() }
}

function assertExpectedIdentity(identity: DatabaseIdentity, expectation: UntrustedDatabaseExpectation): void {
  if (
    identity.schemaVersion !== expectation.schemaVersion ||
    identity.applicationId !== expectation.applicationId ||
    identity.schemaFingerprint !== expectation.schemaFingerprint ||
    identity.canonicalDomainDigest !== expectation.canonicalDomainDigest ||
    !sameCounts(identity.objectCounts, expectation.objectCounts)
  ) {
    throw new DomainError('BACKUP_CORRUPTED', '备份 manifest 与数据库内容不一致')
  }
}

function sameCounts(left: ObjectCounts, right: ObjectCounts): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function assertNoNonEmptySidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`
    if (existsSync(sidecar) && statSync(sidecar).size > 0) {
      throw new DomainError('DATABASE_ERROR', '数据库仍存在未收口的 sidecar', { suffix })
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
