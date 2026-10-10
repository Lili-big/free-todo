import { createHash } from 'node:crypto'
import type {
  ExternalCalendarRangeDto,
  ExternalCalendarStatusDto,
  ExternalCalendarSyncResultDto,
  ExternalEventDto
} from '@shared/types'
import type { ConnectWecomCalendarInput, ExternalCalendarRangeInput } from '@shared/inputs'
import { DomainError } from '../../domain/errors'
import {
  CalDavClient,
  normalizeServerUrl,
  type CalDavCalendar,
  type CalDavCalendarObject,
  type WecomCalendarCredentials
} from './caldav-client'
import { WecomCalendarIntegrationError, type WecomCalendarFailureCode } from './errors'
import { parseIcsEvents } from './ics-parser'
import {
  EncryptedCredentialStore,
  ExternalEventCacheStore,
  SyncMetadataStore,
  externalEventOverlapsRange,
  type CacheSummary,
  type SyncMetadata
} from './storage'

interface CalendarGateway {
  discover(credentials: WecomCalendarCredentials): Promise<CalDavCalendar[]>
  query(
    calendar: CalDavCalendar,
    credentials: WecomCalendarCredentials,
    startOn: string,
    endOn: string
  ): Promise<CalDavCalendarObject[]>
}

interface CredentialRepository {
  assertAvailable?(): void
  load(): Promise<WecomCalendarCredentials | null>
  save(credentials: WecomCalendarCredentials): Promise<void>
  clear(): Promise<void>
}

interface CacheRepository {
  replaceRange(connectionId: string, startOn: string, endOn: string, incoming: ExternalEventDto[], updatedAtUtc: string): Promise<void>
  getRange(connectionId: string, startOn: string, endOn: string): Promise<ExternalEventDto[]>
  summary(connectionId: string): Promise<CacheSummary>
  clear(): Promise<void>
}

interface MetadataRepository {
  load(): Promise<SyncMetadata>
  save(metadata: SyncMetadata): Promise<void>
  clear(): Promise<void>
}

export interface WecomCalendarServiceDependencies {
  credentials: CredentialRepository
  cache: CacheRepository
  metadata: MetadataRepository
  client?: CalendarGateway
  now?: () => Date
}

function connectionId(credentials: WecomCalendarCredentials): string {
  return createHash('sha256')
    .update(`${credentials.server}\u0000${credentials.account ?? ''}\u0000${credentials.username}`, 'utf8')
    .digest('hex')
}

function accountHint(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length)
  if (value.length <= 6) return `${value[0]}${'*'.repeat(value.length - 2)}${value[value.length - 1]}`
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

function serverHost(server: string): string | null {
  try {
    return new URL(server).host
  } catch {
    return null
  }
}

function stableEventId(
  sourceId: string,
  calendarUrl: string,
  uid: string,
  recurrenceId: string | null,
  start: string
): string {
  return createHash('sha256')
    .update(`${sourceId}\u0000${calendarUrl}\u0000${uid}\u0000${recurrenceId ?? ''}\u0000${start}`, 'utf8')
    .digest('hex')
}

function domainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof WecomCalendarIntegrationError) {
    if (error.failureCode === 'AUTH_FAILED') {
      return new DomainError('EXTERNAL_CALENDAR_AUTH_FAILED', error.message, undefined, false)
    }
    if (error.failureCode === 'STORAGE') {
      return new DomainError('CREDENTIAL_STORAGE_UNAVAILABLE', '无法安全存取企业微信日历连接信息。')
    }
    return new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', error.message, undefined, error.retryable)
  }
  return new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '企业微信日历同步未完成，已保留上次缓存。', undefined, true)
}

function failureCode(error: unknown): WecomCalendarFailureCode {
  return error instanceof WecomCalendarIntegrationError ? error.failureCode : 'NETWORK'
}

function normalizeCredentials(input: ConnectWecomCalendarInput): WecomCalendarCredentials {
  const account = input.account?.trim() || null
  const username = input.username?.trim() || account
  if (!username) throw new DomainError('VALIDATION_FAILED', '账号或用户名至少填写一项。')
  return {
    server: normalizeServerUrl(input.server),
    account,
    username,
    password: input.password
  }
}

