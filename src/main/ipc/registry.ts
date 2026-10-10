import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { ipcSchemas, type IpcChannel } from '../../shared/schemas'
import type { ApiErrorDto, ApiResult, BackupProgressDto, ChangeNoticeDto, ErrorCode } from '../../shared/types'
import { IPC_EVENTS } from '../../shared/ipc'

export type IpcHandler = (input: unknown) => unknown | Promise<unknown>
export type IpcHandlerMap = Partial<Record<IpcChannel, IpcHandler>>

const ERROR_CODES = new Set<ErrorCode>([
  'VALIDATION_FAILED', 'NOT_FOUND', 'VERSION_CONFLICT', 'STALE_DAY_CONTEXT',
  'CONFIRMATION_REQUIRED', 'CONFIRMATION_EXPIRED', 'TASK_DEPTH_EXCEEDED',
  'PARENT_PROJECT_MISMATCH', 'PARENT_NOT_ACTIVE', 'RECURRENCE_RELATION_FORBIDDEN',
  'PROJECT_COMPLETED', 'PROJECT_HAS_OPEN_TASKS', 'PROJECT_HAS_ACTIVE_SERIES',
  'GOAL_PERIOD_INVALID', 'RECURRENCE_RULE_INVALID', 'OCCURRENCE_STALE',
  'BACKUP_CORRUPTED', 'BACKUP_UNSUPPORTED_VERSION', 'BACKUP_INCOMPLETE',
  'BACKUP_INVALID_RELATION', 'SAFETY_BACKUP_FAILED', 'RESTORE_FAILED',
  'MAINTENANCE_MODE', 'DATABASE_ERROR', 'FILE_IO_ERROR',
  'EXTERNAL_CALENDAR_NOT_CONNECTED', 'EXTERNAL_CALENDAR_AUTH_FAILED',
  'EXTERNAL_CALENDAR_SYNC_FAILED', 'CREDENTIAL_STORAGE_UNAVAILABLE', 'INTERNAL_ERROR'
])

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? event.sender.getURL()
  if (url.startsWith('todo-app://bundle/')) return true
  if (!process.env.ELECTRON_RENDERER_URL) return false
  try {
    return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
  } catch {
    return false
  }
}

function fieldErrors(error: ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root'
    ;(result[key] ??= []).push(issue.message)
  }
  return result
}

function asApiError(error: unknown, traceId: string): ApiErrorDto {
  if (error instanceof ZodError) {
    return {
      code: 'VALIDATION_FAILED',
      message: '提交的数据不符合要求，请检查后重试。',
      retryable: false,
      traceId,
      fieldErrors: fieldErrors(error)
    }
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown }
    if (typeof candidate.code === 'string' && ERROR_CODES.has(candidate.code as ErrorCode)) {
      return {
        code: candidate.code as ErrorCode,
        message: typeof candidate.message === 'string' ? candidate.message : '操作未完成。',
        retryable: candidate.retryable === true,
        traceId,
        details: typeof candidate.details === 'object' && candidate.details !== null
          ? candidate.details as Record<string, unknown>
          : undefined
      }
    }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: '应用遇到内部错误，原有数据未被改写。',
    retryable: false,
    traceId
  }
}

export function registerIpcHandlers(handlers: IpcHandlerMap, onInternalError?: (traceId: string, error: unknown) => void): () => void {
  const registered: IpcChannel[] = []
  for (const channel of Object.keys(ipcSchemas) as IpcChannel[]) {
    const handler = handlers[channel]
    if (!handler) continue
    ipcMain.handle(channel, async (event, rawInput): Promise<ApiResult<unknown>> => {
      const traceId = randomUUID()
      if (!isTrustedSender(event)) {
        return {
          ok: false,
          error: { code: 'VALIDATION_FAILED', message: '拒绝来自非应用页面的请求。', retryable: false, traceId }
        }
      }
      try {
        const input = ipcSchemas[channel].parse(rawInput)
        const data = await handler(input)
        return { ok: true, data }
      } catch (error) {
        onInternalError?.(traceId, error)
        return { ok: false, error: asApiError(error, traceId) }
      }
    })
    registered.push(channel)
  }
  return () => {
    for (const channel of registered) ipcMain.removeHandler(channel)
  }
}

export function broadcastChange(notice: ChangeNoticeDto, replaced = false): void {
  const channel = replaced ? IPC_EVENTS.DATABASE_REPLACED : IPC_EVENTS.CHANGED
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, notice)
}

export function broadcastBackupProgress(progress: BackupProgressDto): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_EVENTS.BACKUP_PROGRESS, progress)
}
