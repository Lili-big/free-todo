import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  BackupExporter,
  BackupInspector,
  RestoreCoordinator,
  StartupRestoreRecovery,
  pathExists,
  serializeBackupManifest,
  sha256Bytes,
  writeBackupZip,
  type FaultInjector,
  type MaintenancePort,
  type SafetyBackupRecoveryPort,
} from '../../../src/main/backup'
import {
  ByteIdentityDatabase,
  compatibility,
  HASH_B,
  manifest,
} from '../../unit/backup/helpers'

describe('runtime restore coordinator', () => {
  let root: string
  let primary: string
  let restoreRoot: string
  let stagingRoot: string
  let safetyRoot: string
  let database: ByteIdentityDatabase
  let exporter: BackupExporter
  let inspector: BackupInspector
  let maintenanceEvents: string[]
  let epochRotations: number

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'todo-runtime-restore-'))
    primary = resolve(root, 'data', 'app.sqlite3')
    restoreRoot = resolve(root, 'data', '.restore')
    stagingRoot = resolve(root, 'data', '.restore-staging')
    safetyRoot = resolve(root, 'backups', 'safety')
    await mkdir(resolve(root, 'data'), { recursive: true })
    await mkdir(restoreRoot, { recursive: true })
    await mkdir(stagingRoot, { recursive: true })
    await mkdir(safetyRoot, { recursive: true })
    await writeFile(primary, 'A')
    database = new ByteIdentityDatabase()
    database.primaryPath = primary
    exporter = new BackupExporter({
      database,
      compatibility: compatibility(),
      privateTemporaryRoot: resolve(root, 'export-temp'),
      sourceTimeZone: () => 'Asia/Shanghai',
    })
    inspector = new BackupInspector({
      database,
      compatibility: compatibility(),
      privateInspectionRoot: resolve(root, 'inspection-temp'),
    })
    maintenanceEvents = []
    epochRotations = 0
  })

  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('commits B only after reopen verification and leaves A as a safety backup', async () => {
    const inspection = await inspectDatasetB()
    const result = await coordinator().restore(inspection)
    await expect(readFile(primary, 'utf8')).resolves.toBe('B')
    expect(result.canonicalDomainDigest).toBe(HASH_B)
    expect(await pathExists(result.safetyBackup.destinationPath)).toBe(true)
    expect(maintenanceEvents).toEqual(['acquire', 'exclusive', 'release'])
    expect(epochRotations).toBe(1)
    expect(await pathExists(resolve(restoreRoot, result.operationId, 'COMMITTED'))).toBe(true)

    const startup = new StartupRestoreRecovery({
      database,
      safetyBackupRecovery: neverSafety(),
      primaryDatabasePath: primary,
      restoreRootPath: restoreRoot,
      safetyBackupRootPath: safetyRoot,
    })
    await startup.recoverPendingOperations()
    await expect(readFile(primary, 'utf8')).resolves.toBe('B')
    expect(await pathExists(resolve(restoreRoot, result.operationId))).toBe(false)
  })

  it('rolls back to complete A when a failure occurs after installing B but before COMMITTED', async () => {
    const inspection = await inspectDatasetB()
    await expect(
      coordinator(failAt('after_new_installed')).restore(inspection),
    ).rejects.toThrow('Restore did not commit')
    await expect(readFile(primary, 'utf8')).resolves.toBe('A')
    expect(maintenanceEvents.at(-1)).toBe('release')
    expect(epochRotations).toBe(1)
  })

  async function inspectDatasetB() {
    const sourceData = resolve(root, 'B.sqlite')
    const sourceArchive = resolve(root, 'B.todo-backup')
    await writeFile(sourceData, 'B')
    await writeBackupZip(
      sourceArchive,
      serializeBackupManifest({
        ...manifest(sha256Bytes('B'), 1),
        canonicalDomainDigest: HASH_B,
      }),
      sourceData,
      new Date('2026-09-02T01:02:03Z'),
    )
    return inspector.inspect(sourceArchive)
  }

  function coordinator(faultInjector?: FaultInjector): RestoreCoordinator {
    const maintenance: MaintenancePort = {
      async acquireWriteMaintenance() {
        maintenanceEvents.push('acquire')
        return {
          async upgradeToExclusive() {
            maintenanceEvents.push('exclusive')
          },
          async release() {
            maintenanceEvents.push('release')
          },
        }
      },
    }
    return new RestoreCoordinator({
      database,
      maintenance,
      exporter,
      inspector,
      primaryDatabasePath: primary,
      restoreRootPath: restoreRoot,
      restoreStagingRootPath: stagingRoot,
      safetyBackupRootPath: safetyRoot,
      diskSpace: { async availableBytes() { return Number.MAX_SAFE_INTEGER } },
      dataEpoch: { rotate() { epochRotations += 1 } },
      faultInjector,
    })
  }
})

function failAt(name: Parameters<FaultInjector['hit']>[0]): FaultInjector {
  return {
    async hit(actual) {
      if (actual === name) throw new Error(`injected I/O failure: ${name}`)
    },
  }
}

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
