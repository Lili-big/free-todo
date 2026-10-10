import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { DomainError } from '../domain/errors'
import { APPLICATION_ID, CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations'

export interface DatabaseMetadata {
  dataEpoch: string
  revision: number
  lastReconciledOn: string | null
  schemaVersion: number
}

export interface DatabaseManagerOptions {
  readonly?: boolean
  fileMustExist?: boolean
}

type MetaRow = { data_revision: number; last_reconciled_on: string | null }
type MigrationRow = { version: number; name: string; checksum: string }

/** Owns the application's sole writable SQLite connection. */
export class DatabaseManager {
  private epoch = randomUUID()
  private database: BetterSqlite3.Database | null = null

  constructor(readonly path: string, options: DatabaseManagerOptions = {}) {
    this.openConnection(options)
  }

  get dataEpoch(): string {
    return this.epoch
  }

  rotateDataEpoch(): string {
    this.epoch = randomUUID()
    return this.epoch
  }

  private openConnection(options: DatabaseManagerOptions = {}, requestedJournalMode: 'WAL' | 'DELETE' = 'WAL'): void {
    if (this.database !== null) throw new DomainError('DATABASE_ERROR', '数据库已打开')
    const isMemory = this.path === ':memory:'
    const existed = isMemory || existsSync(this.path)
    if (!isMemory && existed && statSync(this.path).size > 0) inspectDatabaseHeader(this.path)
    if (!isMemory && !existed && !options.readonly) mkdirSync(dirname(this.path), { recursive: true })

    try {
      const database = new BetterSqlite3(this.path, {
        readonly: options.readonly ?? false,
        fileMustExist: options.fileMustExist ?? false
      })
      this.database = database
      database.pragma('foreign_keys = ON')
      database.pragma('busy_timeout = 5000')
      database.pragma('trusted_schema = OFF')

      if (!options.readonly) {
        this.applyMigrations()
        database.pragma(`journal_mode = ${requestedJournalMode}`)
        database.pragma('synchronous = FULL')
      }
      this.verifyMigrationLedger()
      const quickCheck = database.pragma('quick_check', { simple: true }) as string
      if (quickCheck !== 'ok') throw new DomainError('DATABASE_ERROR', '数据库完整性检查失败')
    } catch (error) {
      try {
        this.database?.close()
        this.database = null
      } catch {
        // Preserve the original startup error.
      }
      throw translateSqliteError(error)
    }
  }

  get connection(): BetterSqlite3.Database {
    if (this.database === null) throw new DomainError('DATABASE_ERROR', '数据库已关闭')
    return this.database
  }

  get metadata(): DatabaseMetadata {
    const row = this.connection.prepare('SELECT data_revision, last_reconciled_on FROM database_meta WHERE id = 1').get() as MetaRow
    return {
      dataEpoch: this.dataEpoch,
      revision: row.data_revision,
      lastReconciledOn: row.last_reconciled_on,
      schemaVersion: CURRENT_SCHEMA_VERSION
    }
  }

  immediate<T>(work: (database: BetterSqlite3.Database) => T): T {
    const database = this.connection
    database.exec('BEGIN IMMEDIATE')
    try {
      const value = work(database)
      database.exec('COMMIT')
      return value
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the domain/SQLite error that caused the rollback.
      }
      throw translateSqliteError(error)
    }
  }

  bumpRevision(database: BetterSqlite3.Database = this.connection): number {
    database.prepare('UPDATE database_meta SET data_revision = data_revision + 1 WHERE id = 1').run()
    const row = database.prepare('SELECT data_revision FROM database_meta WHERE id = 1').get() as { data_revision: number }
    return row.data_revision
  }

  integrityCheck(): void {
    const result = this.connection.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (result.length !== 1 || result[0]?.integrity_check !== 'ok') {
      throw new DomainError('DATABASE_ERROR', '数据库完整性检查失败')
    }
    const foreignKeys = this.connection.pragma('foreign_key_check') as unknown[]
    if (foreignKeys.length > 0) throw new DomainError('DATABASE_ERROR', '数据库关联完整性检查失败')
  }

  close(): void {
    if (this.database === null) return
    this.database.close()
    this.database = null
  }

  closeForFileSwitch(): void {
    const database = this.connection
    const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
    if ((checkpoint[0]?.busy ?? 1) !== 0) throw new DomainError('DATABASE_ERROR', '数据库尚有未完成的 WAL 读写')
    const journalMode = database.pragma('journal_mode = DELETE', { simple: true }) as string
    if (journalMode.toLowerCase() !== 'delete' && this.path !== ':memory:') {
      throw new DomainError('DATABASE_ERROR', '数据库无法进入文件切换模式')
    }
    this.close()
  }

  reopenForFileSwitch(): void {
    this.openConnection({ fileMustExist: true }, 'DELETE')
  }

  enableWalMode(): void {
    const mode = this.connection.pragma('journal_mode = WAL', { simple: true }) as string
    if (mode.toLowerCase() !== 'wal' && this.path !== ':memory:') throw new DomainError('DATABASE_ERROR', '无法恢复 WAL 模式')
    this.connection.pragma('synchronous = FULL')
  }

  private applyMigrations(): void {
    const database = this.connection
    const currentVersion = database.pragma('user_version', { simple: true }) as number
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new DomainError('DATABASE_ERROR', '数据库版本高于当前应用支持版本', {
        databaseVersion: currentVersion,
        supportedVersion: CURRENT_SCHEMA_VERSION
      })
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue
      const checksum = migrationChecksum(migration.sql)
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(migration.sql)
        database
          .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at_utc) VALUES (?, ?, ?, ?)')
          .run(migration.version, migration.name, checksum, Date.now())
        database.pragma(`application_id = ${APPLICATION_ID}`)
        database.pragma(`user_version = ${migration.version}`)
        database.exec('COMMIT')
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // Preserve migration error.
        }
        throw error
      }
    }
  }

  private verifyMigrationLedger(): void {
    const database = this.connection
    const userVersion = database.pragma('user_version', { simple: true }) as number
    const applicationId = database.pragma('application_id', { simple: true }) as number
    if (userVersion !== CURRENT_SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
      throw new DomainError('DATABASE_ERROR', '数据库版本标识不一致', {
        userVersion,
        applicationId
      })
    }
    const rows = database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as MigrationRow[]
    if (rows.length !== MIGRATIONS.length) {
      throw new DomainError('DATABASE_ERROR', '数据库迁移记录不完整')
    }
    MIGRATIONS.forEach((migration, index) => {
      const row = rows[index]
      if (
        row === undefined ||
        row.version !== migration.version ||
        row.name !== migration.name ||
        row.checksum !== migrationChecksum(migration.sql)
      ) {
        throw new DomainError('DATABASE_ERROR', '数据库迁移记录校验失败', { version: migration.version })
      }
    })
  }
}

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

