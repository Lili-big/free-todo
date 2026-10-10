import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { constants, mkdir, open, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'

import { BackupError } from './errors'
import { assertPathWithin, assertRegularFile, syncFile } from './safe-fs'
import type { BackupLimits } from './types'

const ALLOWED_ENTRIES = new Set(['manifest.json', 'data.sqlite'])
const UNIX_FILE_TYPE_MASK = 0o170000
const UNIX_SYMBOLIC_LINK = 0o120000
const DOS_DIRECTORY_ATTRIBUTE = 0x10

export interface ExtractedBackupArchive {
  readonly manifestBytes: Buffer
  readonly databasePath: string
  readonly databaseSha256: string
  readonly databaseSizeBytes: number
}

export async function extractRestrictedBackupZip(
  archivePath: string,
  extractionDirectory: string,
  limits: BackupLimits,
): Promise<ExtractedBackupArchive> {
  await assertRegularFile(archivePath, 'backup archive')
  const archiveInfo = await stat(archivePath)
  if (archiveInfo.size <= 0 || archiveInfo.size > limits.maxArchiveBytes) {
    throw new BackupError('BACKUP_TOO_LARGE', 'Backup archive size is outside allowed limits')
  }
  await mkdir(extractionDirectory, { recursive: true, mode: 0o700 })
  const databasePath = resolve(extractionDirectory, 'data.sqlite')
  assertPathWithin(extractionDirectory, databasePath, 'database extraction path')

  const zip = await openZip(archivePath)
  const seen = new Set<string>()
  let manifestBytes: Buffer | undefined
  let databaseSha256: string | undefined
  let databaseSizeBytes = 0
  let totalUncompressedBytes = 0

  try {
    while (true) {
      const entry = await nextEntry(zip)
      if (entry === null) break
      validateEntry(entry, seen, limits)
      totalUncompressedBytes += entry.uncompressedSize
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw new BackupError('BACKUP_TOO_LARGE', 'Uncompressed backup exceeds total limit')
      }

      if (entry.fileName === 'manifest.json') {
        manifestBytes = await readEntryToBuffer(zip, entry, limits.maxManifestBytes)
      } else {
        const result = await extractDatabaseEntry(zip, entry, databasePath, limits.maxDatabaseBytes)
        databaseSha256 = result.sha256
        databaseSizeBytes = result.size
      }
    }
  } finally {
    zip.close()
  }

  if (seen.size !== 2 || manifestBytes === undefined || databaseSha256 === undefined) {
    await rm(databasePath, { force: true }).catch(() => undefined)
    throw new BackupError(
      'BACKUP_ZIP_INVALID',
      'Backup must contain exactly manifest.json and data.sqlite',
    )
  }
  return { manifestBytes, databasePath, databaseSha256, databaseSizeBytes }
}

export async function writeBackupZip(
  destinationPath: string,
  manifestBytes: Uint8Array,
  databasePath: string,
  createdAt: Date,
): Promise<void> {
  await assertRegularFile(databasePath, 'SQLite snapshot')
  const zip = new yazl.ZipFile()
  const output = createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
  const completion = new Promise<void>((resolvePromise, reject) => {
    output.once('close', resolvePromise)
    output.once('error', reject)
    zip.outputStream.once('error', reject)
  })
  zip.outputStream.pipe(output)
  zip.addBuffer(Buffer.from(manifestBytes), 'manifest.json', {
    mtime: createdAt,
    mode: 0o100600,
    compress: true,
  })
  zip.addFile(databasePath, 'data.sqlite', {
    mtime: createdAt,
    mode: 0o100600,
    compress: true,
  })
  zip.end()
  await completion
  await syncFile(destinationPath)
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null) reject(new BackupError('BACKUP_ZIP_INVALID', 'Cannot open backup ZIP', { cause: error }))
        else if (zip === undefined) reject(new BackupError('BACKUP_ZIP_INVALID', 'ZIP reader returned no archive'))
        else resolvePromise(zip)
      },
    )
  })
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolvePromise, reject) => {
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup()
      resolvePromise(entry)
    }
    const onEnd = (): void => {
      cleanup()
      resolvePromise(null)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(new BackupError('BACKUP_ZIP_INVALID', 'Invalid ZIP central directory', { cause: error }))
    }
    const cleanup = (): void => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function validateEntry(entry: yauzl.Entry, seen: Set<string>, limits: BackupLimits): void {
  if (!ALLOWED_ENTRIES.has(entry.fileName) || seen.has(entry.fileName)) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', `Unexpected or duplicate ZIP entry: ${entry.fileName}`)
  }
  if (entry.fileName.includes('/') || entry.fileName.includes('\\') || entry.fileName.includes('\0')) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', 'ZIP paths and traversal are forbidden')
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', 'Encrypted ZIP entries are forbidden')
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMBOLIC_LINK) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', 'Symbolic links are forbidden')
  }
  if ((entry.externalFileAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0 || /\/$/u.test(entry.fileName)) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', 'ZIP directories are forbidden')
  }
  const perFileLimit = entry.fileName === 'manifest.json' ? limits.maxManifestBytes : limits.maxDatabaseBytes
  if (entry.uncompressedSize <= 0 || entry.uncompressedSize > perFileLimit) {
    throw new BackupError('BACKUP_TOO_LARGE', `${entry.fileName} exceeds its size limit`)
  }
  const ratio = entry.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedSize / entry.compressedSize
  if (ratio > limits.maxCompressionRatio) {
    throw new BackupError('BACKUP_ZIP_ENTRY_INVALID', `${entry.fileName} exceeds compression ratio limit`)
  }
  seen.add(entry.fileName)
}

async function readEntryToBuffer(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maximumBytes: number,
): Promise<Buffer> {
  const input = await openEntryStream(zip, entry)
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > maximumBytes) {
      input.destroy()
      throw new BackupError('BACKUP_TOO_LARGE', `${entry.fileName} exceeds streamed size limit`)
    }
    chunks.push(chunk)
  }
  if (total !== entry.uncompressedSize) {
    throw new BackupError('BACKUP_ZIP_INVALID', `${entry.fileName} size does not match ZIP metadata`)
  }
  return Buffer.concat(chunks, total)
}

async function extractDatabaseEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  destinationPath: string,
  maximumBytes: number,
): Promise<{ sha256: string; size: number }> {
  const input = await openEntryStream(zip, entry)
  const hash = createHash('sha256')
  let size = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength
      if (size > maximumBytes) {
        callback(new BackupError('BACKUP_TOO_LARGE', 'data.sqlite exceeds streamed size limit'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const output = createWriteStream(destinationPath, {
    flags: 'wx',
    mode: 0o600,
  })
  try {
    await pipeline(input, limiter, output)
    if (size !== entry.uncompressedSize) {
      throw new BackupError('BACKUP_ZIP_INVALID', 'data.sqlite size does not match ZIP metadata')
    }
    // Windows FlushFileBuffers requires a write-capable handle.
    const handle = await open(destinationPath, constants.O_RDWR)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { sha256: hash.digest('hex'), size }
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, { decompress: true }, (error, stream) => {
      if (error !== null) reject(new BackupError('BACKUP_ZIP_INVALID', 'Cannot read ZIP entry', { cause: error }))
      else if (stream === undefined) reject(new BackupError('BACKUP_ZIP_INVALID', 'ZIP entry stream is missing'))
      else resolvePromise(stream)
    })
  })
}
