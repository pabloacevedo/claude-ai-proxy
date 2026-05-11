/**
 * Handler principal POST /v1/messages.
 *
 * Flujo:
 *   1. Lee y valida el body (AnthropicRequest)
 *   2. Resuelve provider (puede variar por modelo)
 *   3. Si passthrough: reenvía sin traducir
 *   4. Si no: traduce a OpenAI, llama al provider con retries,
 *      traduce respuesta de vuelta a Anthropic.
 *   5. Streaming y no-streaming gestionados por separado.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Dispatcher } from 'undici'
import type { ProxyConfig } from '../config/index.js'
import type { ProviderConfig } from '../config/providers.js'
import { hashRequest, type LRUCache } from '../lib/cache.js'
import * as bufferPool from '../lib/bufferPool.js'
import type { ChildLogger } from '../lib/logger.js'
import { calculateDelay, shouldRetry, sleep, type RetryOptions } from '../lib/retry.js'
import { metrics, type ErrorType } from '../middleware/metrics.js'
import { translateRequest } from '../translators/requestTranslator.js'
import { buildErrorResponse, translateResponse } from '../translators/responseTranslator.js'
import {
  createStreamState,
  processStreamChunk,
  sendMessageStart,
} from '../translators/streamTranslator.js'
import type {
  AnthropicRequest,
  AnthropicResponse,
  OpenAIResponse,
  OpenAIStreamChunk,
} from '../types.js'
import { validateAnthropicRequest } from '../validators/anthropicRequest.js'

export interface MessagesHandlerDeps {
  config: ProxyConfig
  logger: ChildLogger
  dispatcher: Dispatcher
  cache: LRUCache<AnthropicResponse> | null
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MessagesHandlerDeps,
  reqStart: number,
): Promise<void> {
  const { config, logger, cache } = deps

  let body: string
  try {
    body = await readBody(req, config.maxBodyBytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('Failed to read body', { reason: msg })
    metrics.recordError('parse_error')
    sendJson(res, 400, { error: { type: 'invalid_request', message: msg } })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    metrics.recordError('parse_error')
    sendJson(res, 400, { error: { type: 'invalid_request', message: 'Invalid JSON body' } })
    return
  }

  const validation = validateAnthropicRequest(parsed)
  if (!validation.ok) {
    metrics.recordError('validation_error')
    logger.warn('Validation failed', { error: validation.error })
    sendJson(res, 400, { error: { type: 'invalid_request', message: validation.error } })
    return
  }
  const anthropicReq = validation.value

  const isStreaming = anthropicReq.stream === true
  const provider = config.router.resolve(anthropicReq.model)
  metrics.recordRequest(provider.name)

  logger.info('Request received', {
    model: anthropicReq.model,
    target_model: provider.model,
    provider: provider.name,
    stream: isStreaming,
    msgs: anthropicReq.messages.length,
    tools: anthropicReq.tools?.length ?? 0,
  })

  // Cache lookup (solo no-streaming)
  let cacheKey: string | null = null
  if (cache && !isStreaming) {
    cacheKey = hashRequest({
      model: provider.model,
      messages: anthropicReq.messages,
      system: anthropicReq.system,
      tools: anthropicReq.tools,
      temperature: anthropicReq.temperature,
    })
    const hit = cache.get(cacheKey)
    if (hit) {
      metrics.cacheHits++
      logger.info('Cache hit', { key: cacheKey.slice(0, 8) })
      sendJson(res, 200, hit)
      return
    }
    metrics.cacheMisses++
  }

  // Si pasamos a Anthropic real, no traducimos
  if (provider.passthrough) {
    await passthroughAnthropic(req, res, body, anthropicReq, provider, deps, reqStart)
    return
  }

  const openaiReq = translateRequest(anthropicReq, provider.model)
  await sendToProvider({
    res,
    anthropicReq,
    openaiReq,
    provider,
    deps,
    reqStart,
    cacheKey,
  })
}

async function sendToProvider(args: {
  res: ServerResponse
  anthropicReq: AnthropicRequest
  openaiReq: ReturnType<typeof translateRequest>
  provider: ProviderConfig
  deps: MessagesHandlerDeps
  reqStart: number
  cacheKey: string | null
}): Promise<void> {
  const { res, anthropicReq, openaiReq, provider, deps, reqStart, cacheKey } = args
  const { config, logger, dispatcher } = deps
  const isStreaming = anthropicReq.stream === true

  const targetUrl = new URL(provider.baseUrl)
  const basePath = targetUrl.pathname.replace(/\/$/, '')

  const retryOptions: RetryOptions = {
    maxRetries: config.maxRetries,
    baseDelayMs: config.retryDelayMs,
    backoffMultiplier: config.retryBackoffMultiplier,
    maxDelayMs: config.retryMaxDelayMs,
  }

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retryOptions.maxRetries; attempt++) {
    const ac = new AbortController()
    const connTimer = setTimeout(
      () => ac.abort(new Error(`Connection timeout after ${config.connectionTimeout}ms`)),
      config.connectionTimeout,
    )
    const reqTimer = setTimeout(
      () => ac.abort(new Error(`Request timeout after ${config.requestTimeout}ms`)),
      config.requestTimeout,
    )

    try {
      const targetRes = await dispatcher.request({
        origin: targetUrl.origin,
        method: 'POST',
        path: `${basePath}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          'Accept-Encoding': 'gzip, br',
        },
        body: JSON.stringify(openaiReq),
        signal: ac.signal,
      })

      clearTimeout(connTimer)

      if (targetRes.statusCode >= 400) {
        // Lee el body como buffer primero para manejar posibles respuestas comprimidas
        const errorBuffer = await targetRes.body.arrayBuffer()
        const bufferBytes = errorBuffer instanceof Uint8Array ? errorBuffer : new Uint8Array(errorBuffer)

        // Detecta si la respuesta está comprimida (gzip: 0x1f 0x8b, br: 'BR' en header)
        const isGzip = bufferBytes.length >= 2 && bufferBytes[0] === 0x1f && bufferBytes[1] === 0x8b
        const isBrotli = bufferBytes.length >= 4 &&
          String.fromCharCode(bufferBytes[0], bufferBytes[1], bufferBytes[2], bufferBytes[3]) === 'BR'

        let errorBody: string
        if (isGzip || isBrotli) {
          // La respuesta está comprimida, no podemos decodificarla fácilmente
          errorBody = `[Compressed error response] ${isGzip ? 'gzip' : 'brotli'} (${bufferBytes.length} bytes)`
        } else {
          // Intenta decodificar como UTF-8
          errorBody = new TextDecoder('utf-8', { fatal: false }).decode(bufferBytes)
          // Si la decodificación produce caracteres de control binarios, marca como binario
          // eslint-disable-next-line no-control-regex
          const hasBinaryChars = /[\x00-\x08\x0B-\x1F\x7F]/.test(errorBody)
          if (errorBody.charCodeAt(0) > 127 && hasBinaryChars) {
            errorBody = `[Binary error response] (${bufferBytes.length} bytes)`
          }
        }
        lastError = new Error(`Provider ${targetRes.statusCode}: ${errorBody}`)

        if (shouldRetry(targetRes.statusCode, lastError) && attempt < retryOptions.maxRetries) {
          const delay = calculateDelay(attempt, retryOptions)
          metrics.retries++
          logger.warn('Retrying after provider error', {
            attempt,
            status: targetRes.statusCode,
            delay_ms: Math.round(delay),
          })
          clearTimeout(reqTimer)
          await sleep(delay)
          continue
        }

        clearTimeout(reqTimer)
        const errType: ErrorType = targetRes.statusCode >= 500 ? 'provider_5xx' : 'provider_4xx'
        metrics.recordError(errType)
        logger.error('Provider error', { status: targetRes.statusCode, body: errorBody })
        sendJson(
          res,
          targetRes.statusCode,
          buildErrorResponse(anthropicReq.model, `Provider ${targetRes.statusCode}: ${errorBody}`),
        )
        return
      }

      if (attempt > 1) logger.info('Retry succeeded', { attempt })

      if (isStreaming) {
        await handleStreamingResponse(
          targetRes,
          res,
          anthropicReq.model,
          reqTimer,
          reqStart,
          deps,
          ac,
        )
      } else {
        await handleNormalResponse(targetRes, res, anthropicReq.model, reqTimer, deps, cacheKey)
        logger.info('Request completed', { latency_ms: Date.now() - reqStart })
      }
      return
    } catch (err) {
      clearTimeout(connTimer)
      clearTimeout(reqTimer)

      const message = err instanceof Error ? err.message : String(err)
      lastError = err instanceof Error ? err : new Error(message)
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 0

      if (shouldRetry(statusCode, lastError) && attempt < retryOptions.maxRetries) {
        const delay = calculateDelay(attempt, retryOptions)
        metrics.retries++
        logger.warn('Retrying after connection error', {
          attempt,
          error: message,
          delay_ms: Math.round(delay),
        })
        await sleep(delay)
        continue
      }

      const errType: ErrorType = message.toLowerCase().includes('timeout')
        ? 'timeout'
        : 'connection_error'
      metrics.recordError(errType)
      logger.error('Connection error', { attempt, error: message })
      sendJson(res, 502, buildErrorResponse(anthropicReq.model, `Connection error: ${message}`))
      return
    }
  }

  if (!res.headersSent) {
    metrics.recordError('unknown')
    const errMsg = lastError?.message ?? 'All retry attempts exhausted'
    logger.error('All retries exhausted', { attempts: retryOptions.maxRetries })
    sendJson(
      res,
      502,
      buildErrorResponse(
        anthropicReq.model,
        `All ${retryOptions.maxRetries} attempts failed: ${errMsg}`,
      ),
    )
  }
}

async function handleNormalResponse(
  targetRes: Dispatcher.ResponseData,
  res: ServerResponse,
  requestModel: string,
  reqTimer: ReturnType<typeof setTimeout>,
  deps: MessagesHandlerDeps,
  cacheKey: string | null,
): Promise<void> {
  const body = await targetRes.body.text()
  clearTimeout(reqTimer)

  let openaiResp: OpenAIResponse
  try {
    openaiResp = JSON.parse(body)
  } catch {
    metrics.recordError('parse_error')
    // Si el body parece binario/comprimido, informa mejor el error
    const isBinary = body.charCodeAt(0) > 127
    const errorMsg = isBinary
      ? `Invalid response from provider (possibly compressed): ${body.slice(0, 50)}...`
      : `Invalid JSON from provider: ${body.slice(0, 200)}`
    sendJson(res, 502, buildErrorResponse(requestModel, errorMsg))
    return
  }

  const tokensIn = openaiResp.usage?.prompt_tokens ?? 0
  const tokensOut = openaiResp.usage?.completion_tokens ?? 0
  metrics.totalTokensIn += tokensIn
  metrics.totalTokensOut += tokensOut

  deps.logger.info('Response received', { tokens_in: tokensIn, tokens_out: tokensOut })

  const anthropicResp = translateResponse(openaiResp, requestModel)

  if (cacheKey && deps.cache) {
    deps.cache.set(cacheKey, anthropicResp)
  }

  sendJson(res, 200, anthropicResp)
}

async function handleStreamingResponse(
  targetRes: Dispatcher.ResponseData,
  res: ServerResponse,
  requestModel: string,
  reqTimer: ReturnType<typeof setTimeout>,
  reqStart: number,
  deps: MessagesHandlerDeps,
  ac: AbortController,
): Promise<void> {
  const { config, logger } = deps

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const state = createStreamState(requestModel)
  await sendMessageStart(res, state)

  const decoder = new TextDecoder()
  let buffer = ''
  let chunkCount = 0
  let ttfbRecorded = false
  let isStreamActive = true
  let currentTimer = reqTimer

  // Si el cliente cierra la conexión, abortamos también la request al provider
  // para no seguir consumiendo bandwidth/tokens en una respuesta huérfana.
  const onClientClose = (): void => {
    if (isStreamActive) {
      isStreamActive = false
      ac.abort(new Error('Client disconnected'))
    }
  }
  res.once('close', onClientClose)

  const refreshTimeout = (): void => {
    clearTimeout(currentTimer)
    currentTimer = setTimeout(() => {
      if (isStreamActive && !res.writableEnded) {
        logger.error('Stream idle timeout', { ms: config.requestTimeout })
        // Abortamos la request al provider antes de cerrar el cliente,
        // para liberar el socket en vez de quedarnos en for-await colgado.
        ac.abort(new Error(`Stream idle timeout after ${config.requestTimeout}ms`))
        res.end()
      }
    }, config.requestTimeout)
  }

  try {
    for await (const chunk of targetRes.body) {
      chunkCount++
      if (!ttfbRecorded) {
        ttfbRecorded = true
        metrics.recordTtfb(Date.now() - reqStart)
      }
      refreshTimeout()

      try {
        buffer += decoder.decode(chunk as Buffer, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === 'data: [DONE]') {
            isStreamActive = false
            break
          }
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6)
            try {
              const chunkData: OpenAIStreamChunk = JSON.parse(jsonStr)
              await processStreamChunk(res, chunkData, state)
            } catch {
              logger.warn('Malformed stream chunk', { chunk_n: chunkCount })
            }
          }
        }
      } catch (chunkErr) {
        logger.warn('Error processing chunk', {
          chunk_n: chunkCount,
          error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
        })
      }
    }
  } catch (err) {
    isStreamActive = false
    const errMsg = err instanceof Error ? err.message : String(err)
    metrics.recordError('connection_error')
    logger.error('Fatal stream error', { chunks: chunkCount, error: errMsg })
    clearTimeout(currentTimer)
    res.removeListener('close', onClientClose)
    if (!res.writableEnded) {
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'stream_error', message: errMsg } })}\n\n`,
        )
      } catch {
        /* ignore */
      }
      res.end()
    }
    return
  }

  isStreamActive = false
  clearTimeout(currentTimer)
  res.removeListener('close', onClientClose)

  metrics.totalTokensIn += state.inputTokens
  metrics.totalTokensOut += state.outputTokens

  logger.info('Stream completed', {
    chunks: chunkCount,
    tokens_in: state.inputTokens,
    tokens_out: state.outputTokens,
    latency_ms: Date.now() - reqStart,
  })

  if (!res.writableEnded) {
    res.end()
  }
}

