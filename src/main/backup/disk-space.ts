import { stat } from 'node:fs/promises'

import { BackupError } from './errors'
import type { BackupLimits, DiskSpacePort } from './types'

export interface RestoreSpaceEstimate {
  readonly currentDatabasePath: string
  readonly sourceArchiveBytes: number
  readonly sourceDatabaseBytes: number
}

/** Current + safety snapshot + candidate + extracted source + configured margin. */
export async function assertSufficientRestoreSpace(
  diskSpace: DiskSpacePort,
  limits: BackupLimits,
  estimate: RestoreSpaceEstimate,
): Promise<number> {
  const currentBytes = (await stat(estimate.currentDatabasePath)).size
  const requiredBytes =
    currentBytes * 2 +
    estimate.sourceDatabaseBytes * 2 +
    estimate.sourceArchiveBytes +
    limits.diskSafetyMarginBytes
  const availableBytes = await diskSpace.availableBytes(estimate.currentDatabasePath)
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new BackupError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for safe restore', {
      details: { availableBytes, requiredBytes },
    })
  }
  return requiredBytes
}
