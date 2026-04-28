/**
 * AI Proxy Server — Optimizado para baja latencia
 *
 * Mejoras implementadas:
 *   1. Conexiones persistentes (keep-alive) vía undici.Agent
 *   2. Compresión automática gzip/br
 *   3. Timeouts configurables (conexión + request total)
 *   4. DNS caching implícito por reuse de sockets
 *   5. HTTP/2 opcional (ALLOW_H2=true)
 *
 * Uso:
 *   npm install
 *   TARGET_API_KEY=sk-xxx TARGET_MODEL=gpt-4o npx tsx src/server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Agent, Pool } from 'undici'
import { loadConfig } from './config.js'
import { translateRequest } from './translators/requestTranslator.js'
import {
  buildErrorResponse,
  translateResponse,
} from './translators/responseTranslator.js'
import {
  createStreamState,
  processStreamChunk,
  sendMessageStart,
} from './translators/streamTranslator.js'
import type { AnthropicRequest, OpenAIResponse, OpenAIStreamChunk } from './types.js'

// ==========================================================
// Async logging (evita bloqueo del event loop)
// ==========================================================

function asyncLog(message: string): void {
  process.stdout.write(message + '\n')
}

function asyncLogWarn(message: string): void {
  process.stderr.write(message + '\n')
}

function asyncLogError(message: string): void {
  process.stderr.write(message + '\n')
}

// ==========================================================
// Métricas de latencia
// ==========================================================

interface RequestMetrics {
  totalRequests: number
  activeRequests: number
  totalErrors: number
  totalTokensIn: number
  totalTokensOut: number
  latencySum: number        // ms acumulados de requests completadas
  latencyCount: number
  ttfbSum: number           // time-to-first-byte acumulado (streaming)
  ttfbCount: number
  startTime: number         // epoch ms del arranque del servidor
}

const metrics: RequestMetrics = {
  totalRequests: 0,
  activeRequests: 0,
  totalErrors: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  latencySum: 0,
  latencyCount: 0,
  ttfbSum: 0,
  ttfbCount: 0,
  startTime: Date.now(),
}

function recordLatency(ms: number): void {
  metrics.latencySum += ms
  metrics.latencyCount++
}

function recordTtfb(ms: number): void {
  metrics.ttfbSum += ms
  metrics.ttfbCount++
}

function getMetricsSummary(): string {
  const avgLatency = metrics.latencyCount > 0
    ? (metrics.latencySum / metrics.latencyCount).toFixed(1)
    : 'n/a'
  const avgTtfb = metrics.ttfbCount > 0
    ? (metrics.ttfbSum / metrics.ttfbCount).toFixed(1)
    : 'n/a'
  const uptimeSec = ((Date.now() - metrics.startTime) / 1000).toFixed(0)
  return `uptime=${uptimeSec}s req=${metrics.totalRequests} active=${metrics.activeRequests} err=${metrics.totalErrors} avg_latency=${avgLatency}ms avg_ttfb=${avgTtfb}ms tokens=${metrics.totalTokensIn}in/${metrics.totalTokensOut}out`
}

// ==========================================================
// Rate limiting
// ==========================================================

interface RateLimitEntry {
  count: number
  windowStart: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '0', 10) // 0 = deshabilitado

function checkRateLimit(ip: string): boolean {
  if (RATE_LIMIT_MAX === 0) return true
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// Limpiar entradas expiradas cada minuto
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip)
    }
  }
}, 60_000).unref()

// ==========================================================
// Retry logic utilities
// ==========================================================

interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  backoffMultiplier: number
  maxDelayMs: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldRetry(statusCode: number, error: Error): boolean {
  // No reintentar errores de cliente (4xx), excepto 429
  if (statusCode >= 400 && statusCode < 500) {
    return statusCode === 429 // Rate limit
  }
  // Sí reintentar errores de servidor (5xx) y errores de red
  if (statusCode >= 500 || statusCode === 0) {
    return true
  }
  // Errores de timeout
  if (error.message.includes('timeout') || error.message.includes('Timeout')) {
    return true
  }
  return false
}

function calculateRetryDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(options.backoffMultiplier, attempt - 1)
  return Math.min(exponentialDelay, options.maxDelayMs)
}

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10)

const config = loadConfig()

// ── Pool de conexiones persistentes ────────────────────────
// Reutiliza sockets TCP+TLS entre requests. Reduce latencia de
// * conexión de ~50-300ms a ~0ms para requests subsiguientes.
const targetUrl = new URL(config.targetBaseUrl)
// Normaliza el path base: elimina trailing slash para concatenar limpio
const targetBasePath = targetUrl.pathname.replace(/\/$/, '')

const dispatcher = config.allowH2
  ? new Pool(targetUrl.origin, {
      connections: config.maxSockets,
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 60000,
      connect: { rejectUnauthorized: true, allowH2: true },
    })
  : new Agent({
      connect: { keepAlive: config.keepAlive, rejectUnauthorized: true },
      connections: config.maxSockets,
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 60000,
    })

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // Endpoint de métricas
  if (req.method === 'GET' && req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(getMetricsSummary())
    return
  }

  // Rate limiting por IP
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown'
  if (!checkRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(RATE_LIMIT_WINDOW_MS / 1000) })
    res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests' } }))
    return
  }

  metrics.totalRequests++
  metrics.activeRequests++
  const reqStart = Date.now()

  try {
    await handleRequest(req, res, reqStart)
  } catch (err) {
    metrics.totalErrors++
    const message = err instanceof Error ? err.message : String(err)
    asyncLogError(`❌ Error no capturado: ${message}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildErrorResponse('unknown', message)))
    }
  } finally {
    metrics.activeRequests--
    recordLatency(Date.now() - reqStart)
  }
})

// ==========================================================
// Request handler principal
// ==========================================================

async function handleRequest(req: IncomingMessage, res: ServerResponse, reqStart: number): Promise<void> {
  const url = req.url || ''

  if (req.method !== 'POST' || !url.match(/\/v1\/messages/)) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'not_found', message: `Route not found: ${req.method} ${url}` } }))
    return
  }

  const body = await readBody(req)
  let anthropicReq: AnthropicRequest

  try {
    anthropicReq = JSON.parse(body)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'Invalid JSON body' } }))
    return
  }

  const isStreaming = anthropicReq.stream === true

  if (config.logRequests) {
    asyncLog(`\n📨 ${new Date().toISOString()} | ${anthropicReq.model} | stream=${isStreaming} | msgs=${anthropicReq.messages.length} | tools=${anthropicReq.tools?.length ?? 0}`)
  }

  const openaiReq = translateRequest(anthropicReq, config.targetModel)

  if (config.logRequests) {
    asyncLog(`   → Traducido a: ${openaiReq.model} | msgs=${openaiReq.messages.length}`)
  }

  const retryOptions: RetryOptions = {
    maxRetries: config.maxRetries,
    baseDelayMs: config.retryDelayMs,
    backoffMultiplier: config.retryBackoffMultiplier,
    maxDelayMs: config.retryMaxDelayMs,
  }

  let lastError: Error | null = null
  let lastStatusCode = 0

  for (let attempt = 1; attempt <= retryOptions.maxRetries; attempt++) {
    // AbortController para timeouts (creado en cada intento)
    const abortController = new AbortController()
    const connectionTimeout = setTimeout(() => {
      abortController.abort(new Error(`Connection timeout after ${config.connectionTimeout}ms`))
    }, config.connectionTimeout)

    const requestTimeout = setTimeout(() => {
      abortController.abort(new Error(`Request timeout after ${config.requestTimeout}ms`))
    }, config.requestTimeout)

    try {
      const targetRes = await dispatcher.request({
        origin: targetUrl.origin,
        method: 'POST',
        path: `${targetBasePath}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.targetApiKey}`,
          'Accept-Encoding': 'gzip, br',
        },
        body: JSON.stringify(openaiReq),
        signal: abortController.signal,
      })

      clearTimeout(connectionTimeout)

      if (targetRes.statusCode >= 400) {
        const errorBody = await targetRes.body.text()
        lastStatusCode = targetRes.statusCode
        lastError = new Error(`Provider error ${targetRes.statusCode}: ${errorBody}`)

        if (shouldRetry(targetRes.statusCode, lastError)) {
          if (attempt < retryOptions.maxRetries) {
            const delay = calculateRetryDelay(attempt, retryOptions)
            if (config.logRequests) {
              asyncLogWarn(`   ⚠️  Intento ${attempt}/${retryOptions.maxRetries} falló (${targetRes.statusCode}), reintentando en ${delay}ms...`)
            }
            clearTimeout(requestTimeout)
            await sleep(delay)
            continue // Siguiente intento
          }
        }

        // No retryable o máximo de intentos alcanzado
        clearTimeout(requestTimeout)
        asyncLogError(`❌ Error del proveedor (${targetRes.statusCode}): ${errorBody}`)
        res.writeHead(targetRes.statusCode, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(buildErrorResponse(
          anthropicReq.model,
          `Provider error ${targetRes.statusCode}: ${errorBody}`,
        )))
        return
      }

      // Éxito
      if (config.logRequests && attempt > 1) {
        asyncLog(`   ✅ Éxito en intento ${attempt}`)
      }

      if (isStreaming) {
        await handleStreamingResponse(targetRes, res, anthropicReq.model, requestTimeout, reqStart)
   } else {
        await handleNormalResponse(targetRes, res, anthropicReq.model, requestTimeout)
        const latencyMs = Date.now() - reqStart
        if (config.logRequests) asyncLog(`   ⏱  Latencia total: ${latencyMs}ms`)
      }
      return

    } catch (err) {
      clearTimeout(connectionTimeout)
      clearTimeout(requestTimeout)

      const message = err instanceof Error ? err.message : String(err)
      lastError = err instanceof Error ? err : new Error(message)
      lastStatusCode = 0

      // Intentar extraer statusCode del error si existe
      const errAny = err as any
      if (errAny?.statusCode) {
        lastStatusCode = errAny.statusCode
      }

      if (shouldRetry(lastStatusCode, lastError)) {
        if (attempt < retryOptions.maxRetries) {
          const delay = calculateRetryDelay(attempt, retryOptions)
          if (config.logRequests) {
            asyncLogWarn(`   ⚠️  Intento ${attempt}/${retryOptions.maxRetries} falló (${message}), reintentando en ${delay}ms...`)
          }
          await sleep(delay)
          continue // Siguiente intento
        }
      }

      // No retryable o máximo alcanzado
      asyncLogError(`❌ Error de conexión al proveedor (intento ${attempt}): ${message}`)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildErrorResponse(anthropicReq.model, `Connection error: ${message}`)))
      return
    }
  }

  // Fallback defensivo: si el for-loop termina sin return (no debería pasar),
  // enviar respuesta de error para no dejar al cliente colgado.
  if (!res.headersSent) {
    const errMsg = lastError?.message ?? 'All retry attempts exhausted'
    asyncLogError(`❌ Todos los reintentos agotados (${retryOptions.maxRetries}): ${errMsg}`)
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(buildErrorResponse(anthropicReq.model, `All ${retryOptions.maxRetries} attempts failed: ${errMsg}`)))
  }
}

// ==========================================================
// Respuesta normal (sin streaming)
// ===============================================

async function handleNormalResponse(
  targetRes: any,
  res: ServerResponse,
  requestModel: string,
  requestTimeout: ReturnType<typeof setTimeout>,
): Promise<void> {
  // requestTimeout sigue activo para cubrir la lectura del body
  const body = await targetRes.body.text()
  clearTimeout(requestTimeout) // Limpiar una sola vez aquí, después de leer el body

  let openaiResp: OpenAIResponse
  try {
    openaiResp = JSON.parse(body)
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(buildErrorResponse(requestModel, `Invalid JSON from provider: ${body.slice(0, 200)}`)))
    return
  }

  const tokensIn = openaiResp.usage?.prompt_tokens ?? 0
  const tokensOut = openaiResp.usage?.completion_tokens ?? 0
  metrics.totalTokensIn += tokensIn
  metrics.totalTokensOut += tokensOut

  if (config.logRequests) {
    asyncLog(`   ✅ Respuesta recibida | tokens: ${tokensIn}in/${tokensOut}out`)
  }

  const anthropicResp = translateResponse(openaiResp, requestModel)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(anthropicResp))
}

// ==========================================================
// Respuesta streaming (SSE)
// ==========================================================

async function handleStreamingResponse(
  targetRes: any,
  res: ServerResponse,
  requestModel: string,
  requestTimeout: ReturnType<typeof setTimeout>,
  reqStart: number,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const state = createStreamState(requestModel)
  await sendMessageStart(res, state)

  const reader = targetRes.body
  const decoder = new TextDecoder()
  let buffer = ''
  let chunkCount = 0
  let ttfbRecorded = false
  let isStreamActive = true

  let currentRequestTimeout = requestTimeout

  // Refrescar timeout mientras haya actividad
  const refreshTimeout = () => {
    // Limpiar el timer ACTIVO actual, no el parámetro original
    clearTimeout(currentRequestTimeout)
    const newTimeout = setTimeout(() => {
      if (isStreamActive && !res.writableEnded) {
        asyncLogError(`❌ Request timeout después de ${config.requestTimeout}ms de inactividad en stream`)
        res.end()
      }
    }, config.requestTimeout)
    currentRequestTimeout = newTimeout
  }

  try {
    for await (const chunk of reader) {
      chunkCount++

      // Registrar time-to-first-byte en el primer chunk
      if (!ttfbRecorded) {
        ttfbRecorded = true
        recordTtfb(Date.now() - reqStart)
      }

      // Refrescar timeout en cada chunk recibido
      refreshTimeout()

      try {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          if (trimmed === 'data: [DONE]') {
            // El stream de OpenAI terminó, forzar cierre del bucle
            isStreamActive = false
            break
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6)
            try {
              const chunkData: OpenAIStreamChunk = JSON.parse(jsonStr)
              await processStreamChunk(res, chunkData, state)
            } catch (parseErr) {
              if (config.logRequests) {
                asyncLogWarn(`   ⚠️ Chunk malformado (chunk #${chunkCount}): ${jsonStr.slice(0, 100)}`)
              }
              // No rompemos el stream por un chunk malformado
              continue
            }
          }
        }
      } catch (chunkErr) {
        // Error procesando este chunk específico, pero continuamos con el siguiente
        if (config.logRequests) {
          asyncLogError(`   ⚠️ Error procesando chunk #${chunkCount}: ${chunkErr instanceof Error ? chunkErr.message : String(chunkErr)}`)
        }
        continue
      }
    }
  } catch (err) {
    // Error fatal leyendo el stream
    isStreamActive = false
    const errMsg = err instanceof Error ? err.message : String(err)
    asyncLogError(`❌ Error fatal leyendo stream después de ${chunkCount} chunks: ${errMsg}`)
    clearTimeout(currentRequestTimeout)
    // Headers ya fueron enviados (writeHead 200 + SSE), así que
    // enviamos un evento de error por SSE y cerramos el stream.
    if (!res.writableEnded) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'stream_error', message: errMsg } })}\n\n`)
      } catch { /* ignore write errors during cleanup */ }
      res.end()
    }
    return
  }

  // Stream completado normalmente
  isStreamActive = false
  clearTimeout(currentRequestTimeout)

  metrics.totalTokensIn += state.inputTokens
  metrics.totalTokensOut += state.outputTokens

  if (config.logRequests) {
    const totalMs = Date.now() - reqStart
    asyncLog(`   ✅ Stream completado (${chunkCount} chunks) | tokens: ${state.inputTokens}in/${state.outputTokens}out | ${totalMs}ms`)
  }

  if (!res.writableEnded) {
    res.end()
  }
}

