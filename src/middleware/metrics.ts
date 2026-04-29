/**
 * Recolector de métricas: contadores, histograma de latencias y errores
 * por tipo. Exporta tanto formato Prometheus-like como texto plano.
 */

export type ErrorType =
  | 'timeout'
  | 'rate_limit'
  | 'provider_4xx'
  | 'provider_5xx'
  | 'parse_error'
  | 'validation_error'
  | 'connection_error'
  | 'unknown'

interface Histogram {
  values: number[]
  maxSize: number
}

function createHistogram(maxSize = 1000): Histogram {
  return { values: [], maxSize }
}

function record(h: Histogram, value: number): void {
  h.values.push(value)
  if (h.values.length > h.maxSize) {
    h.values.shift()
  }
}

function percentile(h: Histogram, p: number): number {
  if (h.values.length === 0) return 0
  const sorted = [...h.values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx] ?? 0
}

export class Metrics {
  totalRequests = 0
  activeRequests = 0
  totalErrors = 0
  totalTokensIn = 0
  totalTokensOut = 0
  cacheHits = 0
  cacheMisses = 0
  retries = 0
  startTime = Date.now()

  errorsByType: Record<ErrorType, number> = {
    timeout: 0,
    rate_limit: 0,
    provider_4xx: 0,
    provider_5xx: 0,
    parse_error: 0,
    validation_error: 0,
    connection_error: 0,
    unknown: 0,
  }

  requestsByProvider = new Map<string, number>()
  latency = createHistogram()
  ttfb = createHistogram()

  recordLatency(ms: number): void {
    record(this.latency, ms)
  }

  recordTtfb(ms: number): void {
    record(this.ttfb, ms)
  }

  recordError(type: ErrorType): void {
    this.totalErrors++
    this.errorsByType[type]++
  }

  recordRequest(provider: string): void {
    this.totalRequests++
    this.requestsByProvider.set(provider, (this.requestsByProvider.get(provider) ?? 0) + 1)
  }

  summary(): string {
    const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0)
    const p50 = percentile(this.latency, 0.5).toFixed(0)
    const p95 = percentile(this.latency, 0.95).toFixed(0)
    const p99 = percentile(this.latency, 0.99).toFixed(0)
    const ttfbP50 = percentile(this.ttfb, 0.5).toFixed(0)
    const ttfbP95 = percentile(this.ttfb, 0.95).toFixed(0)

    const errors = Object.entries(this.errorsByType)
      .filter(([, n]) => n > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')

    const providers = [...this.requestsByProvider.entries()].map(([k, v]) => `${k}=${v}`).join(' ')

    return [
      `uptime_sec=${uptime}`,
      `requests_total=${this.totalRequests}`,
      `requests_active=${this.activeRequests}`,
      `errors_total=${this.totalErrors}`,
      `retries_total=${this.retries}`,
      `cache_hits=${this.cacheHits}`,
      `cache_misses=${this.cacheMisses}`,
      `tokens_in=${this.totalTokensIn}`,
      `tokens_out=${this.totalTokensOut}`,
      `latency_p50_ms=${p50}`,
      `latency_p95_ms=${p95}`,
      `latency_p99_ms=${p99}`,
      `ttfb_p50_ms=${ttfbP50}`,
      `ttfb_p95_ms=${ttfbP95}`,
      errors ? `errors{${errors}}` : '',
      providers ? `providers{${providers}}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  toJson(): Record<string, unknown> {
    return {
      uptime_sec: Math.floor((Date.now() - this.startTime) / 1000),
      requests: {
        total: this.totalRequests,
        active: this.activeRequests,
        retries: this.retries,
      },
      errors: {
        total: this.totalErrors,
        by_type: this.errorsByType,
      },
      tokens: {
        in: this.totalTokensIn,
        out: this.totalTokensOut,
      },
      latency_ms: {
        p50: percentile(this.latency, 0.5),
        p95: percentile(this.latency, 0.95),
        p99: percentile(this.latency, 0.99),
      },
      ttfb_ms: {
        p50: percentile(this.ttfb, 0.5),
        p95: percentile(this.ttfb, 0.95),
      },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
      },
      providers: Object.fromEntries(this.requestsByProvider),
    }
  }
}

export const metrics = new Metrics()
