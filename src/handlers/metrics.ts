/**
 * Endpoint /metrics: texto plano (default) o JSON cuando Accept: application/json.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { metrics } from '../middleware/metrics.js'

export function handleMetrics(req: IncomingMessage, res: ServerResponse): void {
  const acceptsJson = (req.headers.accept ?? '').includes('application/json')
  if (acceptsJson) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(metrics.toJson()))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end(metrics.summary())
}
