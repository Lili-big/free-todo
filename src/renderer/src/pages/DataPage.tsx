import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { BackupInspection, ExternalCalendarStatus } from '../../domain'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { ConfirmDialog, Modal } from '../components/Modal'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { addDays, formatDateTime } from '../utils/date'

interface Progress { stage?: string; percent?: number; message?: string }

export function DataPage({ today, appVersion }: { today: string; appVersion?: string }) {
  const safetyBackups = useQuery({ queryKey: ['safety-backups'], queryFn: todoClient.backups.safetyList })
  const preferences = useQuery({ queryKey: ['app-preferences'], queryFn: todoClient.app.preferences, retry: false })
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const [exporting, setExporting] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [inspection, setInspection] = useState<BackupInspection | null>(null)
  const [restorePhrase, setRestorePhrase] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [savingPreference, setSavingPreference] = useState(false)

  useEffect(() => todoClient.backups.subscribeProgress((value) => setProgress(value as Progress)), [])

  const exportBackup = async () => {
    setExporting(true)
    try {
      const result = await todoClient.backups.exportInteractive()
      if (!(result as { cancelled?: boolean }).cancelled) notify(`完整备份已导出${(result as { displayName?: string; fileName?: string }).displayName ?? (result as { fileName?: string }).fileName ? `：${(result as { displayName?: string; fileName?: string }).displayName ?? (result as { fileName?: string }).fileName}` : ''}`, 'success')
    } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setExporting(false) }
  }

  const inspect = async () => {
    setInspecting(true)
    try {
      const result = await todoClient.backups.inspectInteractive()
      if (result) { setInspection(result); setRestorePhrase('') }
    } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setInspecting(false) }
  }

  return <div className="page">
    <PageHeader title="数据管理" />
    <section className="settings-section"><header className="section-heading"><div><h2>应用设置</h2></div></header><label className="setting-row"><span>开机自启动</span><input aria-label="开机自启动" type="checkbox" checked={preferences.data?.launchAtLogin ?? false} disabled={preferences.isLoading || savingPreference} onChange={async (event) => {
      const enabled = event.target.checked
      setSavingPreference(true)
      try {
        const value = await todoClient.app.setLaunchAtLogin(enabled)
        queryClient.setQueryData(['app-preferences'], value)
        notify(enabled ? '已开启开机自启动' : '已关闭开机自启动', 'success')
      } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setSavingPreference(false) }
    }} /></label></section>
    <div className="data-action-grid">
      <article className="data-card"><span className="data-card__icon">⇩</span><div><h3>导出完整备份</h3></div><button className="button button--primary" type="button" onClick={exportBackup} disabled={exporting}>{exporting ? '正在生成并校验…' : '选择位置并导出'}</button></article>
      <article className="data-card data-card--restore"><span className="data-card__icon">⇧</span><div><h3>检查并恢复备份</h3><p>确认恢复后将全量覆盖当前数据。</p></div><button className="button button--secondary" type="button" onClick={inspect} disabled={inspecting}>{inspecting ? '正在检查…' : '选择备份并检查'}</button></article>
    </div>
    <WecomCalendarPanel today={today} />
    <div className="security-note"><span>i</span><div><strong>隐私与存储说明</strong><p>任务数据只保存在本机。企业微信连接信息由 Windows 加密保存且不进入备份；换电脑恢复后需要重新连接。</p></div></div>
    <section className="safety-section"><header className="section-heading"><div><h2>恢复前安全备份</h2></div><span className="count-badge">{safetyBackups.data?.length ?? 0}</span></header>{safetyBackups.isLoading ? <LoadingState /> : safetyBackups.isError ? <ErrorState error={safetyBackups.error} onRetry={() => safetyBackups.refetch()} /> : safetyBackups.data?.length ? <div className="backup-list">{safetyBackups.data.map((backup) => <div key={backup.id}><span className="backup-list__icon">◫</span><div><strong>{backup.fileName}</strong><small>{formatDateTime(backup.createdAtUtc)}{backup.reason ? ` · ${backup.reason}` : ''}</small></div></div>)}</div> : <EmptyState icon="◫" title="还没有安全备份" />}</section>
    <footer className="data-footer"><span>应用版本 {appVersion ?? '未知'}</span></footer>
    <RestoreDialog inspection={inspection} phrase={restorePhrase} setPhrase={setRestorePhrase} busy={restoring} progress={progress} onClose={() => !restoring && setInspection(null)} onConfirm={async () => {
      if (!inspection || restorePhrase !== '覆盖恢复') return
      setRestoring(true); setProgress({ stage: 'PREPARING', percent: 0, message: '正在准备恢复…' })
      try {
        await todoClient.backups.restore(inspection.inspectionToken, inspection.confirmationToken)
        notify('恢复完成，任务空间已切换到备份时点', 'success')
        setInspection(null); setRestorePhrase(''); await queryClient.invalidateQueries()
      } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setRestoring(false); setProgress(null) }
    }} />
  </div>
}

