import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDelay, shouldRetry } from '../../src/lib/retry.js'

describe('shouldRetry', () => {
  it('retries 5xx errors', () => {
    assert.equal(shouldRetry(500, new Error('boom')), true)
    assert.equal(shouldRetry(502, new Error('boom')), true)
    assert.equal(shouldRetry(503, new Error('boom')), true)
  })

  it('retries 429 (rate limit)', () => {
    assert.equal(shouldRetry(429, new Error('rate limit')), true)
  })

  it('does not retry 4xx (except 429)', () => {
    assert.equal(shouldRetry(400, new Error('bad')), false)
    assert.equal(shouldRetry(401, new Error('unauth')), false)
    assert.equal(shouldRetry(404, new Error('not found')), false)
  })

  it('retries network errors (status=0) with timeout message', () => {
    assert.equal(shouldRetry(0, new Error('Connection timeout')), true)
  })

  it('retries on ECONNRESET', () => {
    assert.equal(shouldRetry(0, new Error('socket hang up ECONNRESET')), true)
  })
})

describe('calculateDelay', () => {
  const opts = {
    maxRetries: 5,
    baseDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 30000,
  }

  it('grows exponentially with attempt', () => {
    const d1 = calculateDelay(1, opts)
    const d2 = calculateDelay(2, opts)
    const d3 = calculateDelay(3, opts)
    // jitter ±20% sobre 1000, 2000, 4000
    assert.ok(d1 >= 800 && d1 <= 1200)
    assert.ok(d2 >= 1600 && d2 <= 2400)
    assert.ok(d3 >= 3200 && d3 <= 4800)
  })

  it('caps at maxDelayMs', () => {
    const d = calculateDelay(20, opts)
    assert.ok(d <= opts.maxDelayMs)
  })
})
