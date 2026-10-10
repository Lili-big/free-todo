import {
  CalDavClient,
  FetchCalDavTransport,
  type CalDavRequest,
  type CalDavResponse,
  type CalDavTransport,
  type WecomCalendarCredentials
} from '@main/integrations/wecom-calendar/caldav-client'

class QueueTransport implements CalDavTransport {
  readonly requests: CalDavRequest[] = []

  constructor(private readonly responses: CalDavResponse[]) {}

  async send(request: CalDavRequest): Promise<CalDavResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (!response) throw new Error('unexpected request')
    return response
  }
}

const credentials: WecomCalendarCredentials = {
  server: 'caldav.wecom.work',
  account: 'person@example.com',
  username: 'wecom-user',
  password: 'generated-password'
}

describe('CalDavClient', () => {
  it('discovers the principal, calendar home and VEVENT collections using read-only methods', async () => {
    const transport = new QueueTransport([
      { status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/</d:href><d:propstat><d:prop>
          <d:current-user-principal><d:href>/principals/u/1/</d:href></d:current-user-principal>
        </d:prop></d:propstat></d:response></d:multistatus>` },
      { status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/principals/u/1/</d:href><d:propstat><d:prop>
          <c:calendar-home-set><d:href>/calendars/u/1/</d:href></c:calendar-home-set>
        </d:prop></d:propstat></d:response></d:multistatus>` },
      { status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/calendars/u/1/</d:href><d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/calendars/u/1/work/</d:href><d:propstat><d:prop>
          <d:displayname>企业微信日程</d:displayname>
          <d:resourcetype><d:collection /><c:calendar /></d:resourcetype>
          <c:supported-calendar-component-set><c:comp name="VEVENT" /></c:supported-calendar-component-set>
        </d:prop></d:propstat></d:response>
      </d:multistatus>` }
    ])
    const calendars = await new CalDavClient(transport).discover(credentials)

    expect(calendars).toEqual([{
      url: 'https://caldav.wecom.work/calendars/u/1/work/',
      displayName: '企业微信日程'
    }])
    expect(transport.requests.map((request) => request.method)).toEqual(['PROPFIND', 'PROPFIND', 'PROPFIND'])
    expect(transport.requests.map((request) => request.headers.Depth)).toEqual(['0', '0', '1'])
    expect(transport.requests[0]?.url).toBe('https://caldav.wecom.work/.well-known/caldav')
    expect(transport.requests[0]?.headers.Authorization).toMatch(/^Basic /)
    expect(transport.requests[0]?.headers.Authorization).not.toContain(credentials.password)
  })

  it('queries calendar data with REPORT and decodes XML-escaped ICS', async () => {
    const transport = new QueueTransport([{
      status: 207,
      body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/event.ics</d:href><d:propstat><d:prop>
          <d:getetag>&quot;etag-1&quot;</d:getetag>
          <c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a&amp;b\r\nDTSTART:20260904T010000Z\r\nSUMMARY:R&amp;D\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data>
        </d:prop></d:propstat></d:response>
      </d:multistatus>`
    }])
    const objects = await new CalDavClient(transport).query(
      { url: 'https://caldav.wecom.work/calendars/u/1/work/', displayName: null },
      credentials,
      '2026-09-01',
      '2026-09-30'
    )

    expect(objects[0]).toEqual(expect.objectContaining({
      href: '/event.ics',
      etag: '"etag-1"',
      calendarData: expect.stringContaining('UID:a&b')
    }))
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]?.method).toBe('REPORT')
    expect(transport.requests[0]?.body).toContain('<c:time-range')
    expect(transport.requests[0]?.body).toContain('<c:calendar-data />')
    expect(transport.requests[0]?.body).not.toContain('<c:expand')
  })

  it('fetches known event resources when calendar-data is unavailable in the query response', async () => {
    const transport = new QueueTransport([
      { status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/calendars/u/1/work/event.ics</d:href>
          <d:propstat><d:prop><d:getetag>&quot;etag-2&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
          <d:propstat><d:prop><c:calendar-data /></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
        </d:response>
      </d:multistatus>` },
      { status: 200, body: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fallback\r\nDTSTART:20260904T010000Z\r\nSUMMARY:Fallback\r\nEND:VEVENT\r\nEND:VCALENDAR` }
    ])

    const objects = await new CalDavClient(transport).query(
      { url: 'https://caldav.wecom.work/calendars/u/1/work/', displayName: null },
      credentials,
      '2026-09-01',
      '2026-09-30'
    )

    expect(objects).toEqual([expect.objectContaining({
      href: '/calendars/u/1/work/event.ics',
      etag: '"etag-2"',
      calendarData: expect.stringContaining('UID:fallback')
    })])
    expect(transport.requests.map((request) => request.method)).toEqual(['REPORT', 'GET'])
    expect(transport.requests[1]?.url).toBe('https://caldav.wecom.work/calendars/u/1/work/event.ics')
    expect(transport.requests[1]?.headers).not.toHaveProperty('Depth')
  })

  it('skips an event deleted between the query and its fallback GET', async () => {
    const transport = new QueueTransport([
      { status: 207, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response><d:href>/calendar/deleted.ics</d:href><d:propstat><d:prop>
          <d:getetag>&quot;gone&quot;</d:getetag><c:calendar-data />
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      </d:multistatus>` },
      { status: 404, body: '' }
    ])

    await expect(new CalDavClient(transport).query(
      { url: 'https://caldav.wecom.work/calendar/', displayName: null },
      credentials,
      '2026-09-01',
      '2026-09-30'
    )).resolves.toEqual([])
  })

  it('classifies authentication failures without exposing the response body', async () => {
    const transport = new QueueTransport([{ status: 401, body: 'remote secret diagnostic' }])
    await expect(new CalDavClient(transport).discover(credentials)).rejects.toMatchObject({
      failureCode: 'AUTH_FAILED'
    })
  })

  it('keeps authorization on HTTPS same-origin redirects and rejects cross-origin redirects before following them', async () => {
    const sameOriginFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: '/canonical/' }
      }))
      .mockResolvedValueOnce(new Response('<d:multistatus xmlns:d="DAV:" />', { status: 207 }))
    const request: CalDavRequest = {
      method: 'PROPFIND',
      url: 'https://caldav.wecom.work/',
      headers: { Authorization: 'Basic protected-value' },
      body: '<propfind />'
    }

    await new FetchCalDavTransport(sameOriginFetch as typeof fetch).send(request)
    expect(sameOriginFetch).toHaveBeenCalledTimes(2)
    expect(sameOriginFetch.mock.calls[1]?.[0].toString()).toBe('https://caldav.wecom.work/canonical/')
    expect(sameOriginFetch.mock.calls[1]?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Basic protected-value'
    }))

    const crossOriginFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: 'https://calendar.attacker.example/collect' }
    }))
    await expect(new FetchCalDavTransport(crossOriginFetch as typeof fetch).send(request)).rejects.toMatchObject({
      failureCode: 'PROTOCOL'
    })
    expect(crossOriginFetch).toHaveBeenCalledTimes(1)
  })

  it('enforces response limits while streaming when Content-Length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      }
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 207 }))

    await expect(new FetchCalDavTransport(fetchImpl as typeof fetch, 1_000, 5).send({
      method: 'REPORT',
      url: 'https://caldav.wecom.work/calendar/',
      headers: { Authorization: 'Basic protected-value' },
      body: '<calendar-query />'
    })).rejects.toMatchObject({ failureCode: 'PROTOCOL' })
  })

  it('keeps the timeout active until the response body has finished', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        }
      })
      return new Response(stream, { status: 207 })
    })

    await expect(new FetchCalDavTransport(fetchImpl as typeof fetch, 5, 1024).send({
      method: 'REPORT',
      url: 'https://caldav.wecom.work/calendar/',
      headers: { Authorization: 'Basic protected-value' },
      body: '<calendar-query />'
    })).rejects.toMatchObject({ failureCode: 'NETWORK', retryable: true })
  })
})
