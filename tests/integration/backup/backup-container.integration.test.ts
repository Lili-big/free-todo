import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import * as yazl from 'yazl'

import {
  BackupExporter,
  BackupInspector,
  DEFAULT_BACKUP_LIMITS,
  extractRestrictedBackupZip,
  parseBackupManifest,
  serializeBackupManifest,
  sha256Bytes,
  writeBackupZip,
} from '../../../src/main/backup'
import { ByteIdentityDatabase, compatibility, manifest } from '../../unit/backup/helpers'

describe('portable .todo-backup container', () => {
  let root: string
  let database: ByteIdentityDatabase

  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'todo-backup-'))
    database = new ByteIdentityDatabase()
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('exports, reopens, and inspects a complete portable backup', async () => {
    const primary = resolve(root, 'primary.sqlite3')
    const destination = resolve(root, '中文迁移.todo-backup')
    await writeFile(primary, 'A')
    database.primaryPath = primary
    const exporter = new BackupExporter({
      database,
      compatibility: compatibility(),
      privateTemporaryRoot: resolve(root, 'export-temp'),
      sourceTimeZone: () => 'Asia/Shanghai',
    })
    const exported = await exporter.exportTo(destination)
    expect(exported.manifest.canonicalDomainDigest).toBe('a'.repeat(64))
    expect(exported.manifest).not.toHaveProperty('sourcePath')
    expect((await stat(destination)).size).toBe(exported.archiveSizeBytes)

    const inspector = new BackupInspector({
      database,
      compatibility: compatibility(),
      privateInspectionRoot: resolve(root, 'inspection-temp'),
    })
    const inspection = await inspector.inspect(destination)
    expect(inspection.manifest.objectCounts.tasks).toBe(4)
    const claim = await inspector.claimForRestore(
      inspection.inspectionToken,
      resolve(root, 'private-stage'),
    )
    await expect(readFile(claim.extractedDatabasePath, 'utf8')).resolves.toBe('A')
    await expect(
      inspector.claimForRestore(inspection.inspectionToken, resolve(root, 'second-stage')),
    ).rejects.toThrow('already used')
  })

  it('rejects a file replaced after inspection', async () => {
    const archive = resolve(root, 'source.todo-backup')
    const data = resolve(root, 'data.sqlite')
    await writeFile(data, 'A')
    await writeBackupZip(
      archive,
      serializeBackupManifest(manifest(sha256Bytes('A'), 1)),
      data,
      new Date('2026-09-02T00:00:00Z'),
    )
    const inspector = new BackupInspector({
      database,
      compatibility: compatibility(),
      privateInspectionRoot: resolve(root, 'inspection-temp'),
    })
    const inspection = await inspector.inspect(archive)
    await writeFile(archive, 'replacement')
    await expect(
      inspector.claimForRestore(inspection.inspectionToken, resolve(root, 'stage')),
    ).rejects.toThrow('changed')
  })

  it('rejects extra ZIP entries', async () => {
    const archive = resolve(root, 'extra.todo-backup')
    await writeRawZip(archive, [
      ['manifest.json', Buffer.from('{}')],
      ['data.sqlite', Buffer.from('A')],
      ['extra.txt', Buffer.from('not allowed')],
    ])
    await expect(
      extractRestrictedBackupZip(archive, resolve(root, 'extract'), DEFAULT_BACKUP_LIMITS),
    ).rejects.toThrow('Unexpected or duplicate')
  })

  it('rejects an excessive compression ratio before extraction', async () => {
    const archive = resolve(root, 'bomb.todo-backup')
    const data = resolve(root, 'large.sqlite')
    await writeFile(data, Buffer.alloc(128 * 1024, 0))
    await writeBackupZip(
      archive,
      serializeBackupManifest(manifest(sha256Bytes(Buffer.alloc(128 * 1024, 0)), 128 * 1024)),
      data,
      new Date('2026-09-02T00:00:00Z'),
    )
    await expect(
      extractRestrictedBackupZip(archive, resolve(root, 'extract'), {
        ...DEFAULT_BACKUP_LIMITS,
        maxCompressionRatio: 2,
      }),
    ).rejects.toThrow('compression ratio')
  })

  it('keeps manifest encoding strict after extraction', async () => {
    const archive = resolve(root, 'source.todo-backup')
    const data = resolve(root, 'data.sqlite')
    await writeFile(data, 'A')
    await writeBackupZip(
      archive,
      serializeBackupManifest(manifest(sha256Bytes('A'), 1)),
      data,
      new Date('2026-09-02T00:00:00Z'),
    )
    const extracted = await extractRestrictedBackupZip(
      archive,
      resolve(root, 'extract'),
      DEFAULT_BACKUP_LIMITS,
    )
    expect(parseBackupManifest(extracted.manifestBytes, compatibility()).sourceTimeZone).toBe(
      'Asia/Shanghai',
    )
  })
})

async function writeRawZip(
  destination: string,
  entries: ReadonlyArray<readonly [string, Buffer]>,
): Promise<void> {
  const zip = new yazl.ZipFile()
  const output = createWriteStream(destination, { flags: 'wx' })
  const done = new Promise<void>((resolvePromise, reject) => {
    output.once('close', resolvePromise)
    output.once('error', reject)
    zip.outputStream.once('error', reject)
  })
  zip.outputStream.pipe(output)
  for (const [name, contents] of entries) zip.addBuffer(contents, name)
  zip.end()
  await done
}
