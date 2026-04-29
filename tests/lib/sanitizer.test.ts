import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitize, sanitizeObject } from '../../src/lib/sanitizer.js'

describe('sanitize', () => {
  it('redacts Bearer tokens', () => {
    const out = sanitize('Authorization: Bearer sk-abc123XYZ-456_789longenoughtoken')
    assert.match(out, /\[REDACTED\]/)
    assert.doesNotMatch(out, /sk-abc123/)
  })

  it('redacts NVIDIA API keys', () => {
    const out = sanitize('using nvapi-r9HqMrzqsB4iaq_pvx1FYhvE9XX5O-e7MHelN11ko')
    assert.match(out, /nvapi-\[REDACTED\]/)
  })

  it('redacts OpenAI keys', () => {
    const out = sanitize('key=sk-proj-abcdef1234567890ABCDEF')
    assert.match(out, /sk-\[REDACTED\]/)
  })

  it('redacts Groq keys', () => {
    const out = sanitize('Authorization: Bearer gsk_1234567890abcdefghijklmnop')
    assert.match(out, /\[REDACTED\]/)
  })

  it('redacts Google API keys', () => {
    const out = sanitize('AIzaSyABCDEF1234567890_abcdefghijklmnop')
    assert.match(out, /AIza\[REDACTED\]/)
  })

  it('redacts JSON api_key fields', () => {
    const out = sanitize('{"api_key":"super-secret-value-12345"}')
    assert.match(out, /\[REDACTED\]/)
    assert.doesNotMatch(out, /super-secret/)
  })

  it('leaves regular text untouched', () => {
    assert.equal(sanitize('hello world'), 'hello world')
  })
})

describe('sanitizeObject', () => {
  it('redacts keys named api_key', () => {
    const result = sanitizeObject({ api_key: 'secret', name: 'visible' }) as Record<string, unknown>
    assert.equal(result.api_key, '[REDACTED]')
    assert.equal(result.name, 'visible')
  })

  it('redacts nested authorization', () => {
    const result = sanitizeObject({
      headers: { authorization: 'Bearer secret', accept: 'json' },
    }) as { headers: Record<string, unknown> }
    assert.equal(result.headers.authorization, '[REDACTED]')
    assert.equal(result.headers.accept, 'json')
  })

  it('handles arrays', () => {
    const result = sanitizeObject([{ token: 'abc' }, { id: 1 }]) as Array<Record<string, unknown>>
    assert.equal(result[0]!.token, '[REDACTED]')
    assert.equal(result[1]!.id, 1)
  })
})
