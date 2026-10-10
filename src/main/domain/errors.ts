import type { ErrorCode } from '@shared/types'

export class DomainError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, retryable = false) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function invariant(
  condition: unknown,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): asserts condition {
  if (!condition) throw new DomainError(code, message, details)
}

export function requireNonBlank(value: string, field = '名称', maximumLength = 200): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new DomainError('VALIDATION_FAILED', `${field}不能为空`, { field })
  }
  if (normalized.length > maximumLength) {
    throw new DomainError('VALIDATION_FAILED', `${field}最多 ${maximumLength} 个字符`, { field, maximumLength })
  }
  return normalized
}

export function normalizeOptionalText(value: string | null | undefined, maximumLength = 10_000): string | null {
  if (value === null || value === undefined || value.length === 0) return null
  if (value.length > maximumLength) {
    throw new DomainError('VALIDATION_FAILED', `内容最多 ${maximumLength} 个字符`)
  }
  return value
}
