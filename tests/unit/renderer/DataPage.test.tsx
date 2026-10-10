// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TodoDesktopApi } from '../../../src/shared/api'
import { FeedbackProvider } from '../../../src/renderer/src/components/Feedback'
import { DataPage } from '../../../src/renderer/src/pages/DataPage'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}><FeedbackProvider>{children}</FeedbackProvider></QueryClientProvider>
}

describe('DataPage', () => {
  it('校验后要求明确输入，并把两个独立令牌原样用于覆盖恢复', async () => {
    const restore = vi.fn(async () => ({ ok: true as const, data: {
      operationId: 'op-1',
      safetyBackup: { id: 'safe', displayName: '安全备份', createdAtUtc: '2026-09-02T01:00:00.000Z', sizeBytes: 100, schemaVersion: 1 },
      restoredCounts: { goals: 1, goalCategories: 1, projects: 1, tasks: 3, taskStatusEvents: 1, taskScheduleEvents: 1, recurrenceSeries: 1, settings: 1 }
    } }))
    window.todoApi = {
      backups: {
        listSafetyBackups: vi.fn(async () => ({ ok: true, data: [] })),
        selectAndInspectRestore: vi.fn(async () => ({ ok: true, data: {
          inspectionToken: 'inspection-token', confirmationToken: 'confirmation-token', displayName: '我的完整备份.todo-backup',
          createdAtUtc: '2026-09-02T00:00:00.000Z', applicationVersion: '1.0.0', schemaVersion: 1,
          counts: { goals: 1, goalCategories: 1, projects: 1, tasks: 3, taskStatusEvents: 1, taskScheduleEvents: 1, recurrenceSeries: 1, settings: 1 }, canonicalDomainDigest: 'digest'
        } })),
        restore,
        onProgress: vi.fn(() => () => undefined)
      },
      wecomCalendar: {
        getStatus: vi.fn(async () => ({ ok: true, data: disconnectedStatus })),
        connect: vi.fn(), disconnect: vi.fn(), sync: vi.fn(), getRange: vi.fn()
      }
    } as unknown as TodoDesktopApi

    render(<DataPage today="2026-09-03" appVersion="1.0.0" />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: '选择备份并检查' }))

    expect(await screen.findByText('我的完整备份.todo-backup')).toBeInTheDocument()
    const restoreButton = screen.getByRole('button', { name: '创建安全备份并恢复' })
    expect(restoreButton).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('覆盖恢复'), { target: { value: '覆盖恢复' } })
    expect(restoreButton).toBeEnabled()
    fireEvent.click(restoreButton)

    await waitFor(() => expect(restore).toHaveBeenCalledWith({ inspectionToken: 'inspection-token', confirmationToken: 'confirmation-token' }))
  })

  it('连接后立即只读同步指定缓存范围', async () => {
    const connect = vi.fn(async () => ({ ok: true as const, data: connectedStatus }))
    const sync = vi.fn(async () => ({ ok: true as const, data: { status: { ...connectedStatus, cachedEventCount: 3 }, receivedEventCount: 3 } }))
    installDataApi({ connect, sync })

    render(<DataPage today="2026-09-03" appVersion="1.2.0" />, { wrapper })
    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'zhangsan' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '连接并同步' }))

    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      server: 'https://caldav.wecom.work', account: 'zhangsan', username: undefined, password: 'secret'
    }))
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ startOn: '2026-07-30', endOn: '2027-09-08' }))
    expect(await screen.findByText('企业微信日历已连接 · 3 项')).toBeInTheDocument()
  })

  it('展示连接状态，支持手动同步和确认断开', async () => {
    const sync = vi.fn(async () => ({ ok: true as const, data: { status: { ...connectedStatus, cachedEventCount: 4 }, receivedEventCount: 4 } }))
    const disconnect = vi.fn(async () => ({ ok: true as const, data: disconnectedStatus }))
    installDataApi({ initialStatus: connectedStatus, sync, disconnect })

    render(<DataPage today="2026-09-03" appVersion="1.2.0" />, { wrapper })
    expect(await screen.findByText('zh*** · caldav.wecom.work')).toBeInTheDocument()
    expect(screen.getByText(/缓存 2 项/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '同步日程' }))
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ startOn: '2026-07-30', endOn: '2027-09-08' }))
    expect(await screen.findByText('企业微信日程已同步 · 4 项')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '断开' }))
    expect(screen.getByRole('dialog', { name: '断开企业微信日历？' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '断开' }).at(-1)!)
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('企业微信日历已断开')).toBeInTheDocument()
  })
})

const disconnectedStatus = {
  source: 'WECOM_CALDAV' as const, connected: false, syncing: false,
  serverHost: null, accountHint: null, lastAttemptAtUtc: null, lastSuccessAtUtc: null,
  lastErrorCode: null, cachedEventCount: 0, cachedRangeStartOn: null, cachedRangeEndOn: null
}

const connectedStatus = {
  ...disconnectedStatus, connected: true, serverHost: 'caldav.wecom.work', accountHint: 'zh***',
  lastSuccessAtUtc: '2026-09-03T01:00:00.000Z', cachedEventCount: 2,
  cachedRangeStartOn: '2026-08-01', cachedRangeEndOn: '2027-09-30'
}

function installDataApi(overrides: {
  initialStatus?: typeof connectedStatus | typeof disconnectedStatus
  connect?: ReturnType<typeof vi.fn>
  sync?: ReturnType<typeof vi.fn>
  disconnect?: ReturnType<typeof vi.fn>
}) {
  window.todoApi = {
    backups: {
      listSafetyBackups: vi.fn(async () => ({ ok: true as const, data: [] })),
      onProgress: vi.fn(() => () => undefined)
    },
    wecomCalendar: {
      getStatus: vi.fn(async () => ({ ok: true as const, data: overrides.initialStatus ?? disconnectedStatus })),
      connect: overrides.connect ?? vi.fn(),
      sync: overrides.sync ?? vi.fn(),
      disconnect: overrides.disconnect ?? vi.fn(),
      getRange: vi.fn()
    }
  } as unknown as TodoDesktopApi
}
