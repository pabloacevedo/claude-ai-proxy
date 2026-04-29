/**
 * AI Proxy Server — Entry point.
 *
 * Solo se ocupa de routing, lifecycle y wiring. La lógica vive en módulos
 * dedicados (handlers/, middleware/, lib/, translators/).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadConfig } from './config/index.js'
import { handleHealth } from './handlers/health.js'
import { handleMessages } from './handlers/messages.js'
import { handleMetrics } from './handlers/metrics.js'
import { LRUCache } from './lib/cache.js'
import { createDispatcher } from './lib/httpClient.js'
import { configureLogger, logger } from './lib/logger.js'
import { applyCors } from './middleware/cors.js'
import { metrics } from './middleware/metrics.js'
import { getClientIp, RateLimiter } from './middleware/rateLimit.js'
import { generateRequestId } from './middleware/requestId.js'
import type { AnthropicResponse } from './types.js'

const config = loadConfig()

configureLogger({
  level: config.logLevel,
  format: config.logFormat,
  redact: config.logRedact,
})

const defaultProvider = config.router.defaultProvider()
const dispatcher = createDispatcher({
  origin: new URL(defaultProvider.baseUrl).origin,
  maxSockets: config.maxSockets,
  keepAlive: config.keepAlive,
  allowH2: config.allowH2,
})

const rateLimiter = new RateLimiter({
  max: config.rateLimitMax,
  windowMs: config.rateLimitWindowMs,
})

const cache: LRUCache<AnthropicResponse> | null = config.cacheEnabled
  ? new LRUCache<AnthropicResponse>(config.cacheMaxSize, config.cacheTtlMs)
  : null

if (!defaultProvider.apiKey) {
  logger.warn('TARGET_API_KEY not configured — provider requests will fail')
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  applyCors(req, res, config.cors)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    handleHealth(res)
    return
  }

  if (req.method === 'GET' && req.url === '/metrics') {
    handleMetrics(req, res)
    return
  }

  if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: { type: 'not_found', message: `Route not found: ${req.method} ${req.url}` },
      }),
    )
    return
  }

  const ip = getClientIp(req)
  const limit = rateLimiter.check(ip)
  if (!limit.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(limit.retryAfterSec),
    })
    res.end(
      JSON.stringify({
        error: { type: 'rate_limit_error', message: 'Too many requests' },
      }),
    )
    metrics.recordError('rate_limit')
    return
  }

  const requestId = generateRequestId()
  const reqLogger = logger.child({ requestId })
  metrics.activeRequests++
  const reqStart = Date.now()

  try {
    await handleMessages(req, res, { config, logger: reqLogger, dispatcher, cache }, reqStart)
  } catch (err) {
    metrics.recordError('unknown')
    const message = err instanceof Error ? err.message : String(err)
    reqLogger.error('Unhandled error', { error: message })
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { type: 'internal_error', message },
        }),
      )
    }
  } finally {
    metrics.activeRequests--
    metrics.recordLatency(Date.now() - reqStart)
  }
})

function printStartupBanner(): void {
  const pad = (s: string | number, n: number): string => String(s).slice(0, n).padEnd(n)
  const rateLimit =
    config.rateLimitMax > 0
      ? `${config.rateLimitMax} req/${config.rateLimitWindowMs / 1000}s`
      : 'disabled'
  const cache = config.cacheEnabled
    ? `${config.cacheMaxSize} entries, ttl=${config.cacheTtlMs}ms`
    : 'disabled'

  process.stdout.write(`
╔══════════════════════════════════════════════════════════╗
║                   🔀 AI PROXY SERVER                     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Escuchando en:    http://localhost:${pad(config.port, 21)}║
║  Provider default: ${pad(defaultProvider.name, 38)}║
║  URL base:         ${pad(defaultProvider.baseUrl, 38)}║
║  Modelo destino:   ${pad(defaultProvider.model, 38)}║
║  Passthrough:      ${pad(String(defaultProvider.passthrough ?? false), 38)}║
║                                                          ║
║  --- Conexión ---                                        ║
║  Keep-Alive:       ${pad(String(config.keepAlive), 38)}║
║  HTTP/2:           ${pad(String(config.allowH2), 38)}║
║  Max sockets:      ${pad(config.maxSockets, 38)}║
║  Conn timeout:     ${pad(config.connectionTimeout + 'ms', 38)}║
║  Request timeout:  ${pad(config.requestTimeout + 'ms', 38)}║
║                                                          ║
║  --- Retry ---                                           ║
║  Max retries:      ${pad(config.maxRetries, 38)}║
║  Retry delay:      ${pad(config.retryDelayMs + 'ms', 38)}║
║  Backoff mult:     ${pad(config.retryBackoffMultiplier, 38)}║
║  Max delay:        ${pad(config.retryMaxDelayMs + 'ms', 38)}║
║                                                          ║
║  --- Extras ---                                          ║
║  Rate limit:       ${pad(rateLimit, 38)}║
║  Cache:            ${pad(cache, 38)}║
║  Log level/format: ${pad(`${config.logLevel} / ${config.logFormat}`, 38)}║
║  Shutdown timeout: ${pad(config.shutdownTimeoutMs + 'ms', 38)}║
║                                                          ║
║  Para usar con Claude Code:                              ║
║  export ANTHROPIC_BASE_URL=http://localhost:${pad(config.port, 13)}║
║                                                          ║
║  Endpoints:                                              ║
║    POST /v1/messages    GET /health    GET /metrics      ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝

`)
}

server.listen(config.port, () => {
  if (config.logFormat === 'json') {
    logger.info('Proxy started', {
      port: config.port,
      default_provider: defaultProvider.name,
      base_url: defaultProvider.baseUrl,
      target_model: defaultProvider.model,
      passthrough: defaultProvider.passthrough ?? false,
      keep_alive: config.keepAlive,
      h2: config.allowH2,
      rate_limit:
        config.rateLimitMax > 0
          ? `${config.rateLimitMax}/${config.rateLimitWindowMs}ms`
          : 'disabled',
      cache: config.cacheEnabled
        ? `${config.cacheMaxSize} entries, ttl=${config.cacheTtlMs}ms`
        : 'disabled',
    })
  } else {
    printStartupBanner()
  }
})

server.on('error', (err) => {
  logger.error('Server error', { error: err.message })
  process.exit(1)
})

function shutdown(signal: string): void {
  logger.info('Shutdown initiated', { signal, active: metrics.activeRequests })
  rateLimiter.stop()

  server.close(() => {
    logger.info('Server closed cleanly', { summary: metrics.summary() })
    process.exit(0)
  })

  setTimeout(() => {
    logger.error('Shutdown timeout — forcing exit', { ms: config.shutdownTimeoutMs })
    process.exit(1)
  }, config.shutdownTimeoutMs).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