/**
 * Si el destino es Anthropic real, reenvía sin traducir.
 * El cliente espera respuestas Anthropic; el provider responde Anthropic; passthrough directo.
 */
async function passthroughAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  anthropicReq: AnthropicRequest,
  provider: ProviderConfig,
  deps: MessagesHandlerDeps,
  reqStart: number,
): Promise<void> {
  const { config, logger, dispatcher } = deps
  const targetUrl = new URL(provider.baseUrl)
  const basePath = targetUrl.pathname.replace(/\/$/, '')

  // Si el modelo cambió por router, reescribimos en el body
  let outBody = body
  if (provider.model && provider.model !== anthropicReq.model) {
    outBody = JSON.stringify({ ...anthropicReq, model: provider.model })
  }

  // Propagar headers anthropic-* del cliente. Claude Code envía
  // `anthropic-beta` para activar features (context_management, prompt-caching,
  // computer-use, etc.) que aparecen como campos en el body. Sin este header,
  // Anthropic rechaza esos campos como "Extra inputs are not permitted".
  const forwardHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': (req.headers['anthropic-version'] as string) ?? '2023-06-01',
  }
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (
      (lower.startsWith('anthropic-') || lower === 'x-stainless-helper-method') &&
      lower !== 'anthropic-version' &&
      typeof value === 'string'
    ) {
      forwardHeaders[lower] = value
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('Request timeout')), config.requestTimeout)

  try {
    const targetRes = await dispatcher.request({
      origin: targetUrl.origin,
      method: 'POST',
      path: `${basePath}/v1/messages`,
      headers: forwardHeaders,
      body: outBody,
      signal: ac.signal,
    })

    if (targetRes.statusCode >= 400) {
      const errBody = await targetRes.body.text()
      clearTimeout(timer)
      const errType: ErrorType = targetRes.statusCode >= 500 ? 'provider_5xx' : 'provider_4xx'
      metrics.recordError(errType)
      logger.error('Anthropic passthrough error', {
        status: targetRes.statusCode,
        body: errBody.slice(0, 500),
      })
      res.writeHead(targetRes.statusCode, { 'Content-Type': 'application/json' })
      res.end(errBody)
      return
    }

    res.writeHead(targetRes.statusCode, {
      'Content-Type': (targetRes.headers['content-type'] as string) ?? 'application/json',
    })
    for await (const chunk of targetRes.body) {
      res.write(chunk)
    }
    res.end()
    clearTimeout(timer)
    logger.info('Passthrough completed', { latency_ms: Date.now() - reqStart })
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    metrics.recordError('connection_error')
    logger.error('Passthrough connection error', { error: msg })
    if (!res.headersSent) {
      sendJson(res, 502, { error: { type: 'connection_error', message: msg } })
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks = bufferPool.acquire()
    let totalSize = 0

    const cleanup = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
    }

    const onData = (chunk: Buffer): void => {
      totalSize += chunk.length
      if (totalSize > maxBytes) {
        cleanup()
        bufferPool.release(chunks)
        req.destroy()
        reject(new Error(`Request body too large (>${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    }

    const onEnd = (): void => {
      cleanup()
      try {
        const result = Buffer.concat(chunks).toString('utf8')
        bufferPool.release(chunks)
        resolve(result)
      } catch (err) {
        bufferPool.release(chunks)
        reject(err)
      }
    }

    const onError = (err: Error): void => {
      cleanup()
      bufferPool.release(chunks)
      reject(err)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}
