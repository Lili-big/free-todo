import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  createImmutablePlan,
  createRestoreMarker,
  makeRestorePlan,
  readImmutablePlan,
  readRestoreMarker,
  RESTORE_JOURNAL_FORMAT_VERSION,
} from '../../../src/main/backup'

describe('restore journal', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'todo-journal-'))
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  it('persists an immutable checksummed plan and bound marker', async () => {
    const restoreRoot = resolve(root, '.restore')
    const safetyRoot = resolve(root, 'safety')
    const operationId = randomUUID()
    const operation = resolve(restoreRoot, operationId)
    await mkdir(operation, { recursive: true })
    await mkdir(safetyRoot, { recursive: true })
    const policy = {
      restoreRootPath: restoreRoot,
      primaryDatabasePath: resolve(root, 'data.sqlite3'),
      safetyBackupRootPath: safetyRoot,
    }
    const plan = makeRestorePlan({
      journalFormatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
      operationId,
      operationType: 'RESTORE',
      primaryDatabasePath: policy.primaryDatabasePath,
      candidateDatabasePath: resolve(operation, 'candidate.sqlite3'),
      oldDatabasePath: resolve(operation, 'old.sqlite3'),
      oldDatabaseSha256: 'a'.repeat(64),
      candidateDatabaseSha256: 'b'.repeat(64),
      oldCanonicalDomainDigest: 'c'.repeat(64),
      candidateCanonicalDomainDigest: 'd'.repeat(64),
      oldSchemaVersion: 1,
      candidateSchemaVersion: 1,
      safetyBackupPath: resolve(safetyRoot, 'safe.todo-backup'),
      createdAtUtc: '2026-09-02T01:02:03.000Z',
    })
    await createImmutablePlan(operation, plan, policy)
    await createRestoreMarker(operation, plan, 'PREPARED')
    expect(await readImmutablePlan(operation, policy)).toEqual(plan)
    expect(await readRestoreMarker(operation, plan, 'PREPARED')).toMatchObject({
      marker: 'PREPARED',
      planChecksum: plan.planChecksum,
    })

    const planPath = resolve(operation, 'plan.json')
    const tampered = (await readFile(planPath, 'utf8')).replace('"oldSchemaVersion":1', '"oldSchemaVersion":2')
    await writeFile(planPath, tampered)
    await expect(readImmutablePlan(operation, policy)).rejects.toThrow('checksum')
  })
})
