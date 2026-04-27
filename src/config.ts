import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProxyConfig } from './types.js'

/**
 * Carga variables de entorno desde .env (sin dependencias externas)
 */
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
      // No sobreescribir variables ya definidas en el entorno
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
    console.log('✅ Archivo .env cargado correctamente')
  } catch {
    console.warn('⚠️  No se encontró archivo .env, usando variables de entorno del sistema')
  }
}

// Cargar .env ANTES de leer la configuración
loadEnvFile()

export function loadConfig(): ProxyConfig {
  const port = parseInt(process.env.PROXY_PORT || '8082', 10)
  const targetBaseUrl = process.env.TARGET_BASE_URL || 'https://api.openai.com'
  const targetApiKey = process.env.TARGET_API_KEY || ''
  const targetModel = process.env.TARGET_MODEL || 'gpt-4o'
  const logRequests = process.env.LOG_REQUESTS === 'true'

  // Timeouts (en ms)
  const connectionTimeout = parseInt(process.env.CONNECTION_TIMEOUT || '30000', 10)
  const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT || '120000', 10)

  // Pool settings
  const maxSockets = parseInt(process.env.MAX_SOCKETS || '10', 10)
  const keepAlive = process.env.KEEP_ALIVE !== 'false' // default true
  const allowH2 = process.env.ALLOW_H2 === 'true' // default false (some providers have issues)

  // Retry settings
  const maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10)
  const retryDelayMs = parseInt(process.env.RETRY_DELAY_MS || '1000', 10)
  const retryBackoffMultiplier = parseInt(process.env.RETRY_BACKOFF_MULTIPLIER || '2', 10)
  const retryMaxDelayMs = parseInt(process.env.RETRY_MAX_DELAY_MS || '30000', 10)

  if (!targetApiKey) {
    console.warn(
      '⚠️  TARGET_API_KEY no está configurada. Las peticiones al proveedor destino fallarán.',
    )
  }

  return {
    port,
    targetBaseUrl,
    targetApiKey,
    targetModel,
    logRequests,
    connectionTimeout,
    requestTimeout,
    maxSockets,
    keepAlive,
    allowH2,
    maxRetries,
    retryDelayMs,
    retryBackoffMultiplier,
    retryMaxDelayMs,
  }
}

// Mapeo de modelos Anthropic → modelo destino
// Puedes personalizar esto para mapear modelos específicos
const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': '',    // se usa TARGET_MODEL
  'claude-opus-4-20250514': '',
  'claude-3-5-haiku-20241022': '',
  'claude-3-5-sonnet-20241022': '',
  'claude-3-7-sonnet-20250219': '',
}

export function mapModel(anthropicModel: string, defaultModel: string): string {
  const mapped = MODEL_MAP[anthropicModel]
  if (mapped) return mapped
  return defaultModel
}
