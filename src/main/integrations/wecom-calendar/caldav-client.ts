import { decodeXmlText, elementContents, firstDecodedElement, hasElement, propertyHref } from './xml'
import { WecomCalendarIntegrationError } from './errors'

export interface WecomCalendarCredentials {
  server: string
  account: string | null
  username: string
  password: string
}

export interface CalDavCalendar {
  url: string
  displayName: string | null
}

export interface CalDavCalendarObject {
  href: string
  etag: string | null
  calendarData: string
}

export type CalDavMethod = 'PROPFIND' | 'REPORT' | 'GET'

export interface CalDavRequest {
  method: CalDavMethod
  url: string
  headers: Readonly<Record<string, string>>
  body: string
}

export interface CalDavResponse {
  status: number
  body: string
  authenticationScheme?: string | null
  contentType?: string | null
}

export interface CalDavTransport {
  send(request: CalDavRequest): Promise<CalDavResponse>
}

export class FetchCalDavTransport implements CalDavTransport {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    private readonly maximumResponseBytes = 12 * 1024 * 1024
  ) {}

  async send(request: CalDavRequest): Promise<CalDavResponse> {
    let currentUrl = new URL(request.url)
    const allowedOrigin = currentUrl.origin
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImpl(currentUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' ? undefined : request.body,
          redirect: 'manual',
          signal: controller.signal
        })

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location || redirects === 3) {
            throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器返回了无效跳转。')
          }
          let nextUrl: URL
          try {
            nextUrl = new URL(location, currentUrl)
          } catch {
            throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器返回了无效跳转。')
          }
          if (
            nextUrl.origin !== allowedOrigin || nextUrl.protocol !== 'https:' ||
            Boolean(nextUrl.username) || Boolean(nextUrl.password)
          ) {
            throw new WecomCalendarIntegrationError('PROTOCOL', '为保护账号，已拒绝跨站日历服务器跳转。')
          }
          await response.body?.cancel().catch(() => undefined)
          currentUrl = nextUrl
          continue
        }

        const bytes = await readLimitedResponse(response, this.maximumResponseBytes, controller)
        const authenticationHeader = response.headers.get('www-authenticate')
        return {
          status: response.status,
          body: new TextDecoder().decode(bytes),
          authenticationScheme: authenticationHeader?.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)/)?.[1] ?? null,
          contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? null
        }
      } catch (error) {
        if (error instanceof WecomCalendarIntegrationError) throw error
        throw new WecomCalendarIntegrationError('NETWORK', '无法连接企业微信日历服务器。', true)
      } finally {
        clearTimeout(timeout)
      }
    }
    throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器跳转次数过多。')
  }
}

