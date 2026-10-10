import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { isSha256, sha256Bytes, stableJson } from './crypto'
import { BackupError } from './errors'
import {
  assertAbsolutePath,
  assertPathWithin,
  assertRegularFile,
  pathExists,
  writeDurableFileExclusive,
} from './safe-fs'
import {
  RESTORE_JOURNAL_FORMAT_VERSION,
  RESTORE_MARKERS,
  type ClockPort,
  type RestoreMarkerName,
  type RestoreMarkerV1,
  type RestorePlan,
  type RestorePlanPayloadV1,
  SYSTEM_CLOCK,
} from './types'

const PLAN_KEYS = [
  'journalFormatVersion',
  'operationId',
  'operationType',
  'primaryDatabasePath',
  'candidateDatabasePath',
  'oldDatabasePath',
  'oldDatabaseSha256',
  'candidateDatabaseSha256',
  'oldCanonicalDomainDigest',
  'candidateCanonicalDomainDigest',
  'oldSchemaVersion',
  'candidateSchemaVersion',
  'safetyBackupPath',
  'createdAtUtc',
  'planChecksum',
] as const

export interface JournalLocationPolicy {
  readonly restoreRootPath: string
  readonly primaryDatabasePath: string
  readonly safetyBackupRootPath: string
}

export function calculatePlanChecksum(payload: RestorePlanPayloadV1): string {
  return sha256Bytes(stableJson(payload))
}

export function makeRestorePlan(payload: RestorePlanPayloadV1): RestorePlan {
  validatePlanPayload(payload)
  return Object.freeze({ ...payload, planChecksum: calculatePlanChecksum(payload) })
}

export async function createImmutablePlan(
  operationDirectory: string,
  plan: RestorePlan,
  policy: JournalLocationPolicy,
): Promise<string> {
  validateRestorePlan(plan, operationDirectory, policy)
  const planPath = resolve(operationDirectory, 'plan.json')
  assertPathWithin(operationDirectory, planPath, 'restore plan')
  await writeDurableFileExclusive(planPath, `${stableJson(plan)}\n`)
  return planPath
}

export async function readImmutablePlan(
  operationDirectory: string,
  policy: JournalLocationPolicy,
): Promise<RestorePlan> {
  const planPath = resolve(operationDirectory, 'plan.json')
  assertPathWithin(operationDirectory, planPath, 'restore plan')
  await assertRegularFile(planPath, 'restore plan')
  const data = await readFile(planPath)
  if (data.byteLength === 0 || data.byteLength > 64 * 1024) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Restore plan size is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as unknown
  } catch (error) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Restore plan is invalid JSON', { cause: error })
  }
  const plan = parsePlan(parsed)
  validateRestorePlan(plan, operationDirectory, policy)
  return plan
}

export async function createRestoreMarker(
  operationDirectory: string,
  plan: RestorePlan,
  marker: RestoreMarkerName,
  clock: ClockPort = SYSTEM_CLOCK,
): Promise<void> {
  const markerPath = resolve(operationDirectory, marker)
  assertPathWithin(operationDirectory, markerPath, 'restore marker')
  const value: RestoreMarkerV1 = Object.freeze({
    journalFormatVersion: RESTORE_JOURNAL_FORMAT_VERSION,
    operationId: plan.operationId,
    marker,
    planChecksum: plan.planChecksum,
    createdAtUtc: clock.now().toISOString(),
  })
  if (await pathExists(markerPath)) {
    await readRestoreMarker(operationDirectory, plan, marker)
    return
  }
  await writeDurableFileExclusive(markerPath, `${stableJson(value)}\n`)
}

export async function readRestoreMarker(
  operationDirectory: string,
  plan: RestorePlan,
  marker: RestoreMarkerName,
): Promise<RestoreMarkerV1 | null> {
  const markerPath = resolve(operationDirectory, marker)
  assertPathWithin(operationDirectory, markerPath, 'restore marker')
  if (!(await pathExists(markerPath))) return null
  await assertRegularFile(markerPath, 'restore marker')
  const contents = await readFile(markerPath)
  if (contents.byteLength === 0 || contents.byteLength > 4096) {
    throw new BackupError('RESTORE_MARKER_INVALID', `${marker} has an invalid size`)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as unknown
  } catch (error) {
    throw new BackupError('RESTORE_MARKER_INVALID', `${marker} is invalid JSON`, { cause: error })
  }
  if (!isRecord(value)) throw new BackupError('RESTORE_MARKER_INVALID', `${marker} is invalid`)
  const keys = Object.keys(value).sort()
  const expected = ['createdAtUtc', 'journalFormatVersion', 'marker', 'operationId', 'planChecksum'].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new BackupError('RESTORE_MARKER_INVALID', `${marker} has unknown fields`)
  }
  if (
    value.journalFormatVersion !== RESTORE_JOURNAL_FORMAT_VERSION ||
    value.operationId !== plan.operationId ||
    value.marker !== marker ||
    value.planChecksum !== plan.planChecksum ||
    typeof value.createdAtUtc !== 'string' ||
    Number.isNaN(Date.parse(value.createdAtUtc))
  ) {
    throw new BackupError('RESTORE_MARKER_INVALID', `${marker} is not bound to the plan`)
  }
  return value as unknown as RestoreMarkerV1
}

