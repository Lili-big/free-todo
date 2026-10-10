import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AtomicFileSwitchPort } from './atomic-file-switch'
import { WindowsAtomicFileSwitch } from './atomic-file-switch'
import type { BackupExporter, ExportBackupResult } from './backup-exporter'
import type { BackupInspector } from './backup-inspector'
import { sha256File } from './crypto'
import { assertSufficientRestoreSpace } from './disk-space'
import { asBackupError, BackupError } from './errors'
import { assertDatabaseIdentitiesEqual } from './manifest'
import {
  createImmutablePlan,
  createRestoreMarker,
  type JournalLocationPolicy,
  makeRestorePlan,
} from './restore-journal'
import {
  assertAbsolutePath,
  assertPathWithin,
  NODE_DISK_SPACE,
  pathExists,
  removePrivateTree,
} from './safe-fs'
import {
  DEFAULT_BACKUP_LIMITS,
  NOOP_FAULT_INJECTOR,
  RESTORE_JOURNAL_FORMAT_VERSION,
  SYSTEM_CLOCK,
  type BackupDatabasePort,
  type BackupInspection,
  type BackupLimits,
  type ClockPort,
  type DataEpochPort,
  type DiskSpacePort,
  type FaultInjector,
  type MaintenanceLease,
  type MaintenancePort,
  type RestorePlan,
} from './types'

export interface RestoreCoordinatorOptions {
  readonly database: BackupDatabasePort
  readonly maintenance: MaintenancePort
  readonly exporter: BackupExporter
  readonly inspector: BackupInspector
  readonly primaryDatabasePath: string
  readonly restoreRootPath: string
  readonly restoreStagingRootPath: string
  readonly safetyBackupRootPath: string
  readonly dataEpoch?: DataEpochPort
  readonly atomicFileSwitch?: AtomicFileSwitchPort
  readonly diskSpace?: DiskSpacePort
  readonly limits?: BackupLimits
  readonly faultInjector?: FaultInjector
  readonly clock?: ClockPort
}

export interface RestoreResult {
  readonly operationId: string
  readonly canonicalDomainDigest: string
  readonly safetyBackup: ExportBackupResult
}

/**
 * Runtime restore transaction. Startup crash recovery is deliberately a
 * separate service so it runs before the ordinary persistence layer opens.
 */
export class RestoreCoordinator {
  private readonly switcher: AtomicFileSwitchPort
  private readonly diskSpace: DiskSpacePort
  private readonly limits: BackupLimits
  private readonly faults: FaultInjector
  private readonly clock: ClockPort

  constructor(private readonly options: RestoreCoordinatorOptions) {
    for (const [label, value] of [
      ['primary database', options.primaryDatabasePath],
      ['restore root', options.restoreRootPath],
      ['restore staging root', options.restoreStagingRootPath],
      ['safety backup root', options.safetyBackupRootPath],
    ] as const) {
      assertAbsolutePath(value, label)
    }
    this.switcher = options.atomicFileSwitch ?? new WindowsAtomicFileSwitch()
    this.diskSpace = options.diskSpace ?? NODE_DISK_SPACE
    this.limits = options.limits ?? DEFAULT_BACKUP_LIMITS
    this.faults = options.faultInjector ?? NOOP_FAULT_INJECTOR
    this.clock = options.clock ?? SYSTEM_CLOCK
  }

