export const BACKUP_FORMAT_VERSION = 1 as const
export const RESTORE_JOURNAL_FORMAT_VERSION = 1 as const
export const TODO_BACKUP_EXTENSION = '.todo-backup' as const

export const CORE_OBJECT_COUNT_KEYS = [
  'goalCategories',
  'goals',
  'projects',
  'tasks',
  'taskChangeLogs',
  'recurrenceSeries',
  'settings',
] as const

export type CoreObjectCountKey = (typeof CORE_OBJECT_COUNT_KEYS)[number]
export type ObjectCounts = Readonly<Record<string, number>>

export interface BackupManifestV1 {
  readonly backupFormatVersion: typeof BACKUP_FORMAT_VERSION
  readonly schemaVersion: number
  readonly applicationId: string
  readonly applicationVersion: string
  readonly createdAtUtc: string
  readonly sourceTimeZone: string
  readonly dataSha256: string
  readonly dataSizeBytes: number
  readonly schemaFingerprint: string
  readonly canonicalDomainDigest: string
  readonly objectCounts: ObjectCounts
}

export type BackupManifest = BackupManifestV1

export interface DatabaseIdentity {
  readonly schemaVersion: number
  readonly applicationId: string
  readonly schemaFingerprint: string
  readonly canonicalDomainDigest: string
  readonly objectCounts: ObjectCounts
}

export interface UntrustedDatabaseExpectation {
  readonly schemaVersion: number
  readonly applicationId: string
  readonly schemaFingerprint: string
  readonly canonicalDomainDigest: string
  readonly objectCounts: ObjectCounts
}

/**
 * Boundary implemented by the persistence layer. Every method receiving an
 * untrusted path must open it readonly + must-exist with query_only and
 * trusted_schema disabled; it must never ATTACH that database.
 */
export interface BackupDatabasePort {
  /** SQLite Online Backup API or VACUUM INTO; never a raw copy of a live WAL DB. */
  createConsistentSnapshot(destinationPath: string): Promise<void>

  /** Full physical, FK, schema-ledger and domain validation of a trusted closed snapshot. */
  validateTrustedSnapshot(databasePath: string): Promise<DatabaseIdentity>

  /** Strict version-specific, explicit-column readonly validation of an untrusted DB. */
  inspectUntrustedReadonly(
    databasePath: string,
    expectation: UntrustedDatabaseExpectation,
  ): Promise<DatabaseIdentity>

  /**
   * Import known columns into a brand-new current-schema DB in one transaction.
   * Before resolving, run full checks, checkpoint(TRUNCATE) with busy=0, switch
   * to DELETE journal mode, close every handle, and reject non-empty sidecars.
   */
  importIntoFreshCurrentSchema(
    sourceDatabasePath: string,
    candidateDatabasePath: string,
    sourceSchemaVersion: number,
  ): Promise<DatabaseIdentity>

  /** Validate a closed DB by trusted schema without opening the application's live pool. */
  validateClosedDatabase(databasePath: string): Promise<DatabaseIdentity>

  /** Drain, checkpoint(TRUNCATE), set DELETE journal mode, close, then validate. */
  closePrimaryForFileSwitch(): Promise<DatabaseIdentity>

  /** Reopen in DELETE mode, fully validate, and run core smoke reads. */
  reopenPrimaryAfterFileSwitch(): Promise<DatabaseIdentity>

  /** Restore the normal WAL configuration after a verified recovery/switch. */
  enablePrimaryWalMode(): Promise<void>
}

export interface MaintenanceLease {
  /** Drain queries and reject every subsequent ordinary query and command. */
  upgradeToExclusive(): Promise<void>
  release(): Promise<void>
}

export interface MaintenancePort {
  /** Reject new writes and drain already admitted writes. */
  acquireWriteMaintenance(reason: 'RESTORE' | 'MIGRATION'): Promise<MaintenanceLease>
}

export interface DataEpochPort {
  /** Rotate only after a verified database has reopened and WAL is restored. */
  rotate(): void | Promise<void>
}

