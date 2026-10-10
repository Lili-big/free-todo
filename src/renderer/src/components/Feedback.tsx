import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

type ToastTone = 'success' | 'error' | 'info'
interface Toast { id: number; message: string; tone: ToastTone }
interface FeedbackContextValue { notify: (message: string, tone?: ToastTone) => void }

const FeedbackContext = createContext<FeedbackContextValue | null>(null)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3600)
  }, [])
  const value = useMemo(() => ({ notify }), [notify])

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.tone}`} key={toast.id} role="status">
            <span className="toast__mark">{toast.tone === 'success' ? '✓' : toast.tone === 'error' ? '!' : 'i'}</span>
            <span>{toast.message}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}>×</button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  )
}

export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext)
  if (!context) throw new Error('useFeedback must be used in FeedbackProvider')
  return context
}

