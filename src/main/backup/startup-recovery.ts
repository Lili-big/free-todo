import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { AtomicFileSwitchPort } from './atomic-file-switch'
import { WindowsAtomicFileSwitch } from './atomic-file-switch'
import { sha256File } from './crypto'
import { BackupError } from './errors'
import {
  readImmutablePlan,
  readValidMarkers,
  type JournalLocationPolicy,
} from './restore-journal'
import type { SafetyBackupRecoveryPort } from './safety-backup-rebuilder'
import {
  assertAbsolutePath,
  assertPathWithin,
  listRealDirectories,
  pathExists,
  removePrivateTree,
} from './safe-fs'
import {
  NOOP_FAULT_INJECTOR,
  type BackupDatabasePort,
  type DatabaseIdentity,
  type FaultInjector,
  type RestorePlan,
} from './types'

export interface StartupRecoveryOptions {
  readonly database: BackupDatabasePort
  readonly safetyBackupRecovery: SafetyBackupRecoveryPort
  readonly primaryDatabasePath: string
  readonly restoreRootPath: string
  readonly safetyBackupRootPath: string
  readonly atomicFileSwitch?: AtomicFileSwitchPort
  readonly faultInjector?: FaultInjector
}

export interface StartupRecoveryReport {
  readonly recoveredOperationIds: readonly string[]
  readonly committedOperationIds: readonly string[]
  readonly corruptJournalOperationIds: readonly string[]
}

interface PendingOperation {
  readonly directory: string
  readonly operationId: string
  readonly modifiedAtMs: number
  readonly plan?: RestorePlan
  readonly committed: boolean
  readonly corrupt: boolean
}

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Must run before any normal DB connection, migration, or maintenance sweep. */
export class StartupRestoreRecovery {
  private readonly switcher: AtomicFileSwitchPort
  private readonly faults: FaultInjector

  constructor(private readonly options: StartupRecoveryOptions) {
    assertAbsolutePath(options.primaryDatabasePath, 'primary database')
    assertAbsolutePath(options.restoreRootPath, 'restore root')
    assertAbsolutePath(options.safetyBackupRootPath, 'safety backup root')
    this.switcher = options.atomicFileSwitch ?? new WindowsAtomicFileSwitch()
    this.faults = options.faultInjector ?? NOOP_FAULT_INJECTOR
  }

  async recoverPendingOperations(): Promise<StartupRecoveryReport> {
    const operations = await this.loadOperations()
    const recovered: string[] = []
    const committed: string[] = []
    const corrupt: string[] = []
    const supersededCommittedDigests = new Set<string>()

    for (const operation of operations) {
      try {
        if (operation.corrupt || operation.plan === undefined) {
          await this.recoverCorruptJournal(operation)
          recovered.push(operation.operationId)
          corrupt.push(operation.operationId)
          continue
        }
        if (operation.committed) {
          const result = await this.finishCommitted(
            operation,
            supersededCommittedDigests.has(operation.plan.candidateCanonicalDomainDigest),
          )
          supersededCommittedDigests.add(operation.plan.oldCanonicalDomainDigest)
          if (result === 'CURRENT') {
            supersededCommittedDigests.add(operation.plan.oldCanonicalDomainDigest)
          }
          committed.push(operation.operationId)
          continue
        }
        await this.rollbackUncommitted(operation)
        recovered.push(operation.operationId)
      } catch (error) {
        if (error instanceof BackupError && error.code === 'RECOVERY_READ_ONLY_REQUIRED') throw error
        throw new BackupError(
          'RECOVERY_READ_ONLY_REQUIRED',
          `Cannot safely recover restore operation ${operation.operationId}`,
          { cause: error },
        )
      }
    }

    return Object.freeze({
      recoveredOperationIds: Object.freeze(recovered),
      committedOperationIds: Object.freeze(committed),
      corruptJournalOperationIds: Object.freeze(corrupt),
    })
  }