export class WecomCalendarService {
  private readonly credentials: CredentialRepository
  private readonly cache: CacheRepository
  private readonly metadata: MetadataRepository
  private readonly client: CalendarGateway
  private readonly now: () => Date
  private syncing = false
  private activeSync: Promise<ExternalCalendarSyncResultDto> | null = null
  private changingConnection = false
  private connectionGeneration = 0

  constructor(dependencies: WecomCalendarServiceDependencies) {
    this.credentials = dependencies.credentials
    this.cache = dependencies.cache
    this.metadata = dependencies.metadata
    this.client = dependencies.client ?? new CalDavClient()
    this.now = dependencies.now ?? (() => new Date())
  }

  static fromStores(
    credentials: EncryptedCredentialStore,
    cache: ExternalEventCacheStore,
    metadata: SyncMetadataStore,
    client?: CalendarGateway
  ): WecomCalendarService {
    return new WecomCalendarService({ credentials, cache, metadata, client })
  }

  async connect(input: ConnectWecomCalendarInput): Promise<ExternalCalendarStatusDto> {
    const nextCredentials = normalizeCredentials(input)
    if (this.changingConnection) {
      throw new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '企业微信日历连接正在更新，请稍后再试。', undefined, true)
    }
    this.changingConnection = true
    this.connectionGeneration += 1
    try {
      await this.activeSync?.catch(() => undefined)
      this.credentials.assertAvailable?.()
      await this.client.discover(nextCredentials)
      const previousCredentials = await this.credentials.load().catch(() => null)
      const changedAccount = !previousCredentials || connectionId(previousCredentials) !== connectionId(nextCredentials)
      await this.credentials.save(nextCredentials)
      if (changedAccount) {
        await this.cache.clear()
        await this.metadata.clear()
      } else {
        const current = await this.metadata.load()
        await this.metadata.save({ ...current, lastErrorCode: null })
      }
      return await this.getStatus()
    } catch (error) {
      throw domainError(error)
    } finally {
      this.changingConnection = false
    }
  }

  async disconnect(): Promise<ExternalCalendarStatusDto> {
    if (this.changingConnection) {
      throw new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '企业微信日历连接正在更新，请稍后再试。', undefined, true)
    }
    this.changingConnection = true
    this.connectionGeneration += 1
    try {
      await this.activeSync?.catch(() => undefined)
      // Remove the encrypted secret first; a partial cleanup can never leave a
      // usable credential behind after the user disconnects.
      await this.credentials.clear()
      await this.cache.clear()
      await this.metadata.clear()
      return await this.getStatus()
    } catch (error) {
      throw domainError(error)
    } finally {
      this.changingConnection = false
    }
  }

  async sync(input: ExternalCalendarRangeInput): Promise<ExternalCalendarSyncResultDto> {
    if (this.activeSync || this.changingConnection) {
      throw new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '企业微信日历正在同步，请稍后再试。', undefined, true)
    }
    const generation = this.connectionGeneration
    const operation = this.performSync(input, generation)
    this.activeSync = operation
    try {
      return await operation
    } finally {
      if (this.activeSync === operation) this.activeSync = null
    }
  }

  private async performSync(
    input: ExternalCalendarRangeInput,
    generation: number
  ): Promise<ExternalCalendarSyncResultDto> {
    const credentials = await this.loadConnectedCredentials()
    const sourceId = connectionId(credentials)
    const attemptedAtUtc = this.now().toISOString()
    const previousMetadata = await this.metadata.load().catch(() => ({
      lastAttemptAtUtc: null,
      lastSuccessAtUtc: null,
      lastErrorCode: null
    }))
    this.syncing = true
    try {
      await this.metadata.save({ ...previousMetadata, lastAttemptAtUtc: attemptedAtUtc })
      const calendars = await this.client.discover(credentials)
      const resultSets = await Promise.all(calendars.map(async (calendar) => ({
        calendar,
        objects: await this.client.query(calendar, credentials, input.startOn, input.endOn)
      })))

      const byId = new Map<string, ExternalEventDto>()
      for (const result of resultSets) {
        for (const object of result.objects) {
          for (const parsed of parseIcsEvents(object.calendarData, input)) {
            if (parsed.cancelled) continue
            const event: ExternalEventDto = {
              kind: 'EXTERNAL_EVENT',
              id: stableEventId(sourceId, result.calendar.url, parsed.uid, parsed.recurrenceId, parsed.start),
              source: 'WECOM_CALDAV',
              title: parsed.title || '未命名日程',
              start: parsed.start,
              end: parsed.end,
              allDay: parsed.allDay,
              location: parsed.location,
              timeZone: parsed.timeZone
            }
            // A server may return the whole resource despite the REPORT
            // filter. Keep the local cache scoped to the requested range.
            if (externalEventOverlapsRange(event, input.startOn, input.endOn)) {
              byId.set(event.id, event)
            }
          }
        }
      }
      const events = [...byId.values()]
      const succeededAtUtc = this.now().toISOString()
      if (generation !== this.connectionGeneration) {
        throw new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '连接状态已变化，本次同步结果未保存。', undefined, true)
      }
      await this.cache.replaceRange(sourceId, input.startOn, input.endOn, events, succeededAtUtc)
      if (generation !== this.connectionGeneration) {
        throw new DomainError('EXTERNAL_CALENDAR_SYNC_FAILED', '连接状态已变化，本次同步结果未保存。', undefined, true)
      }
      await this.metadata.save({
        lastAttemptAtUtc: attemptedAtUtc,
        lastSuccessAtUtc: succeededAtUtc,
        lastErrorCode: null
      })
      this.syncing = false
      return { status: await this.getStatus(), receivedEventCount: events.length }
    } catch (error) {
      if (generation === this.connectionGeneration) {
        await this.metadata.save({
          ...previousMetadata,
          lastAttemptAtUtc: attemptedAtUtc,
          lastErrorCode: failureCode(error)
        }).catch(() => undefined)
      }
      throw domainError(error)
    } finally {
      this.syncing = false
    }
  }

  async getStatus(): Promise<ExternalCalendarStatusDto> {
    let credentials: WecomCalendarCredentials | null
    try {
      credentials = await this.credentials.load()
    } catch (error) {
      throw domainError(error)
    }
    if (!credentials) {
      return {
        source: 'WECOM_CALDAV',
        connected: false,
        syncing: this.syncing,
        serverHost: null,
        accountHint: null,
        lastAttemptAtUtc: null,
        lastSuccessAtUtc: null,
        lastErrorCode: null,
        cachedEventCount: 0,
        cachedRangeStartOn: null,
        cachedRangeEndOn: null
      }
    }
    try {
      const [metadata, summary] = await Promise.all([
        this.metadata.load(),
        this.cache.summary(connectionId(credentials))
      ])
      return {
        source: 'WECOM_CALDAV',
        connected: true,
        syncing: this.syncing,
        serverHost: serverHost(credentials.server),
        accountHint: accountHint(credentials.account ?? credentials.username),
        lastAttemptAtUtc: metadata.lastAttemptAtUtc,
        lastSuccessAtUtc: metadata.lastSuccessAtUtc,
        lastErrorCode: metadata.lastErrorCode,
        cachedEventCount: summary.eventCount,
        cachedRangeStartOn: summary.rangeStartOn,
        cachedRangeEndOn: summary.rangeEndOn
      }
    } catch (error) {
      throw domainError(error)
    }
  }

  async getRange(input: ExternalCalendarRangeInput): Promise<ExternalCalendarRangeDto> {
    const credentials = await this.loadConnectedCredentials()
    try {
      return {
        startOn: input.startOn,
        endOn: input.endOn,
        items: await this.cache.getRange(connectionId(credentials), input.startOn, input.endOn)
      }
    } catch (error) {
      throw domainError(error)
    }
  }

  private async loadConnectedCredentials(): Promise<WecomCalendarCredentials> {
    let credentials: WecomCalendarCredentials | null
    try {
      credentials = await this.credentials.load()
    } catch (error) {
      throw domainError(error)
    }
    if (!credentials) {
      throw new DomainError('EXTERNAL_CALENDAR_NOT_CONNECTED', '尚未连接企业微信日历。')
    }
    return credentials
  }
}