export interface MigrationCandidatePort {
  /**
   * Applies immutable checksummed migrations to a trusted candidate only. It
   * must finish fully validated, closed in DELETE journal mode, without sidecars.
   */
  migrateCandidate(
    candidateDatabasePath: string,
    sourceSchemaVersion: number,
  ): Promise<DatabaseIdentity>
}

export interface BackupCompatibilityPolicy {
  readonly applicationId: string
  readonly applicationVersion: string
  readonly currentSchemaVersion: number
  readonly supportedSchemaVersions: ReadonlySet<number>
  readonly supportedBackupFormatVersions: ReadonlySet<number>
  readonly schemaFingerprints: ReadonlyMap<number, string>
}

export interface BackupLimits {
  readonly maxArchiveBytes: number
  readonly maxManifestBytes: number
  readonly maxDatabaseBytes: number
  readonly maxTotalUncompressedBytes: number
  readonly maxCompressionRatio: number
  readonly inspectionTokenTtlMs: number
  readonly diskSafetyMarginBytes: number
}

export const DEFAULT_BACKUP_LIMITS: BackupLimits = Object.freeze({
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxDatabaseBytes: 4 * 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024 + 256 * 1024,
  maxCompressionRatio: 200,
  inspectionTokenTtlMs: 10 * 60 * 1000,
  diskSafetyMarginBytes: 256 * 1024 * 1024,
})

export interface BackupInspection {
  readonly inspectionToken: string
  readonly manifest: BackupManifest
  readonly archiveSizeBytes: number
  readonly archiveSha256: string
  readonly expiresAtUtc: string
}

export interface ClaimedBackup {
  readonly manifest: BackupManifest
  readonly privateArchivePath: string
  readonly extractedDatabasePath: string
  readonly archiveSha256: string
  readonly archiveSizeBytes: number
}

export type RestoreOperationType = 'RESTORE' | 'MIGRATION'

export interface RestorePlanPayloadV1 {
  readonly journalFormatVersion: typeof RESTORE_JOURNAL_FORMAT_VERSION
  readonly operationId: string
  readonly operationType: RestoreOperationType
  readonly primaryDatabasePath: string
  readonly candidateDatabasePath: string
  readonly oldDatabasePath: string
  readonly oldDatabaseSha256: string
  readonly candidateDatabaseSha256: string
  readonly oldCanonicalDomainDigest: string
  readonly candidateCanonicalDomainDigest: string
  readonly oldSchemaVersion: number
  readonly candidateSchemaVersion: number
  readonly safetyBackupPath: string
  readonly createdAtUtc: string
}

export interface RestorePlanV1 extends RestorePlanPayloadV1 {
  readonly planChecksum: string
}

export type RestorePlan = RestorePlanV1

export const RESTORE_MARKERS = [
  'PREPARED',
  'OLD_MOVED',
  'NEW_INSTALLED',
  'VERIFIED',
  'COMMITTED',
] as const

export type RestoreMarkerName = (typeof RESTORE_MARKERS)[number]

export interface RestoreMarkerV1 {
  readonly journalFormatVersion: typeof RESTORE_JOURNAL_FORMAT_VERSION
  readonly operationId: string
  readonly marker: RestoreMarkerName
  readonly planChecksum: string
  readonly createdAtUtc: string
}

export type RestoreFailpoint =
  | 'before_safety_backup'
  | 'after_safety_backup'
  | 'after_candidate_prepared'
  | 'after_plan_durable'
  | 'after_old_moved'
  | 'after_new_installed'
  | 'after_reopen_verified'
  | 'after_commit_durable'
  | 'recovery_after_candidate_quarantined'
  | 'recovery_after_old_reinstalled'
  | 'recovery_during_safety_backup_rebuild'
  | 'recovery_after_old_verified_before_cleanup'
  | 'commit_cleanup_after_old_deleted'

export interface FaultInjector {
  hit(name: RestoreFailpoint, context: Readonly<Record<string, unknown>>): Promise<void>
}

export const NOOP_FAULT_INJECTOR: FaultInjector = Object.freeze({
  async hit(): Promise<void> {},
})

export interface ClockPort {
  now(): Date
}

export const SYSTEM_CLOCK: ClockPort = Object.freeze({
  now: () => new Date(),
})

export interface DiskSpacePort {
  availableBytes(path: string): Promise<number>
}
