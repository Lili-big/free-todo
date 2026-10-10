export type WecomCalendarFailureCode = 'AUTH_FAILED' | 'NETWORK' | 'PROTOCOL' | 'STORAGE'

/** Error safe to classify and surface without retaining a remote response body. */
export class WecomCalendarIntegrationError extends Error {
  readonly failureCode: WecomCalendarFailureCode
  readonly retryable: boolean

  constructor(failureCode: WecomCalendarFailureCode, message: string, retryable = false) {
    super(message)
    this.name = 'WecomCalendarIntegrationError'
    this.failureCode = failureCode
    this.retryable = retryable
  }
}
