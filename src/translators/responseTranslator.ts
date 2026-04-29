/**
 * Traductor de Response: OpenAI Chat Completions → Anthropic Messages API
 *
 * Convierte respuestas (non-streaming) del formato OpenAI al formato
 * que Claude Code espera recibir de la API de Anthropic.
 */

import { randomUUID } from 'node:crypto'
import type {
  AnthropicResponse,
  AnthropicResponseBlock,
  OpenAIResponse,
  OpenAIToolCall,
} from '../types.js'

export function translateResponse(
  openaiResp: OpenAIResponse,
  requestModel: string,
): AnthropicResponse {
  const choice = openaiResp.choices[0]
  if (!choice) {
    return buildErrorResponse(requestModel, 'No choices in OpenAI response')
  }

  const content: AnthropicResponseBlock[] = []

  // 1. Traducir contenido de texto
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  // 2. Traducir tool_calls → tool_use blocks
  if (choice.message.tool_calls?.length) {
    for (const tc of choice.message.tool_calls) {
      content.push(translateToolCall(tc))
    }
  }

  // Si no hay contenido, agregar texto vacío para evitar errores
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  // 3. Traducir finish_reason → stop_reason
  const stopReason = translateFinishReason(choice.finish_reason, choice.message.tool_calls)

  return {
    id: `msg_${openaiResp.id || randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResp.usage?.completion_tokens ?? 0,
    },
  }
}

function translateToolCall(tc: OpenAIToolCall): AnthropicResponseBlock {
  let input: Record<string, unknown>
  try {
    input = JSON.parse(tc.function.arguments)
  } catch {
    input = { _raw: tc.function.arguments }
  }

  return {
    type: 'tool_use',
    id: tc.id || `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name: tc.function.name,
    input,
  }
}

function translateFinishReason(
  reason: string | null,
  toolCalls?: OpenAIToolCall[],
): AnthropicResponse['stop_reason'] {
  if (toolCalls && toolCalls.length > 0) return 'tool_use'

  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

export function buildErrorResponse(model: string, errorMessage: string): AnthropicResponse {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: `[Proxy Error] ${errorMessage}` }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}