  private async loadOperations(): Promise<PendingOperation[]> {
    const directories = await listRealDirectories(this.options.restoreRootPath)
    const operations: PendingOperation[] = []
    for (const directory of directories) {
      const operationId = basename(directory)
      if (!OPERATION_ID_PATTERN.test(operationId)) continue
      let plan: RestorePlan | undefined
      let committed = false
      let corrupt = false
      try {
        plan = await readImmutablePlan(directory, this.journalPolicy())
        const markers = await readValidMarkers(directory, plan)
        committed = markers.has('COMMITTED')
      } catch {
        corrupt = true
      }
      operations.push({
        directory,
        operationId,
        modifiedAtMs: (await stat(directory)).mtimeMs,
        plan,
        committed,
        corrupt,
      })
    }
    // The latest operation must be resolved first; its old digest links to an ancestor.
    return operations.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
  }

  private async rollbackUncommitted(operation: PendingOperation): Promise<void> {
    const plan = requirePlan(operation)
    const oldAtOldPath = await this.matchesDataset(
      plan.oldDatabasePath,
      plan.oldCanonicalDomainDigest,
      plan.oldDatabaseSha256,
    )
    const oldAtPrimaryPath = await this.matchesDataset(
      this.options.primaryDatabasePath,
      plan.oldCanonicalDomainDigest,
      plan.oldDatabaseSha256,
    )
    const quarantine = resolve(operation.directory, `quarantine-${randomUUID()}`)

    if (oldAtOldPath) {
      await this.switcher.quarantineDatabaseFamily(
        this.options.primaryDatabasePath,
        quarantine,
        'uncommitted-candidate',
      )
      await this.faults.hit('recovery_after_candidate_quarantined', {
        operationId: plan.operationId,
      })
      await this.switcher.moveExpectedFile({
        sourcePath: plan.oldDatabasePath,
        destinationPath: this.options.primaryDatabasePath,
        expectedSourceSha256: plan.oldDatabaseSha256,
      })
      await this.faults.hit('recovery_after_old_reinstalled', { operationId: plan.operationId })
    } else if (
      oldAtPrimaryPath ||
      (plan.oldCanonicalDomainDigest !== plan.candidateCanonicalDomainDigest &&
        (await this.matchesDataset(
          this.options.primaryDatabasePath,
          plan.oldCanonicalDomainDigest,
        )))
    ) {
      // The digest-only branch recognizes a safety-rebuilt old DB after a second crash.
      await this.switcher.quarantineDatabaseFamily(
        plan.candidateDatabasePath,
        quarantine,
        'unused-candidate',
      )
    } else {
      const rebuiltPath = resolve(operation.directory, `rebuilt-old-${randomUUID()}.sqlite3`)
      assertPathWithin(operation.directory, rebuiltPath, 'rebuilt old database')
      await this.faults.hit('recovery_during_safety_backup_rebuild', {
        operationId: plan.operationId,
      })
      const rebuilt = await this.options.safetyBackupRecovery.rebuild({
        safetyBackupPath: plan.safetyBackupPath,
        destinationDatabasePath: rebuiltPath,
        expectedCanonicalDomainDigest: plan.oldCanonicalDomainDigest,
      })
      if (rebuilt.canonicalDomainDigest !== plan.oldCanonicalDomainDigest) {
        throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Safety backup rebuilt the wrong dataset')
      }
      await this.switcher.quarantineDatabaseFamily(
        this.options.primaryDatabasePath,
        quarantine,
        'unknown-primary',
      )
      await this.switcher.quarantineDatabaseFamily(plan.oldDatabasePath, quarantine, 'invalid-old')
      await this.switcher.quarantineDatabaseFamily(
        plan.candidateDatabasePath,
        quarantine,
        'unused-candidate',
      )
      await this.switcher.moveExpectedFile({
        sourcePath: rebuiltPath,
        destinationPath: this.options.primaryDatabasePath,
        expectedSourceSha256: await sha256File(rebuiltPath),
      })
      await this.faults.hit('recovery_after_old_reinstalled', { operationId: plan.operationId })
    }

    const restored = await this.options.database.validateClosedDatabase(
      this.options.primaryDatabasePath,
    )
    if (restored.canonicalDomainDigest !== plan.oldCanonicalDomainDigest) {
      throw new BackupError('BACKUP_DOMAIN_MISMATCH', 'Recovered primary is not the old dataset')
    }
    await this.faults.hit('recovery_after_old_verified_before_cleanup', {
      operationId: plan.operationId,
    })
    await removePrivateTree(this.options.restoreRootPath, operation.directory)
  }