function WecomCalendarPanel({ today }: { today: string }) {
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const status = useQuery({ queryKey: ['wecom-calendar', 'status'], queryFn: todoClient.wecomCalendar.status, retry: false })
  const [server, setServer] = useState('https://caldav.wecom.work')
  const [account, setAccount] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const cacheRange = { startOn: addDays(today, -35), endOn: addDays(today, 370) }
  const refreshCalendar = async () => {
    await queryClient.invalidateQueries({ queryKey: ['wecom-calendar'] })
  }
  const sync = async (successMessage = '企业微信日程已同步') => {
    const result = await todoClient.wecomCalendar.sync(cacheRange.startOn, cacheRange.endOn)
    queryClient.setQueryData(['wecom-calendar', 'status'], result.status)
    await queryClient.invalidateQueries({ queryKey: ['wecom-calendar', 'range'] })
    notify(`${successMessage} · ${result.receivedEventCount} 项`, 'success')
  }

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!server.trim() || (!account.trim() && !username.trim()) || !password) return
    setBusy(true)
    try {
      const connected = await todoClient.wecomCalendar.connect({
        server: server.trim(),
        account: account.trim() || undefined,
        username: username.trim() || undefined,
        password
      })
      queryClient.setQueryData(['wecom-calendar', 'status'], connected)
      setPassword('')
      await sync('企业微信日历已连接')
    } catch (error) {
      notify(apiErrorMessage(error), 'error')
      await refreshCalendar()
    } finally {
      setBusy(false)
    }
  }

  const current = status.data
  return (
    <section className="integration-section" aria-labelledby="wecom-calendar-title">
      <header className="section-heading integration-section__heading">
        <div><h2 id="wecom-calendar-title">企业微信日历</h2></div>
        <span className="tag tag--neutral">只读</span>
      </header>
      {status.isLoading ? <LoadingState label="正在读取连接状态…" /> : status.isError ? (
        <div className="integration-error"><span>{apiErrorMessage(status.error)}</span><button className="mini-button" type="button" onClick={() => status.refetch()}>重试</button></div>
      ) : current?.connected ? (
        <div className="integration-card integration-card--connected">
          <span className="integration-card__mark" aria-hidden="true">企</span>
          <div className="integration-card__main">
            <div className="integration-card__title"><strong>已连接</strong>{current.lastErrorCode && <span className="tag tag--warning">上次同步失败</span>}</div>
            <span>{[current.accountHint, current.serverHost].filter(Boolean).join(' · ')}</span>
            <small>{current.lastSuccessAtUtc ? `上次同步 ${formatExternalTimestamp(current.lastSuccessAtUtc)}` : '尚未同步'} · 缓存 {current.cachedEventCount} 项</small>
          </div>
          <div className="integration-card__actions">
            <button className="button button--secondary" type="button" disabled={busy} onClick={async () => {
              setBusy(true)
              try { await sync() } catch (error) { notify(apiErrorMessage(error), 'error'); await refreshCalendar() } finally { setBusy(false) }
            }}>{busy ? '同步中…' : '同步日程'}</button>
            <button className="button button--ghost" type="button" disabled={busy} onClick={() => setConfirmDisconnect(true)}>断开</button>
          </div>
        </div>
      ) : (
        <form className="integration-card integration-connect-form" onSubmit={connect}>
          <label className="field field--server"><span>服务器</span><input type="url" value={server} onChange={(event) => setServer(event.target.value)} required /></label>
          <label className="field"><span>账号</span><input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" /></label>
          <label className="field"><span>用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label className="field"><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          <button className="button button--primary" type="submit" disabled={busy || !server.trim() || (!account.trim() && !username.trim()) || !password}>{busy ? '连接中…' : '连接并同步'}</button>
        </form>
      )}
      <ConfirmDialog
        open={confirmDisconnect}
        title="断开企业微信日历？"
        description="本机保存的连接信息和日程缓存会被移除，任务数据不受影响。"
        confirmLabel="断开"
        busy={busy}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={async () => {
          setBusy(true)
          try {
            const disconnected = await todoClient.wecomCalendar.disconnect()
            queryClient.setQueryData(['wecom-calendar', 'status'], disconnected)
            await queryClient.removeQueries({ queryKey: ['wecom-calendar', 'range'] })
            setConfirmDisconnect(false)
            notify('企业微信日历已断开', 'success')
          } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setBusy(false) }
        }}
      />
    </section>
  )
}

