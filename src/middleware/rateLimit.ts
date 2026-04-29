/**
 * Rate limiting in-memory por IP, ventana fija.
 */

import type { IncomingMessage } from 'node:http'

interface Entry {
  count: number
  windowStart: number
}

export interface RateLimitConfig {
  max: number
  windowMs: number
}

export class RateLimiter {
  private map = new Map<string, Entry>()
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(private readonly config: RateLimitConfig) {
    if (config.max > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000)
      this.cleanupInterval.unref()
    }
  }

  check(ip: string): { allowed: boolean; retryAfterSec: number } {
    if (this.config.max === 0) return { allowed: true, retryAfterSec: 0 }

    const now = Date.now()
    const entry = this.map.get(ip)

    if (!entry || now - entry.windowStart > this.config.windowMs) {
      this.map.set(ip, { count: 1, windowStart: now })
      return { allowed: true, retryAfterSec: 0 }
    }

    entry.count++
    if (entry.count <= this.config.max) {
      return { allowed: true, retryAfterSec: 0 }
    }

    const retryAfterMs = this.config.windowMs - (now - entry.windowStart)
    return { allowed: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.map) {
      if (now - entry.windowStart > this.config.windowMs) {
        this.map.delete(ip)
      }
    }
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}
