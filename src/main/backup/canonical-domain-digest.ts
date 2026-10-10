import { createHash } from 'node:crypto'

import { BackupError } from './errors'

export type CanonicalScalar = null | boolean | number | bigint | string | Uint8Array

export interface CanonicalTable {
  /** Table order in this array is part of the schema-version-specific contract. */
  readonly name: string
  readonly primaryKey: readonly string[]
  /** Column order in this array is part of the schema-version-specific contract. */
  readonly columns: readonly string[]
  readonly rows: readonly Readonly<Record<string, CanonicalScalar>>[]
}

export interface CanonicalDomainInput {
  readonly tables: readonly CanonicalTable[]
}

const EXCLUDED_TABLES = new Set(['database_meta', 'schema_migrations'])

/**
 * Hashes logical domain values, independent of SQLite page layout and row
 * retrieval order. The persistence adapter supplies a fixed table/column list
 * containing only migratable fields.
 */
export function canonicalDomainDigest(input: CanonicalDomainInput): string {
  const seenTables = new Set<string>()
  const hash = createHash('sha256')
  writeChunk(hash, 'personal-todo:canonical-domain:v1')

  for (const table of input.tables) {
    validateTable(table, seenTables)
    writeChunk(hash, `table:${table.name}`)
    writeChunk(hash, `columns:${table.columns.join('\u001f')}`)

    const rows = [...table.rows].sort((left, right) =>
      comparePrimaryKeys(left, right, table.primaryKey),
    )
    let previousPrimaryKey: string | undefined
    for (const row of rows) {
      const primaryKey = table.primaryKey
        .map((column) => encodeScalar(row[column] as CanonicalScalar))
        .join('\u001f')
      if (primaryKey === previousPrimaryKey) {
        throw new BackupError(
          'BACKUP_DOMAIN_MISMATCH',
          `Duplicate canonical primary key in ${table.name}`,
        )
      }
      previousPrimaryKey = primaryKey
      writeChunk(hash, 'row')
      for (const column of table.columns) {
        if (!Object.prototype.hasOwnProperty.call(row, column)) {
          throw new BackupError(
            'BACKUP_DOMAIN_MISMATCH',
            `Canonical row in ${table.name} is missing ${column}`,
          )
        }
        writeChunk(hash, encodeScalar(row[column] as CanonicalScalar))
      }
    }
    writeChunk(hash, 'end-table')
  }

  return hash.digest('hex')
}

function validateTable(table: CanonicalTable, seenTables: Set<string>): void {
  if (!/^[a-z][a-z0-9_]*$/u.test(table.name)) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Invalid canonical table: ${table.name}`)
  }
  if (EXCLUDED_TABLES.has(table.name)) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `${table.name} must not be canonicalized`)
  }
  if (seenTables.has(table.name)) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Duplicate canonical table: ${table.name}`)
  }
  seenTables.add(table.name)

  const columns = new Set(table.columns)
  if (columns.size !== table.columns.length || table.columns.length === 0) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Invalid columns for ${table.name}`)
  }
  if (columns.has('data_epoch')) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Non-persistent data_epoch must be excluded')
  }
  if (table.primaryKey.length === 0 || table.primaryKey.some((key) => !columns.has(key))) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Invalid primary key for ${table.name}`)
  }
}

function comparePrimaryKeys(
  left: Readonly<Record<string, CanonicalScalar>>,
  right: Readonly<Record<string, CanonicalScalar>>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    if (!(key in left) || !(key in right)) {
      throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Missing canonical primary key: ${key}`)
    }
    const leftEncoded = encodeScalar(left[key] as CanonicalScalar)
    const rightEncoded = encodeScalar(right[key] as CanonicalScalar)
    const comparison = Buffer.compare(Buffer.from(leftEncoded), Buffer.from(rightEncoded))
    if (comparison !== 0) return comparison
  }
  return 0
}

function encodeScalar(value: CanonicalScalar): string {
  if (value === null) return 'null:'
  if (typeof value === 'boolean') return value ? 'bool:1' : 'bool:0'
  if (typeof value === 'bigint') return `bigint:${value.toString(10)}`
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Non-finite canonical number')
    }
    if (Object.is(value, -0)) return 'number:-0'
    return `number:${value.toString()}`
  }
  if (typeof value === 'string') return `string:${value}`
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('base64')}`
  throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Unsupported canonical value')
}

function writeChunk(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  hash.update(String(bytes.byteLength))
  hash.update(':')
  hash.update(bytes)
  hash.update(';')
}
