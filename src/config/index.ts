/**
 * Carga y centraliza la configuración del proxy.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CorsConfig } from '../middleware/cors.js'
import type { LogLevel } from '../lib/logger.js'
import { buildRouter, type ProviderRouter } from './providers.js'

export interface ProxyConfig {
  port: number
  logLevel: LogLevel
  logFormat: 'pretty' | 'json'
  logRedact: boolean
  // Conexión
  connectionTimeout: number
  requestTimeout: number
  maxSockets: number
  keepAlive: boolean
  allowH2: boolean
  // Retry
  maxRetries: number
  retryDelayMs: number
  retryBackoffMultiplier: number
  retryMaxDelayMs: number
  // Limits
  maxBodyBytes: number
  shutdownTimeoutMs: number
  // Rate limit
  rateLimitMax: number
  rateLimitWindowMs: number
  // CORS
  cors: CorsConfig
  // Cache
  cacheEnabled: boolean
  cacheTtlMs: number
  cacheMaxSize: number
  // Routing
  router: ProviderRouter
}

function loadEnvFile(): void {
  try {
    const envPath = resolve(process.cwd(), '.env')
    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  } catch {
    // .env opcional
  }
}

function parseCorsOrigins(value: string | undefined): string[] | '*' {
  if (!value || value === '*') return '*'
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

export function loadConfig(): ProxyConfig {
  loadEnvFile()
  const env = process.env

  return {
    port: parseInt10(env.PROXY_PORT, 8082),
    logLevel: (env.LOG_LEVEL as LogLevel) || (env.LOG_REQUESTS === 'true' ? 'debug' : 'info'),
    logFormat: env.LOG_FORMAT === 'json' ? 'json' : 'pretty',
    logRedact: env.LOG_REDACT !== 'false',

    connectionTimeout: parseInt10(env.CONNECTION_TIMEOUT, 30_000),
    requestTimeout: parseInt10(env.REQUEST_TIMEOUT, 120_000),
    maxSockets: parseInt10(env.MAX_SOCKETS, 10),
    keepAlive: env.KEEP_ALIVE !== 'false',
    allowH2: env.ALLOW_H2 === 'true',

    maxRetries: parseInt10(env.MAX_RETRIES, 3),
    retryDelayMs: parseInt10(env.RETRY_DELAY_MS, 1_000),
    retryBackoffMultiplier: parseInt10(env.RETRY_BACKOFF_MULTIPLIER, 2),
    retryMaxDelayMs: parseInt10(env.RETRY_MAX_DELAY_MS, 30_000),

    maxBodyBytes: parseInt10(env.MAX_BODY_SIZE, 10 * 1024 * 1024),
    shutdownTimeoutMs: parseInt10(env.SHUTDOWN_TIMEOUT_MS, 30_000),

    rateLimitMax: parseInt10(env.RATE_LIMIT_MAX, 0),
    rateLimitWindowMs: parseInt10(env.RATE_LIMIT_WINDOW_MS, 60_000),

    cors: {
      origins: parseCorsOrigins(env.CORS_ORIGINS),
      allowedHeaders: (
        env.CORS_ALLOWED_HEADERS || 'Content-Type, Authorization, x-api-key, anthropic-version'
      )
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      allowedMethods: ['POST', 'GET', 'OPTIONS'],
    },

    cacheEnabled: env.CACHE_ENABLED === 'true',
    cacheTtlMs: parseInt10(env.CACHE_TTL_MS, 60_000),
    cacheMaxSize: parseInt10(env.CACHE_MAX_SIZE, 100),

    router: buildRouter(env),
  }
}
