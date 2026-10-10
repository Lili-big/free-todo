import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AtomicFileSwitchPort } from './atomic-file-switch'
import { WindowsAtomicFileSwitch } from './atomic-file-switch'
import type { BackupExporter, ExportBackupResult } from './backup-exporter'
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
  type BackupLimits,
  type ClockPort,
  type DataEpochPort,
  type DiskSpacePort,
  type FaultInjector,
  type MaintenanceLease,
  type MaintenancePort,
  type MigrationCandidatePort,
  type RestorePlan,
} from './types'

export interface MigrationCoordinatorOptions {
  readonly database: BackupDatabasePort
  readonly candidateMigrator: MigrationCandidatePort
  readonly maintenance: MaintenancePort
  readonly exporter: BackupExporter
  readonly primaryDatabasePath: string
  readonly restoreRootPath: string
  readonly safetyBackupRootPath: string
  readonly targetSchemaVersion: number
  readonly dataEpoch?: DataEpochPort
  readonly atomicFileSwitch?: AtomicFileSwitchPort
  readonly diskSpace?: DiskSpacePort
  readonly limits?: BackupLimits
  readonly faultInjector?: FaultInjector
  readonly clock?: ClockPort
}

export interface MigrationResult {
  readonly operationId: string
  readonly fromSchemaVersion: number
  readonly toSchemaVersion: number
  readonly canonicalDomainDigest: string
  readonly safetyBackup: ExportBackupResult
}

/** Candidate-only migration using the same crash-consistent switch journal as restore. */
export class MigrationCoordinator {
  private readonly switcher: AtomicFileSwitchPort
  private readonly diskSpace: DiskSpacePort
  private readonly limits: BackupLimits
  private readonly faults: FaultInjector
  private readonly clock: ClockPort

  constructor(private readonly options: MigrationCoordinatorOptions) {
    assertAbsolutePath(options.primaryDatabasePath, 'primary database')
    assertAbsolutePath(options.restoreRootPath, 'restore root')
    assertAbsolutePath(options.safetyBackupRootPath, 'safety backup root')
    if (!Number.isSafeInteger(options.targetSchemaVersion) || options.targetSchemaVersion < 1) {
      throw new BackupError('BACKUP_INCOMPATIBLE_SCHEMA', 'Invalid migration target schema')
    }
    this.switcher = options.atomicFileSwitch ?? new WindowsAtomicFileSwitch()
    this.diskSpace = options.diskSpace ?? NODE_DISK_SPACE
    this.limits = options.limits ?? DEFAULT_BACKUP_LIMITS
    this.faults = options.faultInjector ?? NOOP_FAULT_INJECTOR
    this.clock = options.clock ?? SYSTEM_CLOCK
  }

  async migrate(sourceSchemaVersion: number): Promise<MigrationResult> {
    if (
      !Number.isSafeInteger(sourceSchemaVersion) ||
      sourceSchemaVersion < 1 ||
      sourceSchemaVersion >= this.options.targetSchemaVersion
    ) {
      throw new BackupError(
        'BACKUP_INCOMPATIBLE_SCHEMA',
        'Migration source must be an older supported schema',
      )
    }
    const operationId = randomUUID()
    const operationDirectory = resolve(this.options.restoreRootPath, operationId)
    assertPathWithin(this.options.restoreRootPath, operationDirectory, 'migration operation')
    const currentSize = (await stat(this.options.primaryDatabasePath)).size
    await assertSufficientRestoreSpace(this.diskSpace, this.limits, {
      currentDatabasePath: this.options.primaryDatabasePath,
      sourceArchiveBytes: 0,
      sourceDatabaseBytes: currentSize,
    })
    await mkdir(this.options.restoreRootPath, { recursive: true, mode: 0o700 })

    let lease: MaintenanceLease | undefined
    let safetyBackup: ExportBackupResult | undefined
    let plan: RestorePlan | undefined
    let operationCreated = false
    let primaryClosed = false
    let oldMoved = false
    let committed = false
    let safeToRelease = false
    try {
      lease = await this.options.maintenance.acquireWriteMaintenance('MIGRATION')
      await this.faults.hit('before_safety_backup', { operationId })
      safetyBackup = await this.createSafetyBackup(operationId, sourceSchemaVersion)
      await this.faults.hit('after_safety_backup', { operationId })

      await mkdir(operationDirectory, { recursive: false, mode: 0o700 })
      operationCreated = true
      const candidatePath = resolve(operationDirectory, 'candidate.sqlite3')
      const oldPath = resolve(operationDirectory, 'old.sqlite3')
      await this.options.database.createConsistentSnapshot(candidatePath)
      const sourceCandidate = await this.options.database.validateTrustedSnapshot(candidatePath)
      if (sourceCandidate.schemaVersion !== sourceSchemaVersion) {
        throw new BackupError('BACKUP_SCHEMA_MISMATCH', 'Migration snapshot source version changed')
      }
      const migrated = await this.options.candidateMigrator.migrateCandidate(
        candidatePath,
        sourceSchemaVersion,
      )
      const verifiedCandidate = await this.options.database.validateTrustedSnapshot(candidatePath)
      assertDatabaseIdentitiesEqual(verifiedCandidate, migrated, 'migrated candidate')
      if (verifiedCandidate.schemaVersion !== this.options.targetSchemaVersion) {
        throw new BackupError('BACKUP_SCHEMA_MISMATCH', 'Migration did not reach target schema')
      }
      if (verifiedCandidate.canonicalDomainDigest !== sourceCandidate.canonicalDomainDigest) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Migration changed the logical dataset')
      }
      await this.faults.hit('after_candidate_prepared', { operationId })

      await lease.upgradeToExclusive()
      const oldIdentity = await this.options.database.closePrimaryForFileSwitch()
      primaryClosed = true
      if (
        oldIdentity.schemaVersion !== sourceSchemaVersion ||
        oldIdentity.canonicalDomainDigest !== safetyBackup.manifest.canonicalDomainDigest
      ) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Migration safety backup is not current data')
      }
      const oldHash = await sha256File(this.options.primaryDatabasePath)
      const candidateHash = await sha256File(candidatePath)
      plan = makeRestorePlan({
        journalFormatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
        operationId,
        operationType: 'MIGRATION',
        primaryDatabasePath: this.options.primaryDatabasePath,
        candidateDatabasePath: candidatePath,
        oldDatabasePath: oldPath,
        oldDatabaseSha256: oldHash,
        candidateDatabaseSha256: candidateHash,
        oldCanonicalDomainDigest: oldIdentity.canonicalDomainDigest,
        candidateCanonicalDomainDigest: verifiedCandidate.canonicalDomainDigest,
        oldSchemaVersion: oldIdentity.schemaVersion,
        candidateSchemaVersion: verifiedCandidate.schemaVersion,
        safetyBackupPath: safetyBackup.destinationPath,
        createdAtUtc: this.clock.now().toISOString(),
      })
      await createImmutablePlan(operationDirectory, plan, this.journalPolicy())
      await createRestoreMarker(operationDirectory, plan, 'PREPARED', this.clock)
      await this.faults.hit('after_plan_durable', { operationId })