function formatExternalTimestamp(value: string): string {
  const parsed = Date.parse(value)
  return parsed ? formatDateTime(parsed) : '时间未知'
}

function RestoreDialog({ inspection, phrase, setPhrase, busy, progress, onClose, onConfirm }: { inspection: BackupInspection | null; phrase: string; setPhrase: (value: string) => void; busy: boolean; progress: Progress | null; onClose: () => void; onConfirm: () => void }) {
  const countLabels: Record<string, string> = { goals: '目标', goalCategories: '目标分类', projects: '项目', tasks: '任务', taskStatusEvents: '状态记录', taskScheduleEvents: '改期记录', recurrenceSeries: '重复系列', settings: '设置' }
  return <Modal open={Boolean(inspection)} title="确认全量恢复" description="检查已经通过。恢复会用备份内容替换当前全部数据，不会进行合并。" onClose={onClose} size="large">{inspection && <div className="restore-review"><div className="restore-file"><span>✓</span><div><strong>{inspection.fileName || '所选备份文件'}</strong><p>{formatDateTime(inspection.createdAtUtc)} · 应用 {inspection.applicationVersion} · 数据库版本 {inspection.schemaVersion}</p></div><em>校验通过</em></div><div className="restore-counts">{Object.entries(inspection.counts).map(([key, count]) => <div key={key}><strong>{count}</strong><span>{countLabels[key] ?? key}</span></div>)}</div><div className="danger-callout"><span>!</span><div><strong>当前数据将被完整覆盖</strong><p>备份后新建或修改的内容都会被替换。系统会先创建当前数据的安全备份；若安全备份失败，恢复不会开始。</p></div></div>{busy ? <div className="restore-progress"><div><span>{progress?.message ?? '正在安全恢复…'}</span><strong>{Math.max(0, Math.min(100, progress?.percent ?? 0))}%</strong></div><progress max="100" value={progress?.percent ?? 0} /><small>恢复期间请勿关闭应用。即使意外中断，下次启动也只会保留恢复前或完整恢复后的数据。</small></div> : <label className="field confirmation-phrase"><span>输入“覆盖恢复”以确认</span><input autoFocus value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="覆盖恢复" /></label>}<div className="modal-actions"><button className="button button--ghost" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button button--danger" type="button" onClick={onConfirm} disabled={busy || phrase !== '覆盖恢复'}>{busy ? '正在恢复…' : '创建安全备份并恢复'}</button></div></div>}</Modal>
}
