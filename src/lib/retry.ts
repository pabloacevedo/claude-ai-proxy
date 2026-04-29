/**
 * Lógica de reintentos con backoff exponencial.
 */

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  backoffMultiplier: number
  maxDelayMs: number
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function shouldRetry(statusCode: number, error: Error): boolean {
  // 4xx no retryables, excepto 429 (rate limit)
  if (statusCode >= 400 && statusCode < 500) {
    return statusCode === 429
  }
  // 5xx y errores de red sí son retryables
  if (statusCode >= 500 || statusCode === 0) {
    return true
  }
  // Timeouts
  const msg = error.message.toLowerCase()
  if (msg.includes('timeout') || msg.includes('socket') || msg.includes('econnreset')) {
    return true
  }
  return false
}

export function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * Math.pow(options.backoffMultiplier, attempt - 1)
  // Jitter ±20% para evitar thundering herd
  const jitter = exponential * (0.8 + Math.random() * 0.4)
  return Math.min(jitter, options.maxDelayMs)
}
