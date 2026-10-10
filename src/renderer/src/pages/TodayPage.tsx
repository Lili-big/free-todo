import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiErrorMessage, todoClient } from '../../client'
import { useFeedback } from '../components/Feedback'
import { Modal } from '../components/Modal'
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States'
import { TaskCard } from '../components/TaskCard'
import { useTaskComposer } from '../components/TaskComposer'
import { formatDate } from '../utils/date'

export function TodayPage({ today }: { today: string }) {
  const snapshot = useQuery({ queryKey: ['today', today], queryFn: todoClient.today.snapshot })
  const [reviewOpen, setReviewOpen] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const quickInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const { notify } = useFeedback()
  const composer = useTaskComposer()

  useEffect(() => {
    if (!quickBusy) quickInputRef.current?.focus()
  }, [quickBusy])

  if (snapshot.isLoading) return <PageFrame><LoadingState /></PageFrame>
  if (snapshot.isError || !snapshot.data) return <PageFrame><ErrorState error={snapshot.error} onRetry={() => snapshot.refetch()} /></PageFrame>
  const data = snapshot.data

  const quickCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!quickTitle.trim()) return
    setQuickBusy(true)
    try {
      await todoClient.tasks.create({ title: quickTitle.trim(), plannedOn: today })
      setQuickTitle('')
      notify('已加入今日清单', 'success')
      await queryClient.invalidateQueries()
    } catch (error) {
      notify(apiErrorMessage(error), 'error')
    } finally {
      setQuickBusy(false)
    }
  }

  return (
    <PageFrame>
      <PageHeader
        eyebrow={formatDate(today, { weekday: true })}
        title="今天要把什么做好？"
        description={`${data.overdue.length} 项遗留 · ${data.todayTasks.length} 项今日待办 · ${data.completedToday.length} 项已完成`}
      />

      {data.showReviewCard && (
        <section className="review-banner">
          <div className="review-banner__icon">☼</div>
          <div className="review-banner__copy">
            <span className="eyebrow">晨间复盘</span>
            <h2>开始晨间复盘</h2>
          </div>
          <button className="button button--light" type="button" onClick={() => setReviewOpen(true)}>开始复盘 <span>→</span></button>
          <button className="icon-button review-banner__close" type="button" aria-label="今天关闭复盘卡片" onClick={async () => {
            try {
              await todoClient.today.dismissReviewCard(today)
              await queryClient.invalidateQueries({ queryKey: ['today'] })
            } catch (error) { notify(apiErrorMessage(error), 'error') }
          }}>×</button>
        </section>
      )}

      <form className="quick-add" onSubmit={quickCreate}>
        <span className="quick-add__plus">＋</span>
        <input ref={quickInputRef} aria-label="快速添加今日任务" value={quickTitle} onChange={(event) => setQuickTitle(event.target.value)} placeholder="快速添加今天要做的事，按 Enter 保存" maxLength={160} disabled={quickBusy} />
        <button type="button" className="mini-button" onClick={() => composer.create({ plannedOn: today, title: quickTitle.trim() || undefined })}>手动添加</button>
      </form>

      <TaskSection
        title="今日任务"
        count={data.todayTasks.length}
        tasks={data.todayTasks}
        today={today}
        emptyTitle="今天还没有任务"
        todayRow
      />
      {data.overdue.length > 0 && (
        <TaskSection
          tone="danger"
          title="遗留待处理"
          count={data.overdue.length}
          tasks={data.overdue}
          today={today}
          emptyTitle=""
        />
      )}
      <details className="completed-section" open={data.completedToday.length > 0}>
        <summary><span>今日已完成</span><em>{data.completedToday.length}</em></summary>
        {data.completedToday.length > 0 && <div className="task-stack">{data.completedToday.map((task) => <TaskCard key={task.id} task={task} today={today} compact hideRestoreAction />)}</div>}
      </details>

      <button className="review-reopen" type="button" onClick={() => setReviewOpen(true)}>☼ 晨间复盘</button>
      <MorningReview open={reviewOpen} today={today} onClose={() => setReviewOpen(false)} />
    </PageFrame>
  )
}

