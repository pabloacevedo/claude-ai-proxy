/**
 * CORS configurable. Si CORS_ORIGINS=* permite cualquier origen,
 * si no, se valida contra el allowlist (separado por comas).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface CorsConfig {
  origins: string[] | '*'
  allowedHeaders: string[]
  allowedMethods: string[]
}

export function applyCors(req: IncomingMessage, res: ServerResponse, cfg: CorsConfig): void {
  const requestOrigin = req.headers.origin

  if (cfg.origins === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else if (requestOrigin && cfg.origins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    res.setHeader('Vary', 'Origin')
  }

  res.setHeader('Access-Control-Allow-Methods', cfg.allowedMethods.join(', '))
  res.setHeader('Access-Control-Allow-Headers', cfg.allowedHeaders.join(', '))
}
