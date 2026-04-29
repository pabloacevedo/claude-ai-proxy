import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildErrorResponse, translateResponse } from '../../src/translators/responseTranslator.js'
import type { OpenAIResponse } from '../../src/types.js'

describe('translateResponse', () => {
  it('translates a basic text response', () => {
    const resp: OpenAIResponse = {
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello there' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const out = translateResponse(resp, 'claude-3-5-sonnet-20241022')
    assert.equal(out.role, 'assistant')
    assert.equal(out.model, 'claude-3-5-sonnet-20241022')
    assert.equal(out.stop_reason, 'end_turn')
    assert.deepEqual(out.content[0], { type: 'text', text: 'Hello there' })
    assert.equal(out.usage.input_tokens, 10)
    assert.equal(out.usage.output_tokens, 5)
  })

  it('translates tool_calls to tool_use blocks', () => {
    const resp: OpenAIResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"hi"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    const out = translateResponse(resp, 'claude')
    assert.equal(out.stop_reason, 'tool_use')
    const block = out.content[0] as { type: string; name: string; input: Record<string, unknown> }
    assert.equal(block.type, 'tool_use')
    assert.equal(block.name, 'search')
    assert.equal(block.input.q, 'hi')
  })

  it('handles malformed tool arguments gracefully', () => {
    const resp: OpenAIResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: 'not-json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
    const out = translateResponse(resp, 'claude')
    const block = out.content[0] as { input: Record<string, unknown> }
    assert.equal(block.input._raw, 'not-json')
  })

  it('maps finish_reason length to max_tokens', () => {
    const resp: OpenAIResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'g',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'length' },
      ],
    }
    assert.equal(translateResponse(resp, 'c').stop_reason, 'max_tokens')
  })

  it('returns error response when no choices', () => {
    const resp: OpenAIResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'g',
      choices: [],
    }
    const out = translateResponse(resp, 'c')
    assert.match((out.content[0] as { text: string }).text, /\[Proxy Error\]/)
  })

  it('adds empty text block when content is empty', () => {
    const resp: OpenAIResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'g',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    }
    const out = translateResponse(resp, 'c')
    assert.equal(out.content.length, 1)
    assert.deepEqual(out.content[0], { type: 'text', text: '' })
  })
})

describe('buildErrorResponse', () => {
  it('builds a proxy error response', () => {
    const out = buildErrorResponse('claude-3-5-sonnet', 'something failed')
    assert.equal(out.role, 'assistant')
    assert.equal(out.stop_reason, 'end_turn')
    assert.match((out.content[0] as { text: string }).text, /\[Proxy Error\] something failed/)
  })
})
