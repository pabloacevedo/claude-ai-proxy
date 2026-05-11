import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateRequest } from '../../src/translators/requestTranslator.js'
import type { AnthropicRequest } from '../../src/types.js'

describe('translateRequest', () => {
  it('translates a simple text message', () => {
    const req: AnthropicRequest = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    assert.equal(out.model, 'gpt-4o')
    assert.deepEqual(out.messages[0], { role: 'user', content: 'hello' })
    assert.equal(out.max_completion_tokens, 100)
  })

  it('extracts system prompt as string', () => {
    const req: AnthropicRequest = {
      model: 'x',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    assert.equal(out.messages[0]!.role, 'system')
    assert.equal((out.messages[0] as { content: string }).content, 'You are helpful')
  })

  it('extracts system prompt from blocks array', () => {
    const req: AnthropicRequest = {
      model: 'x',
      system: [
        { type: 'text', text: 'Block 1' },
        { type: 'text', text: 'Block 2' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    assert.equal((out.messages[0] as { content: string }).content, 'Block 1\n\nBlock 2')
  })

  it('preserves order of mixed user content blocks', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result1' },
            { type: 'text', text: 'after' },
          ],
        },
      ],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    // Esperamos: user(before) -> tool(result1) -> user(after)
    assert.equal(out.messages.length, 3)
    assert.equal(out.messages[0]!.role, 'user')
    assert.equal((out.messages[0] as { content: string }).content, 'before')
    assert.equal(out.messages[1]!.role, 'tool')
    assert.equal((out.messages[1] as { content: string }).content, 'result1')
    assert.equal(out.messages[2]!.role, 'user')
    assert.equal((out.messages[2] as { content: string }).content, 'after')
  })

  it('translates assistant tool_use to tool_calls', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'cats' } },
          ],
        },
      ],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    const assistant = out.messages[1] as {
      tool_calls?: Array<{ function: { name: string; arguments: string } }>
    }
    assert.equal(assistant.tool_calls?.[0]?.function.name, 'search')
    assert.equal(JSON.parse(assistant.tool_calls![0]!.function.arguments).q, 'cats')
  })

  it('translates tool definitions', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      tools: [{ name: 'search', description: 'web search', input_schema: { type: 'object' } }],
    }
    const out = translateRequest(req, 'gpt-4o')
    assert.equal(out.tools?.[0]?.function.name, 'search')
    assert.equal(out.tools?.[0]?.function.description, 'web search')
  })

  it('translates tool_choice variants', () => {
    const base: AnthropicRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }
    assert.equal(
      translateRequest({ ...base, tool_choice: { type: 'auto' } }, 'g').tool_choice,
      'auto',
    )
    assert.equal(
      translateRequest({ ...base, tool_choice: { type: 'any' } }, 'g').tool_choice,
      'required',
    )
    assert.equal(
      translateRequest({ ...base, tool_choice: { type: 'none' } }, 'g').tool_choice,
      'none',
    )
    assert.deepEqual(
      translateRequest({ ...base, tool_choice: { type: 'tool', name: 'foo' } }, 'g').tool_choice,
      { type: 'function', function: { name: 'foo' } },
    )
  })

  it('passes streaming with usage option', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      stream: true,
    }
    const out = translateRequest(req, 'gpt-4o')
    assert.equal(out.stream, true)
    assert.deepEqual(out.stream_options, { include_usage: true })
  })

  it('handles image blocks as data URIs', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ABC' },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    const userMsg = out.messages[0] as {
      content: Array<{ type: string; image_url?: { url: string } }>
    }
    assert.equal(userMsg.content[0]!.image_url!.url, 'data:image/png;base64,ABC')
  })

  it('handles image blocks with cache_control', () => {
    const req: AnthropicRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ABC' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const out = translateRequest(req, 'gpt-4o')
    const userMsg = out.messages[0] as {
      content: Array<{ type: string; image_url?: { url: string } }>
    }
    // cache_control de Anthropic no se traduce a OpenAI (no existe en la especificación OpenAI)
    assert.equal(userMsg.content[0]!.image_url!.url, 'data:image/png;base64,ABC')
  })
})
