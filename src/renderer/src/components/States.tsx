import type { ReactNode } from 'react'
import { apiErrorMessage } from '../../client'

export function LoadingState({ label = '正在整理数据…' }: { label?: string }) {
  return (
    <div className="state state--loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <span className="state__symbol" aria-hidden="true">!</span>
      <div>
        <strong>这里暂时没有加载成功</strong>
        <p>{apiErrorMessage(error)}</p>
      </div>
      {onRetry && <button className="button button--secondary" type="button" onClick={onRetry}>重新加载</button>}
    </div>
  )
}

export function EmptyState({ icon = '○', title, description, action }: {
  icon?: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="state state--empty">
      <span className="state__empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