function TaskSection({ tone, title, count, tasks, today, emptyTitle, todayRow }: {
  tone?: 'danger'
  title: string
  count: number
  tasks: Parameters<typeof TaskCard>[0]['task'][]
  today: string
  emptyTitle: string
  todayRow?: boolean
}) {
  return (
    <section className={`content-section${tone ? ` content-section--${tone}` : ''}`}>
      <header className="section-heading">
        <div><h2>{title} <span className="count-badge">{count}</span></h2></div>
      </header>
      {tasks.length ? <div className={todayRow ? 'task-stack task-stack--today' : 'task-stack'}>{tasks.map((task) => <TaskCard task={task} today={today} todayRow={todayRow} key={task.id} />)}</div> : <EmptyState icon="✓" title={emptyTitle} />}
    </section>
  )
}

function MorningReview({ open, today, onClose }: { open: boolean; today: string; onClose: () => void }) {
  const review = useQuery({ queryKey: ['review', today], queryFn: todoClient.today.review, enabled: open })
  const queryClient = useQueryClient()
  const composer = useTaskComposer()
  const { notify } = useFeedback()
  const [finishing, setFinishing] = useState(false)

  return (
    <Modal open={open} onClose={onClose} title="晨间复盘" size="large">
      {review.isLoading ? <LoadingState label="正在准备复盘…" /> : review.isError || !review.data ? <ErrorState error={review.error} onRetry={() => review.refetch()} /> : (
        <div className="review-flow">
          <ReviewBlock step="1" title={`昨日回顾 · ${formatDate(review.data.yesterday, { weekday: true })}`} count={review.data.yesterdayResults.length}>
            {review.data.yesterdayResults.length ? <div className="outcome-list">{review.data.yesterdayResults.map((task) => (
              <div className="outcome-row" key={task.id}><span className={task.status === 'CANCELLED' ? 'outcome-icon is-cancelled' : 'outcome-icon'}>{task.status === 'CANCELLED' ? '×' : '✓'}</span><span>{task.title}</span><small>{task.status === 'CANCELLED' ? '已取消' : '已完成'}</small></div>
            ))}</div> : <p className="quiet-copy">昨天没有完成或取消记录。</p>}
          </ReviewBlock>
          <ReviewBlock step="2" title="处理遗留" count={review.data.overdue.length}>
            {review.data.overdue.length ? <div className="task-stack">{review.data.overdue.map((task) => <TaskCard task={task} today={today} compact key={task.id} />)}</div> : <p className="quiet-copy">没有遗留事项。</p>}
          </ReviewBlock>
          <ReviewBlock step="3" title="浏览待分配" count={review.data.planning.length}>
            {review.data.planning.length ? <div className="task-stack">{review.data.planning.slice(0, 8).map((task) => <TaskCard task={task} today={today} compact key={task.id} />)}</div> : <p className="quiet-copy">待分配已经清空。</p>}
          </ReviewBlock>
          <ReviewBlock step="4" title="确认今日" count={review.data.todayTasks.length}>
            <button className="button button--secondary" type="button" onClick={() => composer.create({ plannedOn: today })}>＋ 添加今日任务</button>
            {review.data.todayTasks.length ? <div className="task-stack review-flow__today">{review.data.todayTasks.map((task) => <TaskCard task={task} today={today} compact key={task.id} />)}</div> : null}
          </ReviewBlock>
          <div className="review-finish">
            <strong>今天的清单可以开始执行了</strong>
            <button className="button button--primary" type="button" disabled={finishing} onClick={async () => {
              setFinishing(true)
              try {
                await todoClient.today.finishReview(today)
                notify('晨间复盘已结束，祝今天推进顺利', 'success')
                await queryClient.invalidateQueries()
                onClose()
              } catch (error) { notify(apiErrorMessage(error), 'error') } finally { setFinishing(false) }
            }}>{finishing ? '正在结束…' : '结束复盘'}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function ReviewBlock({ step, title, count, children }: { step: string; title: string; count: number; children: React.ReactNode }) {
  return <section className="review-block"><header><span>{step}</span><div><h3>{title} <em>{count}</em></h3></div></header><div className="review-block__content">{children}</div></section>
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="page page--today">{children}</div>
}