// ==========================================================
// Utilidades
// ==========================================================

// Memory pool para buffers (reduce GC pressure en alta carga)
const bufferPool: Buffer[][] = []
const MAX_POOL_SIZE = 100

function acquireBuffer(): Buffer[] {
  if (bufferPool.length > 0) {
    return bufferPool.pop()!
  }
  return []
}

function releaseBuffer(chunks: Buffer[]): void {
  if (bufferPool.length < MAX_POOL_SIZE) {
    // Limpiar referencias pero mantener el array en el pool
    chunks.length = 0
    bufferPool.push(chunks)
  }
}

const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || String(10 * 1024 * 1024), 10) // 10 MB default

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks = acquireBuffer() // Reutiliza array del pool
    let totalSize = 0

    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }

    const onData = (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        cleanup()
        releaseBuffer(chunks)
        req.destroy()
        reject(new Error(`Request body too large (>${MAX_BODY_SIZE} bytes)`))
        return
      }
      chunks.push(chunk)
    }

    const onEnd = () => {
      cleanup()
      try {
        const result = Buffer.concat(chunks).toString('utf8')
        releaseBuffer(chunks) // Devuelve al pool
        resolve(result)
      } catch (err) {
     releaseBuffer(chunks)
        reject(err)
      }
    }

    const onError = (err: Error) => {
      cleanup()
      releaseBuffer(chunks)
      reject(err)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

// ==========================================================
// Iniciar servidor
// ==========================================================

server.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                   🔀 AI PROXY SERVER                     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Escuchando en:    http://localhost:${String(config.port).padEnd(21)}║
║  Proveedor:        ${config.targetBaseUrl.slice(0, 38).padEnd(38)}║
║  Modelo destino:   ${config.targetModel.padEnd(38)}║
║                                                          ║
║  --- Conexión ---                                        ║
║  Keep-Alive:       ${String(config.keepAlive).padEnd(38)}║
║  HTTP/2:           ${String(config.allowH2).padEnd(38)}║
║  Max sockets:      ${String(config.maxSockets).padEnd(38)}║
║  Conn timeout:     ${String(config.connectionTimeout).padEnd(38)}║
║  Request timeout:  ${String(config.requestTimeout).padEnd(38)}║
║                                                          ║
║  --- Retry ---                                           ║
║  Max retries:      ${String(config.maxRetries).padEnd(38)}║
║  Retry delay:      ${String(config.retryDelayMs + 'ms').padEnd(38)}║
║  Backoff mult:     ${String(config.retryBackoffMultiplier).padEnd(38)}║
║  Max delay:        ${String(config.retryMaxDelayMs + 'ms').padEnd(38)}║
║                                                          ║
║  --- Extras ---                                          ║
║  Rate limit:       ${(RATE_LIMIT_MAX > 0 ? RATE_LIMIT_MAX + ' req/' + RATE_LIMIT_WINDOW_MS / 1000 + 's' : 'disabled').padEnd(38)}║
║  Shutdown timeout: ${String(SHUTDOWN_TIMEOUT_MS + 'ms').padEnd(38)}║
║  Log requests:     ${String(config.logRequests).padEnd(38)}║
║                                                          ║
║  Para usar con Claude Code:                              ║
║  export ANTHROPIC_BASE_URL=http://localhost:${String(config.port).padEnd(13)}║
║  Métricas: GET http://localhost:${String(config.port).padEnd(25)}║
║            /metrics                                      ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`)
})

server.on('error', (err) => {
  console.error(`❌ Error del servidor: ${err.message}`)
  process.exit(1)
})

// ==========================================================
// Graceful shutdown
// ==========================================================

function shutdown(signal: string): void {
  asyncLog(`\n🛑 ${signal} recibido — iniciando graceful shutdown...`)
  asyncLog(`   Requests activas: ${metrics.activeRequests}`)
  asyncLog(`   ${getMetricsSummary()}`)

  // Dejar de aceptar nuevas conexiones
  server.close(() => {
    asyncLog('✅ Servidor cerrado limpiamente.')
    process.exit(0)
  })

  // Forzar cierre si hay requests que no terminan
  setTimeout(() => {
    asyncLogError(`❌ Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — forzando cierre.`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
