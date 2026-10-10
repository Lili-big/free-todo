import { readFile, writeFile } from 'node:fs/promises'

import type {
  BackupCompatibilityPolicy,
  BackupDatabasePort,
  BackupManifest,
  DatabaseIdentity,
  UntrustedDatabaseExpectation,
} from '../../../src/main/backup'
import { sha256File } from '../../../src/main/backup'

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const APP_ID = 'io.local.personaltodo'

export const COUNTS = Object.freeze({
  goalCategories: 1,
  goals: 2,
  projects: 3,
  tasks: 4,
  taskChangeLogs: 5,
  recurrenceSeries: 6,
  settings: 1,
})

export function identity(
  digest = HASH_A,
  schemaVersion = 1,
  schemaFingerprint = HASH_B,
): DatabaseIdentity {
  return Object.freeze({
    schemaVersion,
    applicationId: APP_ID,
    schemaFingerprint,
    canonicalDomainDigest: digest,
    objectCounts: COUNTS,
  })
}

export function compatibility(): BackupCompatibilityPolicy {
  return Object.freeze({
    applicationId: APP_ID,
    applicationVersion: '1.0.0',
    currentSchemaVersion: 1,
    supportedSchemaVersions: new Set([1]),
    supportedBackupFormatVersions: new Set([1]),
    schemaFingerprints: new Map([[1, HASH_B]]),
  })
}

export function manifest(dataSha256: string, dataSizeBytes: number): BackupManifest {
  return Object.freeze({
    backupFormatVersion: 1,
    schemaVersion: 1,
    applicationId: APP_ID,
    applicationVersion: '1.0.0',
    createdAtUtc: '2026-09-02T01:02:03.000Z',
    sourceTimeZone: 'Asia/Shanghai',
    dataSha256,
    dataSizeBytes,
    schemaFingerprint: HASH_B,
    canonicalDomainDigest: HASH_A,
    objectCounts: COUNTS,
  })
}

export class ByteIdentityDatabase implements BackupDatabasePort {
  primaryPath = ''
  private open = true

  constructor(
    private readonly bytesByDigest: ReadonlyMap<string, string> = new Map([
      ['A', HASH_A],
      ['B', HASH_B],
    ]),
  ) {}

  async createConsistentSnapshot(destinationPath: string): Promise<void> {
    if (this.primaryPath === '') throw new Error('primaryPath not set')
    await writeFile(destinationPath, await readFile(this.primaryPath), { flag: 'wx' })
  }

  async validateTrustedSnapshot(databasePath: string): Promise<DatabaseIdentity> {
    return this.forPath(databasePath)
  }

  async inspectUntrustedReadonly(
    databasePath: string,
    _expectation: UntrustedDatabaseExpectation,
  ): Promise<DatabaseIdentity> {
    return this.forPath(databasePath)
  }

  async importIntoFreshCurrentSchema(
    sourceDatabasePath: string,
    candidateDatabasePath: string,
    _sourceSchemaVersion: number,
  ): Promise<DatabaseIdentity> {
    await writeFile(candidateDatabasePath, await readFile(sourceDatabasePath), { flag: 'wx' })
    return this.forPath(candidateDatabasePath)
  }

  async validateClosedDatabase(databasePath: string): Promise<DatabaseIdentity> {
    return this.forPath(databasePath)
  }

  async closePrimaryForFileSwitch(): Promise<DatabaseIdentity> {
    this.open = false
    return this.forPath(this.primaryPath)
  }

  async reopenPrimaryAfterFileSwitch(): Promise<DatabaseIdentity> {
    this.open = true
    return this.forPath(this.primaryPath)
  }

  async enablePrimaryWalMode(): Promise<void> {
    if (!this.open) throw new Error('primary is closed')
  }

  async hash(databasePath: string): Promise<string> {
    return sha256File(databasePath)
  }

  private async forPath(databasePath: string): Promise<DatabaseIdentity> {
    const bytes = (await readFile(databasePath, 'utf8')).trim()
    const digest = this.bytesByDigest.get(bytes)
    if (digest === undefined) throw new Error(`invalid fake database: ${bytes}`)
    return identity(digest)
  }
}
