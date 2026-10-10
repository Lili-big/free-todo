// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { WecomCalendarSync } from '../../../src/renderer/src/components/WecomCalendarSync'

const connectedStatus = {
  source: 'WECOM_CALDAV' as const, connected: true, syncing: false,
  serverHost: 'caldav.wecom.work', accountHint: 'zh***',
  lastAttemptAtUtc: null, lastSuccessAtUtc: null, lastErrorCode: null,
  cachedEventCount: 0, cachedRangeStartOn: null, cachedRangeEndOn: null
}

describe('WecomCalendarSync', () => {
  it('启动时同步只读日程，聚焦后可再同步且网络失败保持静默', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const getStatus = vi.fn(async () => ({ ok: true as const, data: connectedStatus }))
    const sync = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { status: { ...connectedStatus, cachedEventCount: 2 }, receivedEventCount: 2 } })
      .mockRejectedValueOnce(new Error('offline'))
    window.todoApi = {
      wecomCalendar: { getStatus, sync, connect: vi.fn(), disconnect: vi.fn(), getRange: vi.fn() }
    } as unknown as TodoDesktopApi
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

    const view = render(<WecomCalendarSync today="2026-09-03" />, { wrapper })
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ startOn: '2026-07-30', endOn: '2027-09-08' }))
    expect(queryClient.getQueryData(['wecom-calendar', 'status'])).toMatchObject({ connected: true, cachedEventCount: 2 })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['wecom-calendar', 'range'] })

    now += 60_001
    fireEvent.focus(window)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['wecom-calendar', 'status'] })
    view.unmount()
  })
})
