/**
 * Pool simple de arrays de Buffer para reducir GC pressure
 * cuando se leen muchos request bodies en alta carga.
 */

const pool: Buffer[][] = []
const MAX_POOL_SIZE = 100

export function acquire(): Buffer[] {
  return pool.pop() ?? []
}

export function release(chunks: Buffer[]): void {
  if (pool.length < MAX_POOL_SIZE) {
    chunks.length = 0
    pool.push(chunks)
  }
}