export async function readValidMarkers(
  operationDirectory: string,
  plan: RestorePlan,
): Promise<ReadonlySet<RestoreMarkerName>> {
  const result = new Set<RestoreMarkerName>()
  let missingEarlierMarker = false
  for (const marker of RESTORE_MARKERS) {
    if ((await readRestoreMarker(operationDirectory, plan, marker)) !== null) {
      if (missingEarlierMarker) {
        throw new BackupError('RESTORE_MARKER_INVALID', `${marker} exists without its predecessor`)
      }
      result.add(marker)
    } else {
      missingEarlierMarker = true
    }
  }
  return result
}

export function validateRestorePlan(
  plan: RestorePlan,
  operationDirectory: string,
  policy: JournalLocationPolicy,
): void {
  const { planChecksum, ...payload } = plan
  validatePlanPayload(payload)
  if (!isSha256(planChecksum) || calculatePlanChecksum(payload) !== planChecksum) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Restore plan checksum mismatch')
  }
  assertAbsolutePath(operationDirectory, 'operation directory')
  assertPathWithin(policy.restoreRootPath, operationDirectory, 'operation directory')
  if (basename(operationDirectory) !== plan.operationId) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Operation directory does not match operationId')
  }
  if (resolve(plan.primaryDatabasePath) !== resolve(policy.primaryDatabasePath)) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Plan primary database path is not configured path')
  }
  if (resolve(plan.candidateDatabasePath) !== resolve(operationDirectory, 'candidate.sqlite3')) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Plan candidate path is invalid')
  }
  if (resolve(plan.oldDatabasePath) !== resolve(operationDirectory, 'old.sqlite3')) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Plan old database path is invalid')
  }
  assertPathWithin(policy.safetyBackupRootPath, plan.safetyBackupPath, 'safety backup')
}

function parsePlan(value: unknown): RestorePlan {
  if (!isRecord(value)) throw new BackupError('RESTORE_PLAN_INVALID', 'Restore plan must be an object')
  const keys = Object.keys(value).sort()
  const expected = [...PLAN_KEYS].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new BackupError('RESTORE_PLAN_INVALID', 'Restore plan has missing or unknown fields')
  }
  return value as unknown as RestorePlan
}

function validatePlanPayload(payload: RestorePlanPayloadV1): void {
  if (payload.journalFormatVersion !== RESTORE_JOURNAL_FORMAT_VERSION) invalid('journal version')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.operationId)) {
    invalid('operationId')
  }
  if (payload.operationType !== 'RESTORE' && payload.operationType !== 'MIGRATION') invalid('operationType')
  for (const path of [
    payload.primaryDatabasePath,
    payload.candidateDatabasePath,
    payload.oldDatabasePath,
    payload.safetyBackupPath,
  ]) {
    if (typeof path !== 'string') invalid('path')
    assertAbsolutePath(path, 'restore plan path')
  }
  for (const digest of [
    payload.oldDatabaseSha256,
    payload.candidateDatabaseSha256,
    payload.oldCanonicalDomainDigest,
    payload.candidateCanonicalDomainDigest,
  ]) {
    if (!isSha256(digest)) invalid('digest')
  }
  if (!Number.isSafeInteger(payload.oldSchemaVersion) || payload.oldSchemaVersion < 1) invalid('old schema')
  if (!Number.isSafeInteger(payload.candidateSchemaVersion) || payload.candidateSchemaVersion < 1) {
    invalid('candidate schema')
  }
  if (typeof payload.createdAtUtc !== 'string' || Number.isNaN(Date.parse(payload.createdAtUtc))) {
    invalid('createdAtUtc')
  }
}

function invalid(field: string): never {
  throw new BackupError('RESTORE_PLAN_INVALID', `Invalid restore plan ${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
