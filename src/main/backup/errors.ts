export type BackupErrorCode =
  | 'BACKUP_DESTINATION_EXISTS'
  | 'BACKUP_DESTINATION_INVALID'
  | 'BACKUP_EXPORT_FAILED'
  | 'BACKUP_TOO_LARGE'
  | 'BACKUP_ZIP_INVALID'
  | 'BACKUP_ZIP_ENTRY_INVALID'
  | 'BACKUP_MANIFEST_INVALID'
  | 'BACKUP_INCOMPATIBLE_APPLICATION'
  | 'BACKUP_INCOMPATIBLE_FORMAT'
  | 'BACKUP_INCOMPATIBLE_SCHEMA'
  | 'BACKUP_DATA_HASH_MISMATCH'
  | 'BACKUP_SCHEMA_MISMATCH'
  | 'BACKUP_DOMAIN_MISMATCH'
  | 'INSPECTION_TOKEN_INVALID'
  | 'INSPECTION_TOKEN_EXPIRED'
  | 'INSPECTED_FILE_CHANGED'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'RESTORE_PLAN_INVALID'
  | 'RESTORE_MARKER_INVALID'
  | 'ATOMIC_SWITCH_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'RECOVERY_READ_ONLY_REQUIRED'
  | 'MAINTENANCE_MODE'

export class BackupError extends Error {
  readonly code: BackupErrorCode
  readonly cause?: unknown
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: BackupErrorCode,
    message: string,
    options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message)
    this.name = 'BackupError'
    this.code = code
    this.cause = options.cause
    this.details = options.details
  }
}

export function asBackupError(
  error: unknown,
  fallbackCode: BackupErrorCode,
  fallbackMessage: string,
): BackupError {
  if (error instanceof BackupError) return error
  return new BackupError(fallbackCode, fallbackMessage, { cause: error })
}
