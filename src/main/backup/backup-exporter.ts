import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, resolve } from 'node:path'
import { rm, stat } from 'node:fs/promises'

import { WindowsAtomicFileSwitch, type AtomicFileSwitchPort } from './atomic-file-switch'
import { sha256File } from './crypto'
import { asBackupError, BackupError } from './errors'
import { assertDatabaseMatchesManifest, parseBackupManifest, serializeBackupManifest } from './manifest'
import {
  assertAbsolutePath,
  createPrivateDirectory,
  pathExists,
  removePrivateTree,
} from './safe-fs'
import {
  BACKUP_FORMAT_VERSION,
  DEFAULT_BACKUP_LIMITS,
  TODO_BACKUP_EXTENSION,
  type BackupCompatibilityPolicy,
  type BackupDatabasePort,
  type BackupLimits,
  type BackupManifest,
  type ClockPort,
  SYSTEM_CLOCK,
} from './types'
import { extractRestrictedBackupZip, writeBackupZip } from './zip-container'

export interface BackupExporterOptions {
  readonly database: BackupDatabasePort
  readonly compatibility: BackupCompatibilityPolicy
  readonly privateTemporaryRoot: string
  readonly limits?: BackupLimits
  readonly atomicFileSwitch?: AtomicFileSwitchPort
  readonly clock?: ClockPort
  readonly sourceTimeZone?: () => string
}

export interface ExportBackupResult {
  readonly destinationPath: string
  readonly archiveSizeBytes: number
  readonly archiveSha256: string
  readonly manifest: BackupManifest
}

export interface ExportBackupRequestOptions {
  /** Used by pre-migration safety backups validated with the source schema reader. */
  readonly expectedSchemaVersion?: number
}

export class BackupExporter {
  private readonly limits: BackupLimits
  private readonly atomicFileSwitch: AtomicFileSwitchPort
  private readonly clock: ClockPort

  constructor(private readonly options: BackupExporterOptions) {
    this.limits = options.limits ?? DEFAULT_BACKUP_LIMITS
    this.atomicFileSwitch = options.atomicFileSwitch ?? new WindowsAtomicFileSwitch()
    this.clock = options.clock ?? SYSTEM_CLOCK
    assertAbsolutePath(options.privateTemporaryRoot, 'backup temporary root')
  }

  /** destinationPath must originate from Electron's Main-process save dialog. */
  async exportTo(
    destinationPath: string,
    request: ExportBackupRequestOptions = {},
  ): Promise<ExportBackupResult> {
    assertAbsolutePath(destinationPath, 'backup destination')
    if (extname(destinationPath).toLocaleLowerCase('en-US') !== TODO_BACKUP_EXTENSION) {
      throw new BackupError(
        'BACKUP_DESTINATION_INVALID',
        `Backup destination must end in ${TODO_BACKUP_EXTENSION}`,
      )
    }
    if (await pathExists(destinationPath)) {
      throw new BackupError('BACKUP_DESTINATION_EXISTS', 'V1 never overwrites an existing backup')
    }

    const workDirectory = await createPrivateDirectory(this.options.privateTemporaryRoot, 'export')
    const snapshotPath = resolve(workDirectory, 'data.sqlite')
    const verificationDirectory = resolve(workDirectory, 'verify')
    const partialPath = resolve(
      dirname(destinationPath),
      `.${basename(destinationPath)}.${randomUUID()}.partial`,
    )
    try {
      await this.options.database.createConsistentSnapshot(snapshotPath)
      const snapshotInfo = await stat(snapshotPath)
      if (!snapshotInfo.isFile() || snapshotInfo.size <= 0 || snapshotInfo.size > this.limits.maxDatabaseBytes) {
        throw new BackupError('BACKUP_TOO_LARGE', 'SQLite snapshot is outside backup limits')
      }
      const identity = await this.options.database.validateTrustedSnapshot(snapshotPath)
      const expectedSchemaVersion =
        request.expectedSchemaVersion ?? this.options.compatibility.currentSchemaVersion
      if (
        identity.applicationId !== this.options.compatibility.applicationId ||
        identity.schemaVersion !== expectedSchemaVersion ||
        !this.options.compatibility.supportedSchemaVersions.has(identity.schemaVersion) ||
        identity.schemaFingerprint !== this.options.compatibility.schemaFingerprints.get(identity.schemaVersion)
      ) {
        throw new BackupError('BACKUP_SCHEMA_MISMATCH', 'Current database identity is not publishable')
      }

      const createdAt = this.clock.now()
      const dataSha256 = await sha256File(snapshotPath)
      const manifest: BackupManifest = Object.freeze({
        backupFormatVersion: BACKUP_FORMAT_VERSION,
        schemaVersion: identity.schemaVersion,
        applicationId: identity.applicationId,
        applicationVersion: this.options.compatibility.applicationVersion,
        createdAtUtc: createdAt.toISOString(),
        sourceTimeZone:
          this.options.sourceTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        dataSha256,
        dataSizeBytes: snapshotInfo.size,
        schemaFingerprint: identity.schemaFingerprint,
        canonicalDomainDigest: identity.canonicalDomainDigest,
        objectCounts: identity.objectCounts,
      })

      await writeBackupZip(partialPath, serializeBackupManifest(manifest), snapshotPath, createdAt)
      const partialInfo = await stat(partialPath)
      if (partialInfo.size <= 0 || partialInfo.size > this.limits.maxArchiveBytes) {
        throw new BackupError('BACKUP_TOO_LARGE', 'Generated backup archive exceeds limits')
      }

      // Verify the actual container bytes, not merely the source snapshot.
      const extracted = await extractRestrictedBackupZip(partialPath, verificationDirectory, this.limits)
      const verifiedManifest = parseBackupManifest(extracted.manifestBytes, this.options.compatibility)
      if (
        extracted.databaseSha256 !== manifest.dataSha256 ||
        extracted.databaseSizeBytes !== manifest.dataSizeBytes
      ) {
        throw new BackupError('BACKUP_DATA_HASH_MISMATCH', 'Generated archive data is inconsistent')
      }
      const untrustedIdentity = await this.options.database.inspectUntrustedReadonly(
        extracted.databasePath,
        verifiedManifest,
      )
      assertDatabaseMatchesManifest(untrustedIdentity, verifiedManifest)

      const archiveSha256 = await sha256File(partialPath)
      await this.atomicFileSwitch.moveExpectedFile({
        sourcePath: partialPath,
        destinationPath,
        expectedSourceSha256: archiveSha256,
      })
      const finalInfo = await stat(destinationPath)
      const finalHash = await sha256File(destinationPath)
      if (finalInfo.size !== partialInfo.size || finalHash !== archiveSha256) {
        // Remove the .todo-backup name without deleting bytes we cannot account for.
        const failedPath = `${destinationPath}.${randomUUID()}.failed.partial`
        await this.atomicFileSwitch.moveExpectedFile({
          sourcePath: destinationPath,
          destinationPath: failedPath,
          expectedSourceSha256: finalHash,
        })
        throw new BackupError('BACKUP_EXPORT_FAILED', 'Backup changed while being finalized')
      }

      return {
        destinationPath,
        archiveSizeBytes: finalInfo.size,
        archiveSha256,
        manifest,
      }
    } catch (error) {
      throw asBackupError(error, 'BACKUP_EXPORT_FAILED', 'Failed to export backup')
    } finally {
      await rm(partialPath, { force: true }).catch(() => undefined)
      await removePrivateTree(this.options.privateTemporaryRoot, workDirectory).catch(() => undefined)
    }
  }
}
