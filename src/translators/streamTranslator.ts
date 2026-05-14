/**
 * Traductor de Streaming: OpenAI SSE chunks → Anthropic SSE events
 *
 * Cada content block tiene un índice fijo asignado al crearse.
 * Los deltas siempre usan ese mismo índice.
 * Los blocks se cierran en orden al final (finish_reason).
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { OpenAIStreamChunk, OpenAIStreamToolCall } from '../types.js'

interface ToolCallState {
  id: string
  name: string
  pendingArguments: string
  blockIndex: number
  headerSent: boolean
  closed: boolean
}

interface StreamState {
  messageId: string
  model: string
  nextBlockIndex: number
  activeToolCalls: Map<number, ToolCallState>
  thinkingBlockOpen: boolean
  thinkingBlockIndex: number
  textBlockOpen: boolean
  textBlockIndex: number
  inputTokens: number
  outputTokens: number
  hasContent: boolean
  finished: boolean
}

export function createStreamState(model: string): StreamState {
  return {
    messageId: `msg_${randomUUID()}`,
    model,
    nextBlockIndex: 0,
    activeToolCalls: new Map(),
    thinkingBlockOpen: false,
    thinkingBlockIndex: -1,
    textBlockOpen: false,
    textBlockIndex: -1,
    inputTokens: 0,
    outputTokens: 0,
    hasContent: false,
    finished: false,
  }
}

export async function sendMessageStart(res: ServerResponse, state: StreamState): Promise<void> {
  await writeSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}

export async function processStreamChunk(
  res: ServerResponse,
  chunk: OpenAIStreamChunk,
  state: StreamState,
): Promise<void> {
  // No procesar nada después de finish
  if (state.finished) return

  if (chunk.usage) {
    state.inputTokens = chunk.usage.prompt_tokens ?? 0
    state.outputTokens = chunk.usage.completion_tokens ?? 0
  }

  const choice = chunk.choices?.[0]
  if (!choice) return

  const delta = choice.delta

  // --- Reasoning (thinking mode) ---
  // Algunos providers OpenAI-compatibles emiten el razonamiento como
  // delta.reasoning_content antes del contenido de texto. Lo traducimos a
  // bloques `thinking` de Anthropic para que el cliente lo reciba y pueda
  // reenviarlo en turnos posteriores (los providers lo exigen).
  if (
    delta.reasoning_content !== undefined &&
    delta.reasoning_content !== null &&
    delta.reasoning_content.length > 0
  ) {
    if (!state.thinkingBlockOpen) {
      await openThinkingBlock(res, state)
    }
    await writeSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
    })
  }

  // --- Contenido de texto ---
  if (delta.content !== undefined && delta.content !== null && delta.content.length > 0) {
    // Cerrar thinking antes de abrir texto
    if (state.thinkingBlockOpen) {
      await closeThinkingBlock(res, state)
    }
    if (!state.textBlockOpen) {
      await openTextBlock(res, state)
    }
    await writeSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.textBlockIndex,
      delta: { type: 'text_delta', text: delta.content },
    })
  }

  // --- Tool calls ---
  if (delta.tool_calls?.length) {
    // Cerrar thinking y texto antes de tools
    if (state.thinkingBlockOpen) {
      await closeThinkingBlock(res, state)
    }
    if (state.textBlockOpen) {
      await closeTextBlock(res, state)
    }
    for (const tc of delta.tool_calls) {
      await processToolCallDelta(res, tc, state)
    }
  }

  // --- Fin del stream: cerrar todo y enviar message_delta/stop ---
  if (choice.finish_reason) {
    await finishStream(res, state, choice.finish_reason)
  }
}

async function openTextBlock(res: ServerResponse, state: StreamState): Promise<void> {
  state.textBlockIndex = state.nextBlockIndex
  state.nextBlockIndex++
  state.textBlockOpen = true
  state.hasContent = true
  await writeSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.textBlockIndex,
    content_block: { type: 'text', text: '' },
  })
}

async function closeTextBlock(res: ServerResponse, state: StreamState): Promise<void> {
  if (!state.textBlockOpen) return
  await writeSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.textBlockIndex,
  })
  state.textBlockOpen = false
}

async function openThinkingBlock(res: ServerResponse, state: StreamState): Promise<void> {
  state.thinkingBlockIndex = state.nextBlockIndex
  state.nextBlockIndex++
  state.thinkingBlockOpen = true
  state.hasContent = true
  await writeSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.thinkingBlockIndex,
    content_block: { type: 'thinking', thinking: '' },
  })
}

async function closeThinkingBlock(res: ServerResponse, state: StreamState): Promise<void> {
  if (!state.thinkingBlockOpen) return
  await writeSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.thinkingBlockIndex,
  })
  state.thinkingBlockOpen = false
}

async function processToolCallDelta(
  res: ServerResponse,
  tc: OpenAIStreamToolCall,
  state: StreamState,
): Promise<void> {
  const tcIndex = tc.index

  // Crear nuevo tool call state si no existe
  if (!state.activeToolCalls.has(tcIndex)) {
    const blockIdx = state.nextBlockIndex
    state.nextBlockIndex++
    state.activeToolCalls.set(tcIndex, {
      id: tc.id || '',
      name: tc.function?.name || '',
      pendingArguments: tc.function?.arguments || '',
      blockIndex: blockIdx,
      headerSent: false,
      closed: false,
    })
  } else {
    const existing = state.activeToolCalls.get(tcIndex)!
    // id y name vienen una sola vez (en el primer chunk con tool_call). Si el
    // provider los reenvía, los ignoramos para no duplicar (e.g. "search" + "search").
    if (tc.id && !existing.id) existing.id = tc.id
    if (tc.function?.name && !existing.name) existing.name = tc.function.name
    if (tc.function?.arguments && !existing.headerSent) {
      existing.pendingArguments += tc.function.arguments
    }
  }

  const toolState = state.activeToolCalls.get(tcIndex)!

  // Enviar header cuando tenemos id Y name
  if (!toolState.headerSent && toolState.id && toolState.name) {
    await writeSSE(res, 'content_block_start', {
      type: 'content_block_start',
      index: toolState.blockIndex,
      content_block: {
        type: 'tool_use',
        id: toolState.id,
        name: toolState.name,
        input: {},
      },
    })
    toolState.headerSent = true
    state.hasContent = true

    // Flush pending arguments
    if (toolState.pendingArguments.length > 0) {
      await writeSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: toolState.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: toolState.pendingArguments,
        },
      })
      toolState.pendingArguments = ''
    }
    return
  }

  // Header ya enviado: enviar arguments directamente
  if (toolState.headerSent && tc.function?.arguments) {
    await writeSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: toolState.blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: tc.function.arguments,
      },
    })
  }
}

async function finishStream(
  res: ServerResponse,
  state: StreamState,
  finishReason: string,
): Promise<void> {
  if (state.finished) return
  state.finished = true

  // 1. Cerrar thinking y texto abiertos
  await closeThinkingBlock(res, state)
  await closeTextBlock(res, state)

  // 2. Cerrar todos los tool calls abiertos
  for (const [, toolState] of state.activeToolCalls) {
    if (toolState.closed) continue

    // Si nunca se envió header pero tenemos datos, enviar todo
    if (!toolState.headerSent && toolState.id && toolState.name) {
      await writeSSE(res, 'content_block_start', {
        type: 'content_block_start',
        index: toolState.blockIndex,
        content_block: {
          type: 'tool_use',
          id: toolState.id,
          name: toolState.name,
          input: {},
        },
      })
      toolState.headerSent = true
      state.hasContent = true

      if (toolState.pendingArguments.length > 0) {
        await writeSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: toolState.blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: toolState.pendingArguments,
          },
        })
      }
    }

    if (toolState.headerSent) {
      await writeSSE(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: toolState.blockIndex,
      })
      toolState.closed = true
    }
  }

  // 3. Si no hubo contenido, enviar text block vacío
  if (!state.hasContent) {
    await writeSSE(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    await writeSSE(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    })
  }

  // 4. stop_reason
  let stopReason: string = 'end_turn'
  if (finishReason === 'tool_calls' || state.activeToolCalls.size > 0) {
    stopReason = 'tool_use'
  } else if (finishReason === 'length') {
    stopReason = 'max_tokens'
  }

  await writeSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: state.outputTokens },
  })

  await writeSSE(res, 'message_stop', { type: 'message_stop' })
}

function writeSSE(
  res: ServerResponse,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    const ok = res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
    if (ok) {
      resolve()
    } else {
      // Esperar a que el buffer se vacíe antes de continuar
      res.once('drain', resolve)
    }
  })
}
