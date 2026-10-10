import { randomBytes, randomUUID } from 'node:crypto'
import { constants, copyFile, mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { sha256File } from './crypto'
import { BackupError } from './errors'
import { assertDatabaseMatchesManifest, parseBackupManifest } from './manifest'
import {
  assertAbsolutePath,
  assertPathWithin,
  assertRegularFile,
  createPrivateDirectory,
  removePrivateTree,
  syncFile,
} from './safe-fs'
import {
  DEFAULT_BACKUP_LIMITS,
  type BackupCompatibilityPolicy,
  type BackupDatabasePort,
  type BackupInspection,
  type BackupLimits,
  type ClaimedBackup,
  type ClockPort,
  SYSTEM_CLOCK,
} from './types'
import { extractRestrictedBackupZip } from './zip-container'

interface InspectionRecord {
  readonly token: string
  readonly sourcePath: string
  readonly sourceSizeBytes: number
  readonly sourceMtimeMs: number
  readonly archiveSha256: string
  readonly expiresAtMs: number
  readonly manifest: BackupInspection['manifest']
  claimed: boolean
}

export interface BackupInspectorOptions {
  readonly database: BackupDatabasePort
  readonly compatibility: BackupCompatibilityPolicy
  readonly privateInspectionRoot: string
  readonly limits?: BackupLimits
  readonly clock?: ClockPort
}

export class BackupInspector {
  private readonly records = new Map<string, InspectionRecord>()
  private readonly limits: BackupLimits
  private readonly clock: ClockPort

  constructor(private readonly options: BackupInspectorOptions) {
    this.limits = options.limits ?? DEFAULT_BACKUP_LIMITS
    this.clock = options.clock ?? SYSTEM_CLOCK
    assertAbsolutePath(options.privateInspectionRoot, 'inspection root')
  }

  /** sourcePath must originate from Electron's Main-process open dialog. */
  async inspect(sourcePath: string): Promise<BackupInspection> {
    assertAbsolutePath(sourcePath, 'backup source')
    this.cleanupExpired()
    await assertRegularFile(sourcePath, 'backup source')
    const before = await stat(sourcePath)
    if (before.size <= 0 || before.size > this.limits.maxArchiveBytes) {
      throw new BackupError('BACKUP_TOO_LARGE', 'Backup archive size is outside allowed limits')
    }
    const archiveSha256 = await sha256File(sourcePath)
    const workDirectory = await createPrivateDirectory(this.options.privateInspectionRoot, 'inspect')
    try {
      const extracted = await extractRestrictedBackupZip(sourcePath, workDirectory, this.limits)
      const manifest = parseBackupManifest(extracted.manifestBytes, this.options.compatibility)
      this.assertContainerMatchesManifest(extracted, manifest)
      const identity = await this.options.database.inspectUntrustedReadonly(
        extracted.databasePath,
        manifest,
      )
      assertDatabaseMatchesManifest(identity, manifest)

      const after = await stat(sourcePath)
      const afterHash = await sha256File(sourcePath)
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        archiveSha256 !== afterHash
      ) {
        throw new BackupError('INSPECTED_FILE_CHANGED', 'Backup changed during inspection')
      }

      const token = randomBytes(32).toString('base64url')
      const expiresAtMs = this.clock.now().getTime() + this.limits.inspectionTokenTtlMs
      this.records.set(token, {
        token,
        sourcePath: resolve(sourcePath),
        sourceSizeBytes: after.size,
        sourceMtimeMs: after.mtimeMs,
        archiveSha256,
        expiresAtMs,
        manifest,
        claimed: false,
      })
      return Object.freeze({
        inspectionToken: token,
        manifest,
        archiveSizeBytes: after.size,
        archiveSha256,
        expiresAtUtc: new Date(expiresAtMs).toISOString(),
      })
    } finally {
      await removePrivateTree(this.options.privateInspectionRoot, workDirectory).catch(() => undefined)
    }
  }

  /** Rebinds and recopies inspected bytes into an application-private operation directory. */
  async claimForRestore(inspectionToken: string, stagingDirectory: string): Promise<ClaimedBackup> {
    assertAbsolutePath(stagingDirectory, 'restore staging directory')
    const record = this.records.get(inspectionToken)
    if (record === undefined || record.claimed) {
      throw new BackupError('INSPECTION_TOKEN_INVALID', 'Inspection token is invalid or already used')
    }
    if (this.clock.now().getTime() >= record.expiresAtMs) {
      this.records.delete(inspectionToken)
      throw new BackupError('INSPECTION_TOKEN_EXPIRED', 'Inspection token has expired')
    }
    record.claimed = true

    await this.assertSourceStillMatches(record)
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    const privateArchivePath = resolve(stagingDirectory, `source-${randomUUID()}.todo-backup`)
    assertPathWithin(stagingDirectory, privateArchivePath, 'staged backup')
    await copyFile(record.sourcePath, privateArchivePath, constants.COPYFILE_EXCL)
    await syncFile(privateArchivePath)
    const copiedInfo = await stat(privateArchivePath)
    const copiedHash = await sha256File(privateArchivePath)
    if (copiedInfo.size !== record.sourceSizeBytes || copiedHash !== record.archiveSha256) {
      throw new BackupError('INSPECTED_FILE_CHANGED', 'Backup changed before private staging completed')
    }

    const extractionDirectory = resolve(stagingDirectory, `extracted-${randomUUID()}`)
    assertPathWithin(stagingDirectory, extractionDirectory, 'staged extraction')
    const extracted = await extractRestrictedBackupZip(
      privateArchivePath,
      extractionDirectory,
      this.limits,
    )
    const manifest = parseBackupManifest(extracted.manifestBytes, this.options.compatibility)
    this.assertContainerMatchesManifest(extracted, manifest)
    if (
      manifest.dataSha256 !== record.manifest.dataSha256 ||
      manifest.canonicalDomainDigest !== record.manifest.canonicalDomainDigest ||
      manifest.schemaFingerprint !== record.manifest.schemaFingerprint
    ) {
      throw new BackupError('INSPECTED_FILE_CHANGED', 'Staged backup no longer matches inspection')
    }
    const identity = await this.options.database.inspectUntrustedReadonly(
      extracted.databasePath,
      manifest,
    )
    assertDatabaseMatchesManifest(identity, manifest)
    this.records.delete(inspectionToken)
    return Object.freeze({
      manifest,
      privateArchivePath,
      extractedDatabasePath: extracted.databasePath,
      archiveSha256: copiedHash,
      archiveSizeBytes: copiedInfo.size,
    })
  }

  revoke(inspectionToken: string): void {
    this.records.delete(inspectionToken)
  }

  cleanupExpired(): void {
    const now = this.clock.now().getTime()
    for (const [token, record] of this.records) {
      if (now >= record.expiresAtMs) this.records.delete(token)
    }
  }

  private async assertSourceStillMatches(record: InspectionRecord): Promise<void> {
    await assertRegularFile(record.sourcePath, 'inspected backup')
    const info = await stat(record.sourcePath)
    if (info.size !== record.sourceSizeBytes || info.mtimeMs !== record.sourceMtimeMs) {
      throw new BackupError('INSPECTED_FILE_CHANGED', 'Inspected backup metadata changed')
    }
    if ((await sha256File(record.sourcePath)) !== record.archiveSha256) {
      throw new BackupError('INSPECTED_FILE_CHANGED', 'Inspected backup content changed')
    }
  }

  private assertContainerMatchesManifest(
    extracted: Awaited<ReturnType<typeof extractRestrictedBackupZip>>,
    manifest: BackupInspection['manifest'],
  ): void {
    if (
      extracted.databaseSha256 !== manifest.dataSha256 ||
      extracted.databaseSizeBytes !== manifest.dataSizeBytes
    ) {
      throw new BackupError('BACKUP_DATA_HASH_MISMATCH', 'data.sqlite does not match manifest')
    }
  }
}
