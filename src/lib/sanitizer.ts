/**
 * Redacta credenciales en strings para evitar exponerlas en logs.
 *
 * Cubre patrones comunes: API keys de OpenAI, Anthropic, NVIDIA, Google,
 * Groq, OpenRouter, Bearer tokens, y headers Authorization.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens (cualquier longitud)
  [/Bearer\s+[A-Za-z0-9_\-./+=]{8,}/gi, 'Bearer [REDACTED]'],
  // Authorization header value
  [/("?[Aa]uthorization"?\s*[:=]\s*"?)[^"\s,}]+/g, '$1[REDACTED]'],
  // API key prefijos comunes
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/sk-or-v1-[A-Za-z0-9_-]{16,}/g, 'sk-or-v1-[REDACTED]'],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-[REDACTED]'],
  [/nvapi-[A-Za-z0-9_-]{16,}/g, 'nvapi-[REDACTED]'],
  [/gsk_[A-Za-z0-9_-]{16,}/g, 'gsk_[REDACTED]'],
  [/AIza[A-Za-z0-9_-]{30,}/g, 'AIza[REDACTED]'],
  // Campos JSON con nombres sospechosos
  [/("(?:api[_-]?key|apikey|access[_-]?token|secret|password)"\s*:\s*")[^"]+/gi, '$1[REDACTED]'],
]

export function sanitize(input: string): string {
  let out = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') return sanitize(obj)
  if (Array.isArray(obj)) return obj.map(sanitizeObject)
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const lowerKey = k.toLowerCase()
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey === 'authorization'
      ) {
        result[k] = '[REDACTED]'
      } else {
        result[k] = sanitizeObject(v)
      }
    }
    return result
  }
  return obj
}
