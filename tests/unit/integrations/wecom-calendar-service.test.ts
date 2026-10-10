import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EncryptedCredentialStore,
  ExternalEventCacheStore,
  SyncMetadataStore,
  WecomCalendarIntegrationError,
  WecomCalendarService,
  type CalDavCalendar,
  type SafeStorageCipher,
  type WecomCalendarCredentials
} from '@main/integrations/wecom-calendar'

class TestCipher implements SafeStorageCipher {
  isEncryptionAvailable(): boolean { return true }
  encryptString(value: string): Buffer { return Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`) }
  decryptString(value: Buffer): string { return Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString() }
}

class UnavailableCipher implements SafeStorageCipher {
  isEncryptionAvailable(): boolean { return false }
  encryptString(): Buffer { throw new Error('must not encrypt') }
  decryptString(): string { throw new Error('must not decrypt') }
}

class FakeCalendarClient {
  shouldFail = false

  async discover(_credentials: WecomCalendarCredentials): Promise<CalDavCalendar[]> {
    return [{ url: 'https://caldav.wecom.work/calendars/me/work/', displayName: '工作' }]
  }

  async query(): Promise<Array<{ href: string; etag: string; calendarData: string }>> {
    if (this.shouldFail) throw new WecomCalendarIntegrationError('NETWORK', 'temporary failure', true)
    return [{
      href: '/calendars/me/work/event.ics',
      etag: 'one',
      calendarData: `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:event-1
DTSTART;TZID=Asia/Shanghai:20260904T090000
DTEND;TZID=Asia/Shanghai:20260904T100000
SUMMARY:同步会议
DESCRIPTION:正文不应进入缓存
LOCATION:会议室 1
END:VEVENT
END:VCALENDAR`
    }]
  }
}

describe('WecomCalendarService', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wecom-calendar-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('encrypts credentials, caches only selected fields and preserves cache after a failed sync', async () => {
    const client = new FakeCalendarClient()
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new TestCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client,
      now: () => new Date('2026-09-04T01:00:00.000Z')
    })

    await service.connect({
      server: 'caldav.wecom.work',
      account: 'person@example.com',
      username: 'wecom-user',
      password: 'one-time-generated-password'
    })
    const sync = await service.sync({ startOn: '2026-09-01', endOn: '2026-09-30' })
    expect(sync.receivedEventCount).toBe(1)
    const rangeBeforeFailure = await service.getRange({ startOn: '2026-09-04', endOn: '2026-09-04' })
    expect(rangeBeforeFailure.items).toEqual([expect.objectContaining({
      kind: 'EXTERNAL_EVENT',
      source: 'WECOM_CALDAV',
      title: '同步会议',
      location: '会议室 1'
    })])

    const encrypted = await readFile(join(directory, 'credentials.dpapi'), 'utf8')
    const cache = await readFile(join(directory, 'events-cache.json'), 'utf8')
    expect(encrypted).not.toContain('one-time-generated-password')
    expect(encrypted).not.toContain('wecom-user')
    expect(cache).not.toContain('正文不应进入缓存')

    client.shouldFail = true
    await expect(service.sync({ startOn: '2026-09-01', endOn: '2026-09-30' })).rejects.toMatchObject({
      code: 'EXTERNAL_CALENDAR_SYNC_FAILED'
    })
    const rangeAfterFailure = await service.getRange({ startOn: '2026-09-04', endOn: '2026-09-04' })
    expect(rangeAfterFailure).toEqual(rangeBeforeFailure)
    expect((await service.getStatus()).lastErrorCode).toBe('NETWORK')
  })

  it('clears credentials and external cache when disconnected', async () => {
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new TestCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client: new FakeCalendarClient()
    })
    await service.connect({ server: 'caldav.wecom.work', username: 'me', password: 'secret' })
    expect((await service.disconnect()).connected).toBe(false)
    await expect(service.getRange({ startOn: '2026-09-01', endOn: '2026-09-30' })).rejects.toMatchObject({
      code: 'EXTERNAL_CALENDAR_NOT_CONNECTED'
    })
  })

  it('fails closed before contacting the server when OS credential encryption is unavailable', async () => {
    const client = new FakeCalendarClient()
    const discover = vi.spyOn(client, 'discover')
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new UnavailableCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client
    })

    expect((await service.getStatus()).connected).toBe(false)
    await expect(service.connect({
      server: 'caldav.wecom.work',
      username: 'me',
      password: 'must-not-be-sent'
    })).rejects.toMatchObject({ code: 'CREDENTIAL_STORAGE_UNAVAILABLE' })
    expect(discover).not.toHaveBeenCalled()
  })

  it('filters a server over-response and uses TZID wall-clock dates for cache range matching', async () => {
    const client = new FakeCalendarClient()
    vi.spyOn(client, 'query').mockResolvedValue([{
      href: '/calendar/events.ics',
      etag: 'two',
      calendarData: `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:in-range-cross-day
DTSTART;TZID=America/New_York:20260904T230000
DTEND;TZID=America/New_York:20260905T010000
SUMMARY:跨日会议
END:VEVENT
BEGIN:VEVENT
UID:outside
DTSTART;TZID=Asia/Shanghai:20270101T090000
DTEND;TZID=Asia/Shanghai:20270101T100000
SUMMARY:服务端越界数据
END:VEVENT
END:VCALENDAR`
    }])
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new TestCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client
    })
    await service.connect({ server: 'caldav.wecom.work', username: 'me', password: 'secret' })

    const result = await service.sync({ startOn: '2026-09-05', endOn: '2026-09-05' })
    expect(result.receivedEventCount).toBe(1)
    expect((await service.getRange({ startOn: '2026-09-05', endOn: '2026-09-05' })).items)
      .toEqual([expect.objectContaining({ title: '跨日会议', timeZone: 'America/New_York' })])
    expect(await readFile(join(directory, 'events-cache.json'), 'utf8')).not.toContain('服务端越界数据')
  })

  it('waits out an in-flight sync and removes cache plus atomic remnants when disconnected', async () => {
    let releaseQuery: ((value: Array<{ href: string; etag: string; calendarData: string }>) => void) | undefined
    const client = new FakeCalendarClient()
    vi.spyOn(client, 'query').mockImplementation(() => new Promise((resolve) => { releaseQuery = resolve }))
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new TestCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client
    })
    await service.connect({ server: 'caldav.wecom.work', username: 'me', password: 'secret' })
    await Promise.all([
      writeFile(join(directory, 'credentials.dpapi.crash.tmp'), 'encrypted-remnant'),
      writeFile(join(directory, 'events-cache.json.crash.previous'), 'cached-remnant'),
      writeFile(join(directory, 'sync-status.json.crash.tmp'), 'metadata-remnant')
    ])

    const syncing = service.sync({ startOn: '2026-09-01', endOn: '2026-09-30' })
    await vi.waitFor(() => expect(releaseQuery).toBeTypeOf('function'))
    const disconnecting = service.disconnect()
    releaseQuery?.([{
      href: '/late.ics',
      etag: 'late',
      calendarData: `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:late
DTSTART:20260904T010000Z
DTEND:20260904T020000Z
SUMMARY:不应回写
END:VEVENT
END:VCALENDAR`
    }])

    await expect(syncing).rejects.toMatchObject({ code: 'EXTERNAL_CALENDAR_SYNC_FAILED' })
    expect((await disconnecting).connected).toBe(false)
    for (const name of [
      'credentials.dpapi', 'credentials.dpapi.crash.tmp',
      'events-cache.json', 'events-cache.json.crash.previous',
      'sync-status.json', 'sync-status.json.crash.tmp'
    ]) {
      await expect(readFile(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('does not report a continuous cache range after replacing it with a disjoint sync', async () => {
    const cache = new ExternalEventCacheStore(directory)
    const event = (id: string, start: string, end: string) => ({
      kind: 'EXTERNAL_EVENT' as const,
      id,
      source: 'WECOM_CALDAV' as const,
      title: id,
      start,
      end,
      allDay: true,
      location: null,
      timeZone: null
    })
    await cache.replaceRange('connection', '2026-01-01', '2026-01-31', [
      event('january', '2026-01-04', '2026-01-05')
    ], '2026-01-01T00:00:00.000Z')
    await cache.replaceRange('connection', '2026-03-01', '2026-03-31', [
      event('march', '2026-03-04', '2026-03-05')
    ], '2026-03-01T00:00:00.000Z')

    expect(await cache.summary('connection')).toEqual({
      eventCount: 1,
      rangeStartOn: '2026-03-01',
      rangeEndOn: '2026-03-31'
    })
    expect(await cache.getRange('connection', '2026-01-01', '2026-01-31')).toEqual([])
  })

  it('clears the previous tenant cache when account changes even if username is reused', async () => {
    const service = new WecomCalendarService({
      credentials: new EncryptedCredentialStore(directory, new TestCipher()),
      cache: new ExternalEventCacheStore(directory),
      metadata: new SyncMetadataStore(directory),
      client: new FakeCalendarClient()
    })
    await service.connect({
      server: 'caldav.wecom.work', account: 'tenant-one', username: 'shared-user', password: 'one'
    })
    await service.sync({ startOn: '2026-09-01', endOn: '2026-09-30' })
    expect((await service.getStatus()).cachedEventCount).toBe(1)

    await service.connect({
      server: 'caldav.wecom.work', account: 'tenant-two', username: 'shared-user', password: 'two'
    })
    expect((await service.getStatus()).cachedEventCount).toBe(0)
  })
})