export function inspectDatabaseHeader(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(100)
    const bytesRead = readSync(descriptor, header, 0, 100, 0)
    if (bytesRead < 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
      throw new DomainError('DATABASE_ERROR', '数据库文件头无效')
    }
    const userVersion = header.readUInt32BE(60)
    const applicationId = header.readUInt32BE(68)
    if (userVersion > CURRENT_SCHEMA_VERSION) {
      throw new DomainError('DATABASE_ERROR', '数据库由更高版本应用创建，已禁止写入', {
        databaseVersion: userVersion,
        supportedVersion: CURRENT_SCHEMA_VERSION
      })
    }
    if (applicationId !== APPLICATION_ID) {
      throw new DomainError('DATABASE_ERROR', '文件不是本应用的数据库')
    }
  } finally {
    closeSync(descriptor)
  }
}

export function translateSqliteError(error: unknown): Error {
  if (error instanceof DomainError) return error
  if (error instanceof Error) {
    const knownCode = [
      'TASK_DEPTH_EXCEEDED',
      'RECURRENCE_RELATION_FORBIDDEN',
      'PARENT_NOT_ACTIVE',
      'PROJECT_COMPLETED',
      'PROJECT_HAS_OPEN_TASKS',
      'PROJECT_HAS_ACTIVE_SERIES'
    ].find((code) => error.message.includes(code))
    if (knownCode !== undefined) return new DomainError(knownCode as DomainError['code'], sqliteMessage(knownCode))
    return new DomainError('DATABASE_ERROR', '数据库操作失败', undefined, true)
  }
  return new DomainError('DATABASE_ERROR', '数据库操作失败', undefined, true)
}

function sqliteMessage(code: string): string {
  const messages: Record<string, string> = {
    TASK_DEPTH_EXCEEDED: '任务最多只支持一层父子关系',
    RECURRENCE_RELATION_FORBIDDEN: '重复任务实例不能参与父子关系',
    PARENT_NOT_ACTIVE: '已结束的父工作不能新增待办子工作',
    PROJECT_COMPLETED: '已完成项目不能接收待办数据',
    PROJECT_HAS_OPEN_TASKS: '项目仍有待办任务',
    PROJECT_HAS_ACTIVE_SERIES: '项目仍有启用中的重复系列'
  }
  return messages[code] ?? '数据库约束校验失败'
}
