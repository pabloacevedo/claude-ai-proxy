import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import {
  createStreamState,
  processStreamChunk,
  sendMessageStart,
} from '../../src/translators/streamTranslator.js'
import type { OpenAIStreamChunk } from '../../src/types.js'

interface CapturedEvent {
  event: string
  data: Record<string, unknown>
}

/**
 * Mock minimalista de ServerResponse: solo necesitamos write() y un par
 * de propiedades para satisfacer al stream translator.
 */
function makeRes(): { res: ServerResponse; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const fakeRes = {
    headersSent: false,
    writableEnded: false,
    write(chunk: string | Buffer): boolean {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const parts = text.split('\n').filter(Boolean)
      if (parts.length >= 2) {
        const event = parts[0]!.replace(/^event: /, '')
        const data = JSON.parse(parts[1]!.replace(/^data: /, ''))
        events.push({ event, data })
      }
      return true
    },
    end() {
      this.writableEnded = true
    },
    once(_event: string, cb: () => void): typeof fakeRes {
      cb()
      return fakeRes
    },
  }
  return { res: fakeRes as unknown as ServerResponse, events }
}

describe('streamTranslator', () => {
  it('emits message_start with empty content', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('claude-3-5-sonnet')
    await sendMessageStart(res, state)
    assert.equal(events[0]!.event, 'message_start')
    assert.deepEqual((events[0]!.data as { message: { content: unknown[] } }).message.content, [])
  })

  it('emits text_delta for content chunks', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('m')

    const chunk: OpenAIStreamChunk = {
      id: '1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'g',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    }
    await processStreamChunk(res, chunk, state)

    const types = events.map((e) => e.event)
    assert.ok(types.includes('content_block_start'))
    assert.ok(types.includes('content_block_delta'))
    const delta = events.find((e) => e.event === 'content_block_delta')!
    const d = delta.data as { delta: { type: string; text: string } }
    assert.equal(d.delta.type, 'text_delta')
    assert.equal(d.delta.text, 'Hello')
  })

  it('emits tool_use blocks with input_json_delta', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('m')

    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    )

    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
            finish_reason: null,
          },
        ],
      },
      state,
    )

    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
      state,
    )

    const types = events.map((e) => e.event)
    assert.ok(types.includes('content_block_start'))
    assert.ok(types.includes('content_block_delta'))
    assert.ok(types.includes('content_block_stop'))
    assert.ok(types.includes('message_delta'))
    assert.ok(types.includes('message_stop'))

    const messageDelta = events.find((e) => e.event === 'message_delta')!
    const md = messageDelta.data as { delta: { stop_reason: string } }
    assert.equal(md.delta.stop_reason, 'tool_use')
  })

  it('emits empty content block when no content', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('m')
    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      state,
    )
    const types = events.map((e) => e.event)
    assert.ok(types.includes('content_block_start'))
    assert.ok(types.includes('content_block_stop'))
    assert.ok(types.includes('message_stop'))
  })

  it('does not process chunks after finish', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('m')

    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
      },
      state,
    )

    const before = events.length
    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [{ index: 0, delta: { content: 'extra' }, finish_reason: null }],
      },
      state,
    )
    assert.equal(events.length, before)
  })

  it('does not duplicate tool name when provider re-sends it (regression)', async () => {
    const { res, events } = makeRes()
    const state = createStreamState('m')

    // Algunos providers no estándar reenvían el name en chunks subsiguientes.
    // El fix: ignorar name si ya lo tenemos (no concatenar).
    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'search', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    )

    // Provider reenvía el mismo name junto con args
    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"q":"x"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      state,
    )

    await processStreamChunk(
      res,
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'g',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
      state,
    )

    const blockStart = events.find((e) => e.event === 'content_block_start')!
    const block = blockStart.data as { content_block: { name: string } }
    assert.equal(block.content_block.name, 'search')
  })
})
