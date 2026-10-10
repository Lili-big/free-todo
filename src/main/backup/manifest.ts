import { BackupError } from './errors'
import { isSha256, stableJson } from './crypto'
import {
  BACKUP_FORMAT_VERSION,
  CORE_OBJECT_COUNT_KEYS,
  type BackupCompatibilityPolicy,
  type BackupManifest,
  type DatabaseIdentity,
  type ObjectCounts,
} from './types'

const MANIFEST_KEYS = [
  'backupFormatVersion',
  'schemaVersion',
  'applicationId',
  'applicationVersion',
  'createdAtUtc',
  'sourceTimeZone',
  'dataSha256',
  'dataSizeBytes',
  'schemaFingerprint',
  'canonicalDomainDigest',
  'objectCounts',
] as const

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const COUNT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u

export function parseBackupManifest(
  contents: Uint8Array,
  policy: BackupCompatibilityPolicy,
): BackupManifest {
  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(contents)
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'manifest.json is not valid UTF-8 JSON', {
      cause: error,
    })
  }

  if (!isPlainObject(value)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'Backup manifest must be an object')
  }
  assertExactKeys(value, MANIFEST_KEYS, 'manifest')

  const backupFormatVersion = integer(value.backupFormatVersion, 'backupFormatVersion', 1)
  if (!policy.supportedBackupFormatVersions.has(backupFormatVersion)) {
    throw new BackupError(
      'BACKUP_INCOMPATIBLE_FORMAT',
      `Unsupported backup format version ${backupFormatVersion}`,
    )
  }
  if (backupFormatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError('BACKUP_INCOMPATIBLE_FORMAT', 'This build only reads V1 manifests')
  }

  const schemaVersion = integer(value.schemaVersion, 'schemaVersion', 1)
  if (schemaVersion > policy.currentSchemaVersion || !policy.supportedSchemaVersions.has(schemaVersion)) {
    throw new BackupError(
      'BACKUP_INCOMPATIBLE_SCHEMA',
      `Backup schema ${schemaVersion} is not supported by this application`,
    )
  }

  const applicationId = nonEmptyString(value.applicationId, 'applicationId', 200)
  if (applicationId !== policy.applicationId) {
    throw new BackupError('BACKUP_INCOMPATIBLE_APPLICATION', 'Backup belongs to another application')
  }

  const createdAtUtc = nonEmptyString(value.createdAtUtc, 'createdAtUtc', 64)
  if (!UTC_TIMESTAMP_PATTERN.test(createdAtUtc) || Number.isNaN(Date.parse(createdAtUtc))) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'createdAtUtc must be a valid UTC timestamp')
  }

  const sourceTimeZone = nonEmptyString(value.sourceTimeZone, 'sourceTimeZone', 128)
  assertTimeZone(sourceTimeZone)
  const dataSha256 = digest(value.dataSha256, 'dataSha256')
  const schemaFingerprint = digest(value.schemaFingerprint, 'schemaFingerprint')
  const canonicalDigest = digest(value.canonicalDomainDigest, 'canonicalDomainDigest')
  const expectedFingerprint = policy.schemaFingerprints.get(schemaVersion)
  if (expectedFingerprint === undefined || expectedFingerprint !== schemaFingerprint) {
    throw new BackupError(
      'BACKUP_SCHEMA_MISMATCH',
      `Schema fingerprint does not match published schema ${schemaVersion}`,
    )
  }

  return Object.freeze({
    backupFormatVersion,
    schemaVersion,
    applicationId,
    applicationVersion: nonEmptyString(value.applicationVersion, 'applicationVersion', 100),
    createdAtUtc,
    sourceTimeZone,
    dataSha256,
    dataSizeBytes: integer(value.dataSizeBytes, 'dataSizeBytes', 1),
    schemaFingerprint,
    canonicalDomainDigest: canonicalDigest,
    objectCounts: parseObjectCounts(value.objectCounts),
  })
}

export function serializeBackupManifest(manifest: BackupManifest): Buffer {
  return Buffer.from(`${stableJson(manifest)}\n`, 'utf8')
}

export function assertDatabaseMatchesManifest(
  identity: DatabaseIdentity,
  manifest: BackupManifest,
): void {
  if (identity.applicationId !== manifest.applicationId) {
    throw new BackupError('BACKUP_INCOMPATIBLE_APPLICATION', 'SQLite application_id mismatch')
  }
  if (identity.schemaVersion !== manifest.schemaVersion) {
    throw new BackupError('BACKUP_SCHEMA_MISMATCH', 'SQLite schema version mismatch')
  }
  if (identity.schemaFingerprint !== manifest.schemaFingerprint) {
    throw new BackupError('BACKUP_SCHEMA_MISMATCH', 'SQLite schema fingerprint mismatch')
  }
  if (identity.canonicalDomainDigest !== manifest.canonicalDomainDigest) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'SQLite canonical domain digest mismatch')
  }
  if (!sameCounts(identity.objectCounts, manifest.objectCounts)) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'SQLite object counts mismatch')
  }
}

export function assertDatabaseIdentitiesEqual(
  actual: DatabaseIdentity,
  expected: DatabaseIdentity,
  expectedRole = 'expected database',
): void {
  if (
    actual.applicationId !== expected.applicationId ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.schemaFingerprint !== expected.schemaFingerprint ||
    actual.canonicalDomainDigest !== expected.canonicalDomainDigest ||
    !sameCounts(actual.objectCounts, expected.objectCounts)
  ) {
    throw new BackupError('BACKUP_DOMAIN_MISMATCH', `Database does not match ${expectedRole}`)
  }
}

function parseObjectCounts(value: unknown): ObjectCounts {
  if (!isPlainObject(value)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'objectCounts must be an object')
  }
  const keys = Object.keys(value)
  if (keys.length > 64 || keys.some((key) => !COUNT_KEY_PATTERN.test(key))) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'objectCounts contains invalid keys')
  }
  for (const required of CORE_OBJECT_COUNT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new BackupError('BACKUP_MANIFEST_INVALID', `objectCounts is missing ${required}`)
    }
  }
  const result: Record<string, number> = {}
  for (const key of keys.sort()) result[key] = integer(value[key], `objectCounts.${key}`, 0)
  return Object.freeze(result)
}

function sameCounts(left: ObjectCounts, right: ObjectCounts): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} must be an integer >= ${minimum}`)
  }
  return value as number
}

function nonEmptyString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} must be a non-empty string`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (!isSha256(value)) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} must be lowercase SHA-256`)
  }
  return value
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0))
  } catch (error) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', 'sourceTimeZone is invalid', { cause: error })
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BackupError('BACKUP_MANIFEST_INVALID', `${label} contains missing or unknown fields`)
  }
}
