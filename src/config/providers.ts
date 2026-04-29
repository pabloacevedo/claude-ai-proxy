/**
 * Configuración de proveedores y mapeo de modelos.
 *
 * Soporta tres modos:
 *   - Single provider: usa TARGET_BASE_URL/API_KEY/MODEL (modo legacy)
 *   - Multi-provider via PROVIDERS_JSON: routing por modelo a varios providers
 *   - MODEL_MAP_JSON: alias simple de modelos Anthropic → modelo destino
 */

export interface ProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  // Si es true, no se traduce el formato (passthrough Anthropic→Anthropic)
  passthrough?: boolean
}

export interface ProviderRouter {
  resolve(anthropicModel: string): ProviderConfig
  defaultProvider(): ProviderConfig
}

interface RawProviderEntry {
  name?: string
  baseUrl: string
  apiKey: string
  model: string
  passthrough?: boolean
}

function isAnthropicEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host.endsWith('anthropic.com')
  } catch {
    return false
  }
}

/**
 * Valida que la URL sea sintácticamente correcta y use http(s).
 * Lanza con mensaje claro para fallar rápido en startup.
 */
function assertValidUrl(url: string, where: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL in ${where}: "${url}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL in ${where} must use http(s): "${url}"`)
  }
}

export function buildRouter(env: Record<string, string | undefined>): ProviderRouter {
  const baseUrl = env.TARGET_BASE_URL || 'https://api.openai.com'
  assertValidUrl(baseUrl, 'TARGET_BASE_URL')

  const defaultProvider: ProviderConfig = {
    name: 'default',
    baseUrl,
    apiKey: env.TARGET_API_KEY || '',
    model: env.TARGET_MODEL || 'gpt-4o',
    passthrough: env.TARGET_PASSTHROUGH === 'true' || isAnthropicEndpoint(baseUrl),
  }

  // MODEL_MAP_JSON: { "claude-sonnet-4-20250514": "gpt-4o" }
  // Solo cambia el modelo, no el provider
  const modelAliasMap = new Map<string, string>()
  if (env.MODEL_MAP_JSON) {
    try {
      const parsed = JSON.parse(env.MODEL_MAP_JSON) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.length > 0) {
          modelAliasMap.set(k, v)
        }
      }
    } catch {
      // ignorar JSON inválido, fallback a defaultProvider
    }
  }

  // PROVIDERS_JSON: { "claude-opus-4-20250514": { baseUrl, apiKey, model } }
  // Routing por modelo a providers distintos.
  const providerRouteMap = new Map<string, ProviderConfig>()
  if (env.PROVIDERS_JSON) {
    try {
      const parsed = JSON.parse(env.PROVIDERS_JSON) as Record<string, RawProviderEntry>
      for (const [anthropicModel, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object') continue
        if (!entry.baseUrl || !entry.apiKey || !entry.model) continue
        assertValidUrl(entry.baseUrl, `PROVIDERS_JSON["${anthropicModel}"].baseUrl`)
        providerRouteMap.set(anthropicModel, {
          name: entry.name ?? anthropicModel,
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          model: entry.model,
          passthrough: entry.passthrough ?? isAnthropicEndpoint(entry.baseUrl),
        })
      }
    } catch (err) {
      // Re-lanzar errores de validación de URL; ignorar JSON inválido.
      if (err instanceof Error && err.message.startsWith('Invalid URL')) throw err
      if (err instanceof Error && err.message.includes('must use http')) throw err
    }
  }

  return {
    resolve(anthropicModel: string): ProviderConfig {
      const routed = providerRouteMap.get(anthropicModel)
      if (routed) return routed

      const aliasModel = modelAliasMap.get(anthropicModel)
      if (aliasModel) {
        return { ...defaultProvider, model: aliasModel }
      }

      return defaultProvider
    },
    defaultProvider(): ProviderConfig {
      return defaultProvider
    },
  }
}
