import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateAnthropicRequest } from '../../src/validators/anthropicRequest.js'

describe('validateAnthropicRequest', () => {
  it('accepts a minimal valid request', () => {
    const result = validateAnthropicRequest({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    })
    assert.equal(result.ok, true)
  })

  it('rejects non-object body', () => {
    const result = validateAnthropicRequest('not-an-object')
    assert.equal(result.ok, false)
  })

  it('rejects missing model', () => {
    const result = validateAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects empty messages', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects invalid role', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'system', content: 'hi' }],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects negative max_tokens', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: -1,
    })
    assert.equal(result.ok, false)
  })

  it('accepts content as array of blocks', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, true)
  })

  it('rejects unknown block type', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'video', data: 'abc' }],
        },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('accepts tools', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tools: [{ name: 'foo', input_schema: { type: 'object' } }],
    })
    assert.equal(result.ok, true)
  })

  it('rejects tool without input_schema', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tools: [{ name: 'foo' }],
    })
    assert.equal(result.ok, false)
  })

  it('rejects image block without source (regression)', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'image' }] }],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects image block with malformed source', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] }],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects image block with wrong source.type', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', media_type: 'image/png', data: 'abc' } },
          ],
        },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
    assert.ok((result as { error: string }).error.includes('source.type="base64"'))
  })

  it('rejects image block without source.type', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { media_type: 'image/png', data: 'abc' } }],
        },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('accepts image block with cache_control', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, true)
  })

  it('rejects tool_use without id or name', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', input: {} }] },
      ],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })

  it('rejects tool_result without tool_use_id', () => {
    const result = validateAnthropicRequest({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'r' }] }],
      max_tokens: 100,
    })
    assert.equal(result.ok, false)
  })
})