  private async finishCommitted(
    operation: PendingOperation,
    superseded: boolean,
  ): Promise<'CURRENT' | 'SUPERSEDED'> {
    const plan = requirePlan(operation)
    if (!superseded) {
      const primary = await this.tryValidate(this.options.primaryDatabasePath)
      if (primary?.canonicalDomainDigest !== plan.candidateCanonicalDomainDigest) {
        throw new BackupError(
          'RECOVERY_READ_ONLY_REQUIRED',
          'Committed restore primary does not contain the committed dataset',
        )
      }
    }
    await this.switcher.removeDatabaseFamily(plan.oldDatabasePath)
    await this.faults.hit('commit_cleanup_after_old_deleted', { operationId: plan.operationId })
    await removePrivateTree(this.options.restoreRootPath, operation.directory)
    return superseded ? 'SUPERSEDED' : 'CURRENT'
  }

  private async recoverCorruptJournal(operation: PendingOperation): Promise<void> {
    const rebuiltPath = resolve(operation.directory, `rebuilt-corrupt-${randomUUID()}.sqlite3`)
    assertPathWithin(operation.directory, rebuiltPath, 'corrupt-journal rebuild')
    const rebuilt = await this.options.safetyBackupRecovery.rebuildForCorruptJournal(
      operation.operationId,
      rebuiltPath,
    )
    const quarantine = resolve(operation.directory, `quarantine-corrupt-${randomUUID()}`)
    await this.switcher.quarantineDatabaseFamily(
      this.options.primaryDatabasePath,
      quarantine,
      'unknown-primary',
    )
    await this.switcher.quarantineDatabaseFamily(
      resolve(operation.directory, 'old.sqlite3'),
      quarantine,
      'possible-old',
    )
    await this.switcher.quarantineDatabaseFamily(
      resolve(operation.directory, 'candidate.sqlite3'),
      quarantine,
      'possible-candidate',
    )
    await this.switcher.moveExpectedFile({
      sourcePath: rebuiltPath,
      destinationPath: this.options.primaryDatabasePath,
      expectedSourceSha256: await sha256File(rebuiltPath),
    })
    const verified = await this.options.database.validateClosedDatabase(
      this.options.primaryDatabasePath,
    )
    if (verified.canonicalDomainDigest !== rebuilt.canonicalDomainDigest) {
      throw new BackupError('RECOVERY_READ_ONLY_REQUIRED', 'Corrupt-journal safety rebuild failed')
    }
    await removePrivateTree(this.options.restoreRootPath, operation.directory)
  }

  private async matchesDataset(
    databasePath: string,
    expectedDigest: string,
    expectedHash?: string,
  ): Promise<boolean> {
    if (!(await pathExists(databasePath))) return false
    try {
      const [identity, hash] = await Promise.all([
        this.options.database.validateClosedDatabase(databasePath),
        sha256File(databasePath),
      ])
      return (
        identity.canonicalDomainDigest === expectedDigest &&
        (expectedHash === undefined || hash === expectedHash)
      )
    } catch {
      return false
    }
  }

  private async tryValidate(databasePath: string): Promise<DatabaseIdentity | null> {
    if (!(await pathExists(databasePath))) return null
    try {
      return await this.options.database.validateClosedDatabase(databasePath)
    } catch {
      return null
    }
  }

  private journalPolicy(): JournalLocationPolicy {
    return {
      restoreRootPath: this.options.restoreRootPath,
      primaryDatabasePath: this.options.primaryDatabasePath,
      safetyBackupRootPath: this.options.safetyBackupRootPath,
    }
  }
}

function requirePlan(operation: PendingOperation): RestorePlan {
  if (operation.plan === undefined) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Operation has no valid plan')
  }
  return operation.plan
}
