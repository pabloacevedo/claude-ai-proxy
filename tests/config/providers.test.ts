import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouter } from '../../src/config/providers.js'

describe('buildRouter', () => {
  it('returns default provider when no overrides', () => {
    const router = buildRouter({
      TARGET_BASE_URL: 'https://api.openai.com',
      TARGET_API_KEY: 'sk-test',
      TARGET_MODEL: 'gpt-4o',
    })
    const p = router.resolve('claude-3-5-sonnet-20241022')
    assert.equal(p.baseUrl, 'https://api.openai.com')
    assert.equal(p.model, 'gpt-4o')
  })

  it('detects Anthropic endpoint as passthrough', () => {
    const router = buildRouter({
      TARGET_BASE_URL: 'https://api.anthropic.com',
      TARGET_API_KEY: 'sk-ant',
      TARGET_MODEL: 'claude-3-5-sonnet-20241022',
    })
    assert.equal(router.defaultProvider().passthrough, true)
  })

  it('uses MODEL_MAP_JSON aliases', () => {
    const router = buildRouter({
      TARGET_BASE_URL: 'https://api.openai.com',
      TARGET_API_KEY: 'sk-test',
      TARGET_MODEL: 'gpt-4o',
      MODEL_MAP_JSON: '{"claude-opus-4-20250514":"gpt-4-turbo"}',
    })
    assert.equal(router.resolve('claude-opus-4-20250514').model, 'gpt-4-turbo')
    assert.equal(router.resolve('claude-3-5-sonnet-20241022').model, 'gpt-4o')
  })

  it('routes per-model with PROVIDERS_JSON', () => {
    const router = buildRouter({
      TARGET_BASE_URL: 'https://api.openai.com',
      TARGET_API_KEY: 'sk-default',
      TARGET_MODEL: 'gpt-4o',
      PROVIDERS_JSON: JSON.stringify({
        'claude-opus-4-20250514': {
          name: 'nvidia',
          baseUrl: 'https://integrate.api.nvidia.com',
          apiKey: 'nvapi-x',
          model: 'meta/llama-3.1-70b-instruct',
        },
      }),
    })
    const opus = router.resolve('claude-opus-4-20250514')
    assert.equal(opus.name, 'nvidia')
    assert.equal(opus.model, 'meta/llama-3.1-70b-instruct')
    const sonnet = router.resolve('claude-3-5-sonnet-20241022')
    assert.equal(sonnet.name, 'default')
  })

  it('survives malformed JSON env vars', () => {
    const router = buildRouter({
      TARGET_BASE_URL: 'https://api.openai.com',
      TARGET_API_KEY: 'sk',
      TARGET_MODEL: 'gpt-4o',
      MODEL_MAP_JSON: 'not-json',
      PROVIDERS_JSON: 'also-not-json',
    })
    const p = router.resolve('claude-3-5-sonnet-20241022')
    assert.equal(p.model, 'gpt-4o')
  })

  it('throws on invalid TARGET_BASE_URL', () => {
    assert.throws(
      () =>
        buildRouter({
          TARGET_BASE_URL: 'not-a-url',
          TARGET_API_KEY: 'sk',
          TARGET_MODEL: 'gpt-4o',
        }),
      /Invalid URL.*TARGET_BASE_URL/,
    )
  })

  it('throws on non-http protocol', () => {
    assert.throws(
      () =>
        buildRouter({
          TARGET_BASE_URL: 'ftp://example.com',
          TARGET_API_KEY: 'sk',
          TARGET_MODEL: 'gpt-4o',
        }),
      /must use http/,
    )
  })

  it('throws on invalid baseUrl in PROVIDERS_JSON', () => {
    assert.throws(
      () =>
        buildRouter({
          TARGET_BASE_URL: 'https://api.openai.com',
          TARGET_API_KEY: 'sk',
          TARGET_MODEL: 'gpt-4o',
          PROVIDERS_JSON: JSON.stringify({
            'claude-x': { baseUrl: 'bogus', apiKey: 'k', model: 'm' },
          }),
        }),
      /Invalid URL.*PROVIDERS_JSON/,
    )
  })
})
