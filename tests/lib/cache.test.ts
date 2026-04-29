import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LRUCache, hashRequest } from '../../src/lib/cache.js'

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string>(10, 60_000)
    cache.set('a', 'value')
    assert.equal(cache.get('a'), 'value')
  })

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string>(10, 60_000)
    assert.equal(cache.get('missing'), undefined)
  })

  it('evicts oldest when full', () => {
    const cache = new LRUCache<number>(2, 60_000)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('b'), 2)
    assert.equal(cache.get('c'), 3)
  })

  it('expires entries after TTL', async () => {
    const cache = new LRUCache<string>(10, 10)
    cache.set('a', 'value')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(cache.get('a'), undefined)
  })

  it('refreshes LRU position on access', () => {
    const cache = new LRUCache<number>(2, 60_000)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // a se vuelve más reciente
    cache.set('c', 3) // debería evictar b, no a
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('c'), 3)
  })
})

describe('hashRequest', () => {
  it('returns same hash for same input', () => {
    const a = hashRequest({ messages: [{ role: 'user', content: 'hi' }] })
    const b = hashRequest({ messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(a, b)
  })

  it('returns different hash for different input', () => {
    const a = hashRequest({ messages: [{ role: 'user', content: 'hi' }] })
    const b = hashRequest({ messages: [{ role: 'user', content: 'bye' }] })
    assert.notEqual(a, b)
  })

  it('produces 32-char hex string', () => {
    const h = hashRequest({ x: 1 })
    assert.equal(h.length, 32)
    assert.match(h, /^[a-f0-9]+$/)
  })
})