async function readLimitedResponse(
  response: Response,
  maximumResponseBytes: number,
  controller: AbortController
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    controller.abort()
    throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历返回的数据过大。')
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximumResponseBytes) {
      throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历返回的数据过大。')
    }
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maximumResponseBytes) {
        controller.abort()
        await reader.cancel().catch(() => undefined)
        throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历返回的数据过大。')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const DISCOVERY_PROPERTIES = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:current-user-principal />
    <c:calendar-home-set />
    <d:resourcetype />
  </d:prop>
</d:propfind>`

const HOME_PROPERTIES = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <c:supported-calendar-component-set />
  </d:prop>
</d:propfind>`

export function normalizeServerUrl(server: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(server.trim()) ? server.trim() : `https://${server.trim()}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器地址无效。')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器必须是安全的 HTTPS 地址。')
  }
  url.hash = ''
  return url.toString()
}

function resolveHref(base: string, href: string): string {
  try {
    const resolved = new URL(href, base)
    if (resolved.protocol !== 'https:' || resolved.origin !== new URL(base).origin) {
      throw new Error('cross-origin')
    }
    return resolved.toString()
  } catch {
    throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历返回了无效的资源地址。')
  }
}

function discoveryUrlFor(serverUrl: string): string {
  const url = new URL(serverUrl)
  if (url.pathname === '/' && !url.search) {
    url.pathname = '/.well-known/caldav'
  }
  return url.toString()
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function multistatusResponses(xml: string): string[] {
  const responses = elementContents(xml, 'response')
  return responses.length > 0 ? responses : [xml]
}

function isEventCalendar(responseXml: string): boolean {
  const resourceType = elementContents(responseXml, 'resourcetype')[0] ?? ''
  if (!hasElement(resourceType, 'calendar')) return false
  const supported = elementContents(responseXml, 'supported-calendar-component-set')[0]
  if (supported === undefined) return true
  return /<(?:[A-Za-z_][\w.-]*:)?comp\b[^>]*\bname\s*=\s*["']VEVENT["']/i.test(supported)
}

function localRangeToUtc(startOn: string, endOn: string): { start: string; end: string } {
  const start = new Date(`${startOn}T00:00:00`)
  const end = new Date(`${endOn}T00:00:00`)
  end.setDate(end.getDate() + 1)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new WecomCalendarIntegrationError('PROTOCOL', '同步日期范围无效。')
  }
  const format = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return { start: format(start), end: format(end) }
}

function calendarQueryBody(startOn: string, endOn: string): string {
  const range = localRangeToUtc(startOn, endOn)
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag /><c:calendar-data /></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${range.start}" end="${range.end}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`
}

export class CalDavClient {
  constructor(private readonly transport: CalDavTransport = new FetchCalDavTransport()) {}

  async discover(credentials: WecomCalendarCredentials): Promise<CalDavCalendar[]> {
    const serverUrl = normalizeServerUrl(credentials.server)
    const discoveryUrl = discoveryUrlFor(serverUrl)
    const initialXml = await this.propfind(discoveryUrl, credentials, '0', DISCOVERY_PROPERTIES)
    const initialResponse = multistatusResponses(initialXml)[0] ?? initialXml
    let homeHref = propertyHref(initialResponse, 'calendar-home-set')

    if (!homeHref) {
      const principalHref = propertyHref(initialResponse, 'current-user-principal')
      if (principalHref) {
        const principalUrl = resolveHref(discoveryUrl, principalHref)
        const principalXml = await this.propfind(principalUrl, credentials, '0', DISCOVERY_PROPERTIES)
        const principalResponse = multistatusResponses(principalXml)[0] ?? principalXml
        homeHref = propertyHref(principalResponse, 'calendar-home-set')
      }
    }

    const homeUrl = homeHref ? resolveHref(discoveryUrl, homeHref) : discoveryUrl
    const listingXml = await this.propfind(homeUrl, credentials, '1', HOME_PROPERTIES)
    const calendars: CalDavCalendar[] = []
    for (const responseXml of multistatusResponses(listingXml)) {
      if (!isEventCalendar(responseXml)) continue
      const href = firstDecodedElement(responseXml, 'href')
      if (!href) continue
      calendars.push({
        url: resolveHref(homeUrl, href),
        displayName: firstDecodedElement(responseXml, 'displayname')
      })
    }

    if (calendars.length === 0 && isEventCalendar(initialResponse)) {
      calendars.push({ url: discoveryUrl, displayName: firstDecodedElement(initialResponse, 'displayname') })
    }
    if (calendars.length === 0) {
      throw new WecomCalendarIntegrationError('PROTOCOL', '未找到可读取的企业微信日历。')
    }
    return calendars
  }

  async query(
    calendar: CalDavCalendar,
    credentials: WecomCalendarCredentials,
    startOn: string,
    endOn: string
  ): Promise<CalDavCalendarObject[]> {
    const xml = await this.request(calendar.url, credentials, 'REPORT', calendarQueryBody(startOn, endOn), '1')
    const objects: CalDavCalendarObject[] = []
    const resourcesToFetch: Array<{ href: string; etag: string | null }> = []
    for (const responseXml of multistatusResponses(xml)) {
      const calendarData = elementContents(responseXml, 'calendar-data')[0]
      const href = firstDecodedElement(responseXml, 'href')
      const etag = firstDecodedElement(responseXml, 'getetag')
      if (calendarData !== undefined) {
        objects.push({ href: href ?? '', etag, calendarData: decodeXmlText(calendarData) })
      } else if (href && etag) {
        resourcesToFetch.push({ href, etag })
      }
    }

    // Some CalDAV services (including Enterprise WeChat) return href + etag
    // from calendar-query but report calendar-data as 404. Fetch those known
    // resources individually; GET is read-only and remains same-origin.
    for (let offset = 0; offset < resourcesToFetch.length; offset += 6) {
      const batch = resourcesToFetch.slice(offset, offset + 6)
      const fetched = await Promise.all(batch.map(async (resource) => ({
        href: resource.href,
        etag: resource.etag,
        calendarData: await this.request(
          resolveHref(calendar.url, resource.href),
          credentials,
          'GET',
          '',
          '0'
        )
      })))
      objects.push(...fetched.filter((resource) => resource.calendarData.length > 0))
    }
    return objects
  }

  private propfind(url: string, credentials: WecomCalendarCredentials, depth: '0' | '1', body: string): Promise<string> {
    return this.request(url, credentials, 'PROPFIND', body, depth)
  }

  private async request(
    url: string,
    credentials: WecomCalendarCredentials,
    method: CalDavMethod,
    body: string,
    depth: '0' | '1'
  ): Promise<string> {
    let response: CalDavResponse
    try {
      response = await this.transport.send({
        method,
        url,
        headers: {
          Authorization: basicAuthorization(credentials.username, credentials.password),
          ...(method === 'GET'
            ? { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' }
            : {
                'Content-Type': 'application/xml; charset=utf-8',
                Accept: 'application/xml, text/xml',
                Depth: depth
              })
        },
        body
      })
    } catch (error) {
      if (error instanceof WecomCalendarIntegrationError) throw error
      throw new WecomCalendarIntegrationError('NETWORK', '无法连接企业微信日历服务器。', true)
    }
    if (process.env.PERSONAL_TODO_CALDAV_DEBUG === '1') {
      const embeddedStatuses = [...new Set(
        [...response.body.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})\b/gi)].map((match) => Number(match[1]))
      )]
      const reportShape = method === 'REPORT'
        ? multistatusResponses(response.body).slice(0, 20).map((responseXml) => ({
            propstats: elementContents(responseXml, 'propstat').map((propstatXml) => {
              const propXml = elementContents(propstatXml, 'prop')[0] ?? ''
              return {
                status: Number(/HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(propstatXml)?.[1] ?? 0),
                etag: hasElement(propXml, 'getetag'),
                calendarData: hasElement(propXml, 'calendar-data')
              }
            })
          }))
        : undefined
      console.error('[wecom-caldav]', JSON.stringify({
        method,
        depth,
        status: response.status,
        authenticationScheme: response.authenticationScheme ?? null,
        contentType: response.contentType ?? null,
        embeddedStatuses,
        calendarDataCount: method === 'REPORT' ? elementContents(response.body, 'calendar-data').length : undefined,
        reportResponseCount: method === 'REPORT' ? multistatusResponses(response.body).length : undefined,
        reportShape
      }))
    }
    if (response.status === 401 || response.status === 403) {
      throw new WecomCalendarIntegrationError('AUTH_FAILED', '企业微信日历账号、用户名或密码无效。')
    }
    if (method === 'GET' && response.status === 404) {
      return ''
    }
    if (response.status >= 500) {
      throw new WecomCalendarIntegrationError('NETWORK', '企业微信日历服务暂时不可用。', true)
    }
    if (response.status !== 200 && response.status !== 207) {
      throw new WecomCalendarIntegrationError('PROTOCOL', '企业微信日历服务器未接受只读同步请求。')
    }
    if (method !== 'GET' && /HTTP\/\d(?:\.\d)?\s+(401|403)\b/i.test(response.body)) {
      throw new WecomCalendarIntegrationError('AUTH_FAILED', '企业微信日历账号、用户名或密码无效。')
    }
    if (method !== 'GET' && /HTTP\/\d(?:\.\d)?\s+5\d\d\b/i.test(response.body)) {
      throw new WecomCalendarIntegrationError('NETWORK', '企业微信日历服务暂时不可用。', true)
    }
    return response.body
  }
}
