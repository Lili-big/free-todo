import { useEffect, type ReactNode } from 'react'

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  size = 'medium',
  labelledBy
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  size?: 'small' | 'medium' | 'large'
  labelledBy?: string
}) {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => {
      window.removeEventListener('keydown', listener)
      previous?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  const titleId = labelledBy ?? `modal-title-${title.replace(/\s/g, '-')}`
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal open={open} title={title} description={description} onClose={onCancel} size="small">
      <div className="modal-actions">
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={busy}>返回检查</button>
        <button type="button" className={`button ${danger ? 'button--danger' : 'button--primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

