/**
 * Genera un request ID corto para correlacionar logs.
 */

import { randomBytes } from 'node:crypto'

export function generateRequestId(): string {
  return randomBytes(6).toString('hex')
}
