/**
 * Cache LRU simple en memoria para respuestas no-streaming.
 *
 * La key se calcula con un hash SHA-256 truncado del payload normalizado
 * (model + messages + tools + temperature). Útil en desarrollo para evitar
 * llamadas repetidas a proveedores remotos durante iteración.
 */

import { createHash } from 'node:crypto'

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    // Refresca posición LRU
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }
}

export function hashRequest(payload: unknown): string {
  const normalized = JSON.stringify(payload)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}
