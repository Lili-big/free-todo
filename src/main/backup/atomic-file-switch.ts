import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { sha256File } from './crypto'
import { BackupError } from './errors'
import {
  assertAbsolutePath,
  assertPathWithin,
  assertRegularFile,
  assertSameVolume,
  isNodeError,
  pathExists,
  syncParentDirectory,
} from './safe-fs'

export interface AtomicMoveRequest {
  readonly sourcePath: string
  readonly destinationPath: string
  readonly expectedSourceSha256: string
}

export interface AtomicFileSwitchPort {
  /** Idempotent when a prior rename completed but its caller only observed an I/O error. */
  moveExpectedFile(request: AtomicMoveRequest): Promise<void>
  quarantineDatabaseFamily(
    databasePath: string,
    quarantineDirectory: string,
    label: string,
  ): Promise<readonly string[]>
  removeDatabaseFamily(databasePath: string): Promise<void>
}

export interface RenamePort {
  rename(sourcePath: string, destinationPath: string): Promise<void>
}

const NODE_RENAME: RenamePort = Object.freeze({ rename })

/**
 * Windows-first rename adapter. The app's single-instance + maintenance lock
 * prevents a competing creator between the destination check and rename.
 * Post-error identity checks determine whether Windows completed the move.
 */
export class WindowsAtomicFileSwitch implements AtomicFileSwitchPort {
  constructor(private readonly renamePort: RenamePort = NODE_RENAME) {}

  async moveExpectedFile(request: AtomicMoveRequest): Promise<void> {
    const { sourcePath, destinationPath, expectedSourceSha256 } = request
    assertAbsolutePath(sourcePath, 'atomic move source')
    assertAbsolutePath(destinationPath, 'atomic move destination')
    assertSameVolume(sourcePath, destinationPath)

    const initial = await this.observeMove(sourcePath, destinationPath, expectedSourceSha256)
    if (initial === 'MOVED') return
    if (initial !== 'NOT_MOVED') {
      throw switchFailure('Atomic move preconditions are not satisfied', initial)
    }

    try {
      await this.renamePort.rename(sourcePath, destinationPath)
      await syncParentDirectory(destinationPath)
    } catch (error) {
      const observed = await this.observeMove(sourcePath, destinationPath, expectedSourceSha256)
      if (observed === 'MOVED') return
      throw new BackupError('ATOMIC_SWITCH_FAILED', 'Atomic rename failed', {
        cause: error,
        details: { observed },
      })
    }

    const observed = await this.observeMove(sourcePath, destinationPath, expectedSourceSha256)
    if (observed !== 'MOVED') {
      throw switchFailure('Atomic rename returned without installing the expected file', observed)
    }
  }

  async quarantineDatabaseFamily(
    databasePath: string,
    quarantineDirectory: string,
    label: string,
  ): Promise<readonly string[]> {
    assertAbsolutePath(databasePath, 'database to quarantine')
    assertAbsolutePath(quarantineDirectory, 'quarantine directory')
    await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 })
    const moved: string[] = []
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`
      if (!(await pathExists(source))) continue
      await assertRegularFile(source, 'database family member')
      const destination = resolve(
        quarantineDirectory,
        `${sanitizeLabel(label)}-${basename(databasePath)}${suffix}`,
      )
      assertPathWithin(quarantineDirectory, destination, 'quarantine destination')
      if (await pathExists(destination)) {
        throw new BackupError('ATOMIC_SWITCH_FAILED', 'Quarantine destination already exists')
      }
      await this.renamePort.rename(source, destination)
      moved.push(destination)
    }
    if (moved.length > 0) await syncParentDirectory(moved[0] as string)
    return moved
  }

  async removeDatabaseFamily(databasePath: string): Promise<void> {
    assertAbsolutePath(databasePath, 'database family')
    for (const suffix of ['', '-wal', '-shm']) {
      const member = `${databasePath}${suffix}`
      if (!(await pathExists(member))) continue
      const info = await lstat(member)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new BackupError('ATOMIC_SWITCH_FAILED', 'Refusing to remove non-file database member')
      }
      await rm(member, { force: false })
    }
  }

  private async observeMove(
    sourcePath: string,
    destinationPath: string,
    expectedHash: string,
  ): Promise<'MOVED' | 'NOT_MOVED' | 'BOTH' | 'SOURCE_WRONG' | 'DESTINATION_WRONG' | 'MISSING'> {
    const sourceHash = await hashIfRegular(sourcePath)
    const destinationHash = await hashIfRegular(destinationPath)
    if (sourceHash === null && destinationHash === expectedHash) return 'MOVED'
    if (sourceHash === expectedHash && destinationHash === null) return 'NOT_MOVED'
    if (sourceHash === expectedHash && destinationHash === expectedHash) return 'BOTH'
    if (sourceHash !== null && sourceHash !== expectedHash) return 'SOURCE_WRONG'
    if (destinationHash !== null && destinationHash !== expectedHash) return 'DESTINATION_WRONG'
    return 'MISSING'
  }
}

async function hashIfRegular(filePath: string): Promise<string | null> {
  try {
    await assertRegularFile(filePath)
    return await sha256File(filePath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

function switchFailure(message: string, observed: string): BackupError {
  return new BackupError('ATOMIC_SWITCH_FAILED', message, { details: { observed } })
}

function sanitizeLabel(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)
  return sanitized.length > 0 ? sanitized : 'quarantined'
}
