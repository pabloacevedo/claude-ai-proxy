/**
 * Endpoint /health: status simple compatible con load balancers.
 */

import type { ServerResponse } from 'node:http'
import { metrics } from '../middleware/metrics.js'

export function handleHealth(res: ServerResponse): void {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      status: 'ok',
      uptime_sec: uptime,
      version: process.env.npm_package_version ?? 'unknown',
    }),
  )
}