  async restore(inspection: BackupInspection): Promise<RestoreResult> {
    const operationId = randomUUID()
    const operationDirectory = resolve(this.options.restoreRootPath, operationId)
    const stagingDirectory = resolve(this.options.restoreStagingRootPath, operationId)
    assertPathWithin(this.options.restoreRootPath, operationDirectory, 'restore operation')
    assertPathWithin(this.options.restoreStagingRootPath, stagingDirectory, 'restore staging')
    await assertSufficientRestoreSpace(this.diskSpace, this.limits, {
      currentDatabasePath: this.options.primaryDatabasePath,
      sourceArchiveBytes: inspection.archiveSizeBytes,
      sourceDatabaseBytes: inspection.manifest.dataSizeBytes,
    })
    await mkdir(this.options.restoreRootPath, { recursive: true, mode: 0o700 })
    await mkdir(this.options.restoreStagingRootPath, { recursive: true, mode: 0o700 })
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 })

    let lease: MaintenanceLease | undefined
    let safetyBackup: ExportBackupResult | undefined
    let plan: RestorePlan | undefined
    let primaryClosed = false
    let oldMoved = false
    let committed = false
    let safeToRelease = false
    try {
      lease = await this.options.maintenance.acquireWriteMaintenance('RESTORE')
      await this.faults.hit('before_safety_backup', { operationId })
      safetyBackup = await this.createSafetyBackup(operationId)
      await this.faults.hit('after_safety_backup', { operationId })

      const claimed = await this.options.inspector.claimForRestore(
        inspection.inspectionToken,
        stagingDirectory,
      )
      if (claimed.archiveSha256 !== inspection.archiveSha256) {
        throw new BackupError('INSPECTED_FILE_CHANGED', 'Claimed backup differs from UI inspection')
      }

      // A journal directory only becomes visible after its bound safety backup exists.
      await mkdir(operationDirectory, { recursive: false, mode: 0o700 })
      const candidatePath = resolve(operationDirectory, 'candidate.sqlite3')
      const oldPath = resolve(operationDirectory, 'old.sqlite3')
      const candidateIdentity = await this.options.database.importIntoFreshCurrentSchema(
        claimed.extractedDatabasePath,
        candidatePath,
        claimed.manifest.schemaVersion,
      )
      const verifiedCandidate = await this.options.database.validateTrustedSnapshot(candidatePath)
      assertDatabaseIdentitiesEqual(verifiedCandidate, candidateIdentity, 'imported candidate')
      if (
        verifiedCandidate.canonicalDomainDigest !== claimed.manifest.canonicalDomainDigest ||
        !sameCounts(verifiedCandidate.objectCounts, claimed.manifest.objectCounts)
      ) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Candidate changed the imported domain dataset')
      }
      await this.faults.hit('after_candidate_prepared', { operationId })

      await lease.upgradeToExclusive()
      const oldIdentity = await this.options.database.closePrimaryForFileSwitch()
      primaryClosed = true
      if (safetyBackup.manifest.canonicalDomainDigest !== oldIdentity.canonicalDomainDigest) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Safety backup is not the current dataset')
      }

      const oldDatabaseSha256 = await sha256File(this.options.primaryDatabasePath)
      const candidateDatabaseSha256 = await sha256File(candidatePath)
      plan = makeRestorePlan({
        journalFormatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
        operationId,
        operationType: 'RESTORE',
        primaryDatabasePath: this.options.primaryDatabasePath,
        candidateDatabasePath: candidatePath,
        oldDatabasePath: oldPath,
        oldDatabaseSha256,
        candidateDatabaseSha256,
        oldCanonicalDomainDigest: oldIdentity.canonicalDomainDigest,
        candidateCanonicalDomainDigest: verifiedCandidate.canonicalDomainDigest,
        oldSchemaVersion: oldIdentity.schemaVersion,
        candidateSchemaVersion: verifiedCandidate.schemaVersion,
        safetyBackupPath: safetyBackup.destinationPath,
        createdAtUtc: this.clock.now().toISOString(),
      })
      await createImmutablePlan(operationDirectory, plan, this.journalPolicy())
      await createRestoreMarker(operationDirectory, plan, 'PREPARED', this.clock)
      await this.faults.hit('after_plan_durable', { operationId, planChecksum: plan.planChecksum })

      await this.switcher.moveExpectedFile({
        sourcePath: this.options.primaryDatabasePath,
        destinationPath: oldPath,
        expectedSourceSha256: oldDatabaseSha256,
      })
      oldMoved = true
      await createRestoreMarker(operationDirectory, plan, 'OLD_MOVED', this.clock)
      await this.faults.hit('after_old_moved', { operationId })

      await this.switcher.moveExpectedFile({
        sourcePath: candidatePath,
        destinationPath: this.options.primaryDatabasePath,
        expectedSourceSha256: candidateDatabaseSha256,
      })
      await createRestoreMarker(operationDirectory, plan, 'NEW_INSTALLED', this.clock)
      await this.faults.hit('after_new_installed', { operationId })

      const reopened = await this.options.database.reopenPrimaryAfterFileSwitch()
      primaryClosed = false
      assertDatabaseIdentitiesEqual(reopened, verifiedCandidate, 'verified restore candidate')
      await createRestoreMarker(operationDirectory, plan, 'VERIFIED', this.clock)
      await this.faults.hit('after_reopen_verified', { operationId })
      await createRestoreMarker(operationDirectory, plan, 'COMMITTED', this.clock)
      committed = true
      await this.faults.hit('after_commit_durable', { operationId })

      await this.options.database.enablePrimaryWalMode()
      await this.options.dataEpoch?.rotate()
      await lease.release()
      safeToRelease = true
      return {
        operationId,
        canonicalDomainDigest: reopened.canonicalDomainDigest,
        safetyBackup,
      }
    } catch (error) {
      if (lease !== undefined && !safeToRelease) {
        try {
          if (committed) {
            if (primaryClosed) await this.options.database.reopenPrimaryAfterFileSwitch()
            await this.options.database.enablePrimaryWalMode()
            await this.options.dataEpoch?.rotate()
          } else if (oldMoved && plan !== undefined) {
            if (!primaryClosed) {
              await this.options.database.closePrimaryForFileSwitch()
              primaryClosed = true
            }
            await this.rollbackToOld(operationDirectory, plan)
            primaryClosed = false
            await this.options.database.enablePrimaryWalMode()
            await this.options.dataEpoch?.rotate()
          } else if (primaryClosed) {
            await this.options.database.reopenPrimaryAfterFileSwitch()
            primaryClosed = false
            await this.options.database.enablePrimaryWalMode()
          }
          await lease.release()
          safeToRelease = true
        } catch (recoveryError) {
          throw new BackupError(
            'RECOVERY_READ_ONLY_REQUIRED',
            'Restore failed and the primary database could not be safely reopened',
            { cause: recoveryError, details: { operationId } },
          )
        }
      }
      throw asBackupError(error, 'RECOVERY_REQUIRED', 'Restore did not commit')
    } finally {
      await removePrivateTree(this.options.restoreStagingRootPath, stagingDirectory).catch(() => undefined)
      if (!oldMoved && !committed) {
        await removePrivateTree(this.options.restoreRootPath, operationDirectory).catch(() => undefined)
      }
    }
  }

  private async createSafetyBackup(operationId: string): Promise<ExportBackupResult> {
    await mkdir(this.options.safetyBackupRootPath, { recursive: true, mode: 0o700 })
    const stamp = this.clock.now().toISOString().replace(/[:.]/gu, '-')
    const destination = resolve(
      this.options.safetyBackupRootPath,
      `before-restore-${stamp}-${operationId}.todo-backup`,
    )
    assertPathWithin(this.options.safetyBackupRootPath, destination, 'safety backup')
    return this.options.exporter.exportTo(destination)
  }

  private async rollbackToOld(operationDirectory: string, plan: RestorePlan): Promise<void> {
    const quarantineDirectory = resolve(operationDirectory, 'quarantine')
    if (await pathExists(this.options.primaryDatabasePath)) {
      await this.switcher.quarantineDatabaseFamily(
        this.options.primaryDatabasePath,
        quarantineDirectory,
        `candidate-${randomUUID()}`,
      )
      await this.faults.hit('recovery_after_candidate_quarantined', { operationId: plan.operationId })
    }
    await this.switcher.moveExpectedFile({
      sourcePath: plan.oldDatabasePath,
      destinationPath: this.options.primaryDatabasePath,
      expectedSourceSha256: plan.oldDatabaseSha256,
    })
    await this.faults.hit('recovery_after_old_reinstalled', { operationId: plan.operationId })
    const restored = await this.options.database.reopenPrimaryAfterFileSwitch()
    if (restored.canonicalDomainDigest !== plan.oldCanonicalDomainDigest) {
      throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Rollback did not restore the old dataset')
    }
    await this.faults.hit('recovery_after_old_verified_before_cleanup', {
      operationId: plan.operationId,
    })
    await removePrivateTree(this.options.restoreRootPath, operationDirectory)
  }

  private journalPolicy(): JournalLocationPolicy {
    return {
      restoreRootPath: this.options.restoreRootPath,
      primaryDatabasePath: this.options.primaryDatabasePath,
      safetyBackupRootPath: this.options.safetyBackupRootPath,
    }
  }
}

function sameCounts(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}
