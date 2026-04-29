import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../../src/middleware/rateLimit.js'

describe('RateLimiter', () => {
  it('allows requests when max=0 (disabled)', () => {
    const rl = new RateLimiter({ max: 0, windowMs: 1000 })
    for (let i = 0; i < 100; i++) {
      assert.equal(rl.check('1.2.3.4').allowed, true)
    }
    rl.stop()
  })

  it('limits to max per window', () => {
    const rl = new RateLimiter({ max: 3, windowMs: 60_000 })
    assert.equal(rl.check('ip1').allowed, true)
    assert.equal(rl.check('ip1').allowed, true)
    assert.equal(rl.check('ip1').allowed, true)
    assert.equal(rl.check('ip1').allowed, false)
    rl.stop()
  })

  it('tracks IPs independently', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 60_000 })
    assert.equal(rl.check('ip1').allowed, true)
    assert.equal(rl.check('ip2').allowed, true)
    assert.equal(rl.check('ip1').allowed, false)
    rl.stop()
  })

  it('returns retryAfterSec when blocked', () => {
    const rl = new RateLimiter({ max: 1, windowMs: 30_000 })
    rl.check('ip1')
    const blocked = rl.check('ip1')
    assert.equal(blocked.allowed, false)
    assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 30)
    rl.stop()
  })
})
