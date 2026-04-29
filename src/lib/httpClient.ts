/**
 * Crea dispatchers undici (Agent o Pool) para reusar conexiones.
 */

import { Agent, Pool, type Dispatcher } from 'undici'

export interface DispatcherOptions {
  origin: string
  maxSockets: number
  keepAlive: boolean
  allowH2: boolean
  keepAliveTimeoutMs?: number
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const keepAliveTimeout = opts.keepAliveTimeoutMs ?? 60_000

  if (opts.allowH2) {
    return new Pool(opts.origin, {
      connections: opts.maxSockets,
      keepAliveTimeout,
      keepAliveMaxTimeout: keepAliveTimeout,
      connect: { rejectUnauthorized: true, allowH2: true },
    })
  }

  return new Agent({
    connect: { keepAlive: opts.keepAlive, rejectUnauthorized: true },
    connections: opts.maxSockets,
    keepAliveTimeout,
    keepAliveMaxTimeout: keepAliveTimeout,
  })
}
