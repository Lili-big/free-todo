import { readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { BackupError } from './errors'
import { assertDatabaseIdentitiesEqual, assertDatabaseMatchesManifest, parseBackupManifest } from './manifest'
import {
  assertAbsolutePath,
  assertPathWithin,
  createPrivateDirectory,
  pathExists,
  removePrivateTree,
} from './safe-fs'
import {
  DEFAULT_BACKUP_LIMITS,
  type BackupCompatibilityPolicy,
  type BackupDatabasePort,
  type BackupLimits,
  type DatabaseIdentity,
} from './types'
import { extractRestrictedBackupZip } from './zip-container'

export interface SafetyBackupRebuildRequest {
  readonly safetyBackupPath: string
  readonly destinationDatabasePath: string
  readonly expectedCanonicalDomainDigest?: string
}

export interface SafetyBackupRecoveryPort {
  rebuild(request: SafetyBackupRebuildRequest): Promise<DatabaseIdentity>
  rebuildForCorruptJournal(
    operationId: string,
    destinationDatabasePath: string,
  ): Promise<DatabaseIdentity>
}

export interface ArchiveSafetyBackupRebuilderOptions {
  readonly database: BackupDatabasePort
  readonly compatibility: BackupCompatibilityPolicy
  readonly safetyBackupRootPath: string
  readonly privateTemporaryRoot: string
  readonly limits?: BackupLimits
}

/** Uses the same hostile-input checks for application-created safety archives. */
export class ArchiveSafetyBackupRebuilder implements SafetyBackupRecoveryPort {
  private readonly limits: BackupLimits

  constructor(private readonly options: ArchiveSafetyBackupRebuilderOptions) {
    assertAbsolutePath(options.safetyBackupRootPath, 'safety backup root')
    assertAbsolutePath(options.privateTemporaryRoot, 'safety rebuild temporary root')
    this.limits = options.limits ?? DEFAULT_BACKUP_LIMITS
  }

  async rebuild(request: SafetyBackupRebuildRequest): Promise<DatabaseIdentity> {
    assertPathWithin(this.options.safetyBackupRootPath, request.safetyBackupPath, 'safety backup')
    if (await pathExists(request.destinationDatabasePath)) {
      throw new BackupError('RECOVERY_REQUIRED', 'Safety rebuild destination already exists')
    }
    const workDirectory = await createPrivateDirectory(this.options.privateTemporaryRoot, 'safety-rebuild')
    try {
      const extracted = await extractRestrictedBackupZip(
        request.safetyBackupPath,
        workDirectory,
        this.limits,
      )
      const manifest = parseBackupManifest(extracted.manifestBytes, this.options.compatibility)
      if (
        extracted.databaseSha256 !== manifest.dataSha256 ||
        extracted.databaseSizeBytes !== manifest.dataSizeBytes
      ) {
        throw new BackupError('BACKUP_DATA_HASH_MISMATCH', 'Safety backup data hash mismatch')
      }
      if (
        request.expectedCanonicalDomainDigest !== undefined &&
        manifest.canonicalDomainDigest !== request.expectedCanonicalDomainDigest
      ) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Safety backup is not the expected old dataset')
      }
      const inspected = await this.options.database.inspectUntrustedReadonly(
        extracted.databasePath,
        manifest,
      )
      assertDatabaseMatchesManifest(inspected, manifest)
      const imported = await this.options.database.importIntoFreshCurrentSchema(
        extracted.databasePath,
        request.destinationDatabasePath,
        manifest.schemaVersion,
      )
      const verified = await this.options.database.validateTrustedSnapshot(
        request.destinationDatabasePath,
      )
      assertDatabaseIdentitiesEqual(verified, imported, 'safety-backup rebuild')
      if (verified.canonicalDomainDigest !== manifest.canonicalDomainDigest) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Safety rebuild changed the old dataset')
      }
      return verified
    } finally {
      await removePrivateTree(this.options.privateTemporaryRoot, workDirectory).catch(() => undefined)
    }
  }

  async rebuildForCorruptJournal(
    operationId: string,
    destinationDatabasePath: string,
  ): Promise<DatabaseIdentity> {
    const suffix = `-${operationId}.todo-backup`
    const entries = await readdir(this.options.safetyBackupRootPath, { withFileTypes: true })
    const candidates: Array<{ path: string; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(suffix)) continue
      const candidate = resolve(this.options.safetyBackupRootPath, entry.name)
      assertPathWithin(this.options.safetyBackupRootPath, candidate, 'corrupt-journal safety backup')
      candidates.push({ path: candidate, mtimeMs: (await stat(candidate)).mtimeMs })
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
    const selected = candidates[0]
    if (selected === undefined) {
      throw new BackupError(
        'RECOVERY_READ_ONLY_REQUIRED',
        `No safety backup is bound to corrupt operation ${basename(operationId)}`,
      )
    }
    return this.rebuild({
      safetyBackupPath: selected.path,
      destinationDatabasePath,
    })
  }
}
