import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  createImmutablePlan,
  createRestoreMarker,
  makeRestorePlan,
  pathExists,
  RESTORE_JOURNAL_FORMAT_VERSION,
  sha256File,
  StartupRestoreRecovery,
  type FaultInjector,
  type RestoreMarkerName,
  type RestorePlan,
  type SafetyBackupRecoveryPort,
} from '../../../src/main/backup'
import { ByteIdentityDatabase, HASH_A, HASH_B, identity } from '../../unit/backup/helpers'

describe('startup restore recovery state machine', () => {
  let root: string
  let restoreRoot: string
  let safetyRoot: string
  let primary: string
  let database: ByteIdentityDatabase

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'todo-recovery-'))
    restoreRoot = resolve(root, '.restore')
    safetyRoot = resolve(root, 'backups', 'safety')
    primary = resolve(root, 'data.sqlite3')
    await mkdir(restoreRoot, { recursive: true })
    await mkdir(safetyRoot, { recursive: true })
    database = new ByteIdentityDatabase()
    database.primaryPath = primary
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('rolls back a crash after NEW_INSTALLED to the complete old dataset', async () => {
    const fixture = await createOperation('A', 'B', [
      'PREPARED',
      'OLD_MOVED',
      'NEW_INSTALLED',
    ])
    const report = await recovery().recoverPendingOperations()
    expect(report.recoveredOperationIds).toEqual([fixture.plan.operationId])
    await expect(readFile(primary, 'utf8')).resolves.toBe('A')
    expect(await pathExists(fixture.directory)).toBe(false)
  })

  it('keeps the complete new dataset after durable COMMITTED and removes old data', async () => {
    const fixture = await createOperation('A', 'B', [
      'PREPARED',
      'OLD_MOVED',
      'NEW_INSTALLED',
      'VERIFIED',
      'COMMITTED',
    ])
    const report = await recovery().recoverPendingOperations()
    expect(report.committedOperationIds).toEqual([fixture.plan.operationId])
    await expect(readFile(primary, 'utf8')).resolves.toBe('B')
    expect(await pathExists(fixture.directory)).toBe(false)
  })

  it('is re-entrant across a double forced termination during rollback', async () => {
    const fixture = await createOperation('A', 'B', [
      'PREPARED',
      'OLD_MOVED',
      'NEW_INSTALLED',
    ])
    await expect(
      recovery(failOnceAt('recovery_after_candidate_quarantined')).recoverPendingOperations(),
    ).rejects.toThrow('Cannot safely recover')
    expect(await pathExists(primary)).toBe(false)
    expect(await pathExists(fixture.plan.oldDatabasePath)).toBe(true)

    await expect(
      recovery(failOnceAt('recovery_after_old_reinstalled')).recoverPendingOperations(),
    ).rejects.toThrow('Cannot safely recover')
    await expect(readFile(primary, 'utf8')).resolves.toBe('A')

    await expect(recovery().recoverPendingOperations()).resolves.toMatchObject({
      recoveredOperationIds: [fixture.plan.operationId],
    })
    await expect(readFile(primary, 'utf8')).resolves.toBe('A')
    expect(await pathExists(fixture.directory)).toBe(false)
  })

  it('rebuilds old data from the bound safety backup when both old locations are unusable', async () => {
    const fixture = await createOperation('A', 'B', ['PREPARED', 'OLD_MOVED', 'NEW_INSTALLED'])
    await rm(fixture.plan.oldDatabasePath)
    const safety: SafetyBackupRecoveryPort = {
      async rebuild(request) {
        await writeFile(request.destinationDatabasePath, 'A', { flag: 'wx' })
        return identity(HASH_A)
      },
      async rebuildForCorruptJournal(_operationId, destination) {
        await writeFile(destination, 'A', { flag: 'wx' })
        return identity(HASH_A)
      },
    }
    await recovery(undefined, safety).recoverPendingOperations()
    await expect(readFile(primary, 'utf8')).resolves.toBe('A')
  })

  function recovery(
    faultInjector?: FaultInjector,
    safetyBackupRecovery: SafetyBackupRecoveryPort = neverSafety(),
  ): StartupRestoreRecovery {
    return new StartupRestoreRecovery({
      database,
      safetyBackupRecovery,
      primaryDatabasePath: primary,
      restoreRootPath: restoreRoot,
      safetyBackupRootPath: safetyRoot,
      faultInjector,
    })
  }

  async function createOperation(
    oldBytes: 'A',
    newBytes: 'B',
    markers: readonly RestoreMarkerName[],
  ): Promise<{ directory: string; plan: RestorePlan }> {
    const operationId = randomUUID()
    const directory = resolve(restoreRoot, operationId)
    await mkdir(directory)
    const oldPath = resolve(directory, 'old.sqlite3')
    const candidatePath = resolve(directory, 'candidate.sqlite3')
    await writeFile(oldPath, oldBytes)
    await writeFile(primary, newBytes)
    const plan = makeRestorePlan({
      journalFormatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
      operationId,
      operationType: 'RESTORE',
      primaryDatabasePath: primary,
      candidateDatabasePath: candidatePath,
      oldDatabasePath: oldPath,
      oldDatabaseSha256: await sha256File(oldPath),
      candidateDatabaseSha256: await sha256File(primary),
      oldCanonicalDomainDigest: HASH_A,
      candidateCanonicalDomainDigest: HASH_B,
      oldSchemaVersion: 1,
      candidateSchemaVersion: 1,
      safetyBackupPath: resolve(safetyRoot, `before-restore-${operationId}.todo-backup`),
      createdAtUtc: new Date().toISOString(),
    })
    await createImmutablePlan(directory, plan, {
      restoreRootPath: restoreRoot,
      primaryDatabasePath: primary,
      safetyBackupRootPath: safetyRoot,
    })
    for (const marker of markers) await createRestoreMarker(directory, plan, marker)
    return { directory, plan }
  }
})

function neverSafety(): SafetyBackupRecoveryPort {
  return {
    async rebuild() {
      throw new Error('safety rebuild should not run')
    },
    async rebuildForCorruptJournal() {
      throw new Error('corrupt journal rebuild should not run')
    },
  }
}

function failOnceAt(name: Parameters<FaultInjector['hit']>[0]): FaultInjector {
  let failed = false
  return {
    async hit(actual) {
      if (!failed && actual === name) {
        failed = true
        throw new Error(`forced termination: ${name}`)
      }
    },
  }
}