      await this.switcher.moveExpectedFile({
        sourcePath: this.options.primaryDatabasePath,
        destinationPath: oldPath,
        expectedSourceSha256: oldHash,
      })
      oldMoved = true
      await createRestoreMarker(operationDirectory, plan, 'OLD_MOVED', this.clock)
      await this.faults.hit('after_old_moved', { operationId })
      await this.switcher.moveExpectedFile({
        sourcePath: candidatePath,
        destinationPath: this.options.primaryDatabasePath,
        expectedSourceSha256: candidateHash,
      })
      await createRestoreMarker(operationDirectory, plan, 'NEW_INSTALLED', this.clock)
      await this.faults.hit('after_new_installed', { operationId })

      const reopened = await this.options.database.reopenPrimaryAfterFileSwitch()
      primaryClosed = false
      assertDatabaseIdentitiesEqual(reopened, verifiedCandidate, 'migrated primary')
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
        fromSchemaVersion: sourceSchemaVersion,
        toSchemaVersion: reopened.schemaVersion,
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
            await this.rollback(operationDirectory, plan)
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
            'Migration failed and the old database could not be safely reopened',
            { cause: recoveryError, details: { operationId } },
          )
        }
      }
      throw asBackupError(error, 'RECOVERY_REQUIRED', 'Migration did not commit')
    } finally {
      if (operationCreated && !oldMoved && !committed) {
        await removePrivateTree(this.options.restoreRootPath, operationDirectory).catch(() => undefined)
      }
    }
  }

  private async rollback(operationDirectory: string, plan: RestorePlan): Promise<void> {
    const quarantine = resolve(operationDirectory, `quarantine-${randomUUID()}`)
    await this.switcher.quarantineDatabaseFamily(
      this.options.primaryDatabasePath,
      quarantine,
      'uncommitted-migration',
    )
    await this.faults.hit('recovery_after_candidate_quarantined', { operationId: plan.operationId })
    await this.switcher.moveExpectedFile({
      sourcePath: plan.oldDatabasePath,
      destinationPath: this.options.primaryDatabasePath,
      expectedSourceSha256: plan.oldDatabaseSha256,
    })
    await this.faults.hit('recovery_after_old_reinstalled', { operationId: plan.operationId })
    const reopened = await this.options.database.reopenPrimaryAfterFileSwitch()
    if (reopened.canonicalDomainDigest !== plan.oldCanonicalDomainDigest) {
      throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Migration rollback restored wrong data')
    }
    await this.faults.hit('recovery_after_old_verified_before_cleanup', {
      operationId: plan.operationId,
    })
    await removePrivateTree(this.options.restoreRootPath, operationDirectory)
  }

  private async createSafetyBackup(
    operationId: string,
    sourceSchemaVersion: number,
  ): Promise<ExportBackupResult> {
    await mkdir(this.options.safetyBackupRootPath, { recursive: true, mode: 0o700 })
    const stamp = this.clock.now().toISOString().replace(/[:.]/gu, '-')
    const destination = resolve(
      this.options.safetyBackupRootPath,
      `before-migration-${stamp}-${operationId}.todo-backup`,
    )
    assertPathWithin(this.options.safetyBackupRootPath, destination, 'migration safety backup')
    return this.options.exporter.exportTo(destination, { expectedSchemaVersion: sourceSchemaVersion })
  }

  private journalPolicy(): JournalLocationPolicy {
    return {
      restoreRootPath: this.options.restoreRootPath,
      primaryDatabasePath: this.options.primaryDatabasePath,
      safetyBackupRootPath: this.options.safetyBackupRootPath,
    }
  }
}
