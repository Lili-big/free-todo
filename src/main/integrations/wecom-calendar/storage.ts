import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ExternalEventDto } from '@shared/types'
import type { WecomCalendarFailureCode } from './errors'
import { WecomCalendarIntegrationError } from './errors'
import type { WecomCalendarCredentials } from './caldav-client'

export interface SafeStorageCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface CacheDocument {
  version: 1
  connectionId: string
  updatedAtUtc: string
  rangeStartOn: string
  rangeEndOn: string
  events: ExternalEventDto[]
}

export interface CacheSummary {
  eventCount: number
  rangeStartOn: string | null
  rangeEndOn: string | null
}

export interface SyncMetadata {
  lastAttemptAtUtc: string | null
  lastSuccessAtUtc: string | null
  lastErrorCode: WecomCalendarFailureCode | null
}

const EMPTY_METADATA: SyncMetadata = {
  lastAttemptAtUtc: null,
  lastSuccessAtUtc: null,
  lastErrorCode: null
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function removeAtomicArtifacts(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  const prefix = `${basename(filePath)}.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && (name.endsWith('.tmp') || name.endsWith('.previous')))
    .map((name) => removeIfPresent(join(directory, name))))
}

async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const token = randomUUID()
  const temporaryPath = `${filePath}.${token}.tmp`
  const previousPath = `${filePath}.${token}.previous`
  let previousMoved = false
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, filePath)
      return
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
    }

    try {
      await rename(filePath, previousPath)
      previousMoved = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    try {
      await rename(temporaryPath, filePath)
    } catch (error) {
      if (previousMoved) await rename(previousPath, filePath).catch(() => undefined)
      throw error
    }
    if (previousMoved) await removeIfPresent(previousPath)
  } finally {
    await removeIfPresent(temporaryPath).catch(() => undefined)
    if (!previousMoved) await removeIfPresent(previousPath).catch(() => undefined)
  }
}

function storageError(): WecomCalendarIntegrationError {
  return new WecomCalendarIntegrationError('STORAGE', '无法安全保存企业微信日历数据。')
}

function isCredentials(value: unknown): value is WecomCalendarCredentials {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WecomCalendarCredentials>
  return typeof candidate.server === 'string' &&
    (candidate.account === null || typeof candidate.account === 'string') &&
    typeof candidate.username === 'string' &&
    typeof candidate.password === 'string'
}

function isExternalEvent(value: unknown): value is ExternalEventDto {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ExternalEventDto>
  return candidate.kind === 'EXTERNAL_EVENT' && candidate.source === 'WECOM_CALDAV' &&
    typeof candidate.id === 'string' && typeof candidate.title === 'string' &&
    typeof candidate.start === 'string' && typeof candidate.end === 'string' &&
    typeof candidate.allDay === 'boolean' &&
    (candidate.location === null || typeof candidate.location === 'string') &&
    (candidate.timeZone === null || typeof candidate.timeZone === 'string')
}

function isCacheDocument(value: unknown): value is CacheDocument {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CacheDocument>
  return candidate.version === 1 && typeof candidate.connectionId === 'string' &&
    typeof candidate.updatedAtUtc === 'string' && typeof candidate.rangeStartOn === 'string' &&
    typeof candidate.rangeEndOn === 'string' && Array.isArray(candidate.events) &&
    candidate.events.every(isExternalEvent)
}

function isMetadata(value: unknown): value is SyncMetadata {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SyncMetadata>
  const timestamp = (entry: unknown): boolean => entry === null || typeof entry === 'string'
  return timestamp(candidate.lastAttemptAtUtc) && timestamp(candidate.lastSuccessAtUtc) &&
    (candidate.lastErrorCode === null || ['AUTH_FAILED', 'NETWORK', 'PROTOCOL', 'STORAGE'].includes(candidate.lastErrorCode ?? ''))
}

function rangeEndExclusive(endOn: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endOn)
  if (!match) return endOn
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
  return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function rangesTouchOrOverlap(
  leftStartOn: string,
  leftEndOn: string,
  rightStartOn: string,
  rightEndOn: string
): boolean {
  return leftStartOn <= rangeEndExclusive(rightEndOn) && rightStartOn <= rangeEndExclusive(leftEndOn)
}

function hasAbsoluteTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
}

export function externalEventOverlapsRange(event: ExternalEventDto, startOn: string, endOn: string): boolean {
  const exclusiveEnd = rangeEndExclusive(endOn)
  if (event.allDay) return event.start < exclusiveEnd && event.end > startOn

  if (!hasAbsoluteTimeZone(event.start)) {
    const rangeStart = `${startOn}T00:00:00`
    const rangeEnd = `${exclusiveEnd}T00:00:00`
    const hasDuration = event.end > event.start
    return event.start < rangeEnd && (hasDuration ? event.end > rangeStart : event.start >= rangeStart)
  }

  const rangeStart = new Date(`${startOn}T00:00:00`).getTime()
  const rangeEnd = new Date(`${exclusiveEnd}T00:00:00`).getTime()
  const eventStart = new Date(event.start).getTime()
  const parsedEventEnd = new Date(event.end).getTime()
  if (Number.isFinite(eventStart)) {
    const eventEnd = Number.isFinite(parsedEventEnd) && parsedEventEnd > eventStart ? parsedEventEnd : eventStart + 1
    return eventStart < rangeEnd && eventEnd > rangeStart
  }
  return event.start.slice(0, 10) < exclusiveEnd && event.end.slice(0, 10) >= startOn
}

export class EncryptedCredentialStore {
  private readonly filePath: string

  constructor(rootDirectory: string, private readonly cipher: SafeStorageCipher) {
    this.filePath = join(rootDirectory, 'credentials.dpapi')
  }

  assertAvailable(): void {
    if (!this.cipher.isEncryptionAvailable()) throw storageError()
  }

  async load(): Promise<WecomCalendarCredentials | null> {
    let encrypted: Buffer
    try {
      encrypted = await readFile(this.filePath)
    } catch (error) {
      if (isMissing(error)) return null
      throw storageError()
    }
    this.assertAvailable()
    try {
      const parsed: unknown = JSON.parse(this.cipher.decryptString(encrypted))
      if (!isCredentials(parsed)) throw new Error('invalid credentials document')
      return parsed
    } catch {
      throw storageError()
    }
  }

  async save(credentials: WecomCalendarCredentials): Promise<void> {
    this.assertAvailable()
    try {
      const encrypted = this.cipher.encryptString(JSON.stringify(credentials))
      await atomicWrite(this.filePath, encrypted)
    } catch (error) {
      if (error instanceof WecomCalendarIntegrationError) throw error
      throw storageError()
    }
  }

  async clear(): Promise<void> {
    try {
      await removeIfPresent(this.filePath)
      await removeAtomicArtifacts(this.filePath)
    } catch {
      throw storageError()
    }
  }
}

export class ExternalEventCacheStore {
  private readonly filePath: string

  constructor(rootDirectory: string) {
    this.filePath = join(rootDirectory, 'events-cache.json')
  }

  private async read(): Promise<CacheDocument | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return isCacheDocument(parsed) ? parsed : null
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null
      throw storageError()
    }
  }

  async replaceRange(
    connectionId: string,
    startOn: string,
    endOn: string,
    incoming: ExternalEventDto[],
    updatedAtUtc: string
  ): Promise<void> {
    try {
      const existing = await this.read()
      const canMerge = Boolean(existing?.connectionId === connectionId && rangesTouchOrOverlap(
        existing.rangeStartOn,
        existing.rangeEndOn,
        startOn,
        endOn
      ))
      const retained = canMerge && existing
        ? existing.events.filter((event) => !externalEventOverlapsRange(event, startOn, endOn))
        : []
      const byId = new Map<string, ExternalEventDto>()
      for (const event of retained) byId.set(event.id, event)
      for (const event of incoming) {
        if (externalEventOverlapsRange(event, startOn, endOn)) byId.set(event.id, event)
      }
      const events = [...byId.values()].sort((left, right) => left.start.localeCompare(right.start) || left.title.localeCompare(right.title))
      const document: CacheDocument = {
        version: 1,
        connectionId,
        updatedAtUtc,
        rangeStartOn: canMerge && existing && existing.rangeStartOn < startOn ? existing.rangeStartOn : startOn,
        rangeEndOn: canMerge && existing && existing.rangeEndOn > endOn ? existing.rangeEndOn : endOn,
        events
      }
      await atomicWrite(this.filePath, JSON.stringify(document))
    } catch (error) {
      if (error instanceof WecomCalendarIntegrationError) throw error
      throw storageError()
    }
  }

  async getRange(connectionId: string, startOn: string, endOn: string): Promise<ExternalEventDto[]> {
    const document = await this.read()
    if (!document || document.connectionId !== connectionId) return []
    return document.events.filter((event) => externalEventOverlapsRange(event, startOn, endOn))
  }

  async summary(connectionId: string): Promise<CacheSummary> {
    const document = await this.read()
    if (!document || document.connectionId !== connectionId) {
      return { eventCount: 0, rangeStartOn: null, rangeEndOn: null }
    }
    return {
      eventCount: document.events.length,
      rangeStartOn: document.rangeStartOn,
      rangeEndOn: document.rangeEndOn
    }
  }

  async clear(): Promise<void> {
    try {
      await removeIfPresent(this.filePath)
      await removeAtomicArtifacts(this.filePath)
    } catch {
      throw storageError()
    }
  }
}

export class SyncMetadataStore {
  private readonly filePath: string

  constructor(rootDirectory: string) {
    this.filePath = join(rootDirectory, 'sync-status.json')
  }

  async load(): Promise<SyncMetadata> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return isMetadata(parsed) ? parsed : { ...EMPTY_METADATA }
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return { ...EMPTY_METADATA }
      throw storageError()
    }
  }

  async save(metadata: SyncMetadata): Promise<void> {
    try {
      await atomicWrite(this.filePath, JSON.stringify({ version: 1, ...metadata }))
    } catch (error) {
      if (error instanceof WecomCalendarIntegrationError) throw error
      throw storageError()
    }
  }

  async clear(): Promise<void> {
    try {
      await removeIfPresent(this.filePath)
      await removeAtomicArtifacts(this.filePath)
    } catch {
      throw storageError()
    }
  }
}
