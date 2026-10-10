import { randomUUID } from 'node:crypto'
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'

import { BackupError } from './errors'
import type { DiskSpacePort } from './types'

export function assertAbsolutePath(filePath: string, label = 'path'): void {
  if (!isAbsolute(filePath) || filePath.includes('\0')) {
    throw new BackupError('BACKUP_DESTINATION_INVALID', `${label} must be an absolute safe path`)
  }
}

export function assertPathWithin(rootPath: string, candidatePath: string, label = 'path'): void {
  assertAbsolutePath(rootPath, 'root')
  assertAbsolutePath(candidatePath, label)
  const root = resolve(rootPath)
  const candidate = resolve(candidatePath)
  const relation = relative(root, candidate)
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new BackupError('BACKUP_DESTINATION_INVALID', `${label} escapes its private root`)
  }
}

export function assertSameVolume(leftPath: string, rightPath: string): void {
  assertAbsolutePath(leftPath, 'source')
  assertAbsolutePath(rightPath, 'destination')
  const leftRoot = parse(resolve(leftPath)).root.toLocaleLowerCase('en-US')
  const rightRoot = parse(resolve(rightPath)).root.toLocaleLowerCase('en-US')
  if (leftRoot !== rightRoot) {
    throw new BackupError('ATOMIC_SWITCH_FAILED', 'Atomic file switch requires the same volume')
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

export async function assertRegularFile(filePath: string, label = 'file'): Promise<void> {
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new BackupError('BACKUP_DESTINATION_INVALID', `${label} must be a regular file`)
  }
}

export async function createPrivateDirectory(rootPath: string, prefix: string): Promise<string> {
  assertAbsolutePath(rootPath, 'private root')
  await mkdir(rootPath, { recursive: true, mode: 0o700 })
  const child = resolve(rootPath, `${prefix}-${randomUUID()}`)
  assertPathWithin(rootPath, child, 'private directory')
  await mkdir(child, { recursive: false, mode: 0o700 })
  return child
}

export async function writeDurableFileExclusive(
  destinationPath: string,
  data: string | Uint8Array,
): Promise<void> {
  assertAbsolutePath(destinationPath, 'durable file')
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
  const partialPath = `${destinationPath}.${randomUUID()}.partial`
  const handle = await open(partialPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    if (await pathExists(destinationPath)) {
      throw new BackupError('BACKUP_DESTINATION_EXISTS', 'Durable destination already exists')
    }
    await rename(partialPath, destinationPath)
    await syncParentDirectory(destinationPath)
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function syncFile(filePath: string): Promise<void> {
  // Windows FlushFileBuffers requires a handle opened for writing.
  const handle = await open(filePath, constants.O_RDWR)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Directory fsync is unavailable on Windows; file flush still remains mandatory. */
export async function syncParentDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dirname(filePath), constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function removePrivateTree(rootPath: string, targetPath: string): Promise<void> {
  assertPathWithin(rootPath, targetPath, 'temporary tree')
  await rm(targetPath, { recursive: true, force: true })
}

export async function listRealDirectories(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) return []
  const entries = await readdir(rootPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => resolve(rootPath, entry.name))
}

export const NODE_DISK_SPACE: DiskSpacePort = Object.freeze({
  async availableBytes(targetPath: string): Promise<number> {
    const info = await statfs(dirname(targetPath))
    return Number(info.bavail) * Number(info.bsize)
  },
})

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
