/**
 * Validador de AnthropicRequest sin dependencias externas.
 *
 * Devuelve un Result en vez de lanzar excepciones, para integrarse
 * limpiamente con el handler HTTP.
 */

import type { AnthropicRequest } from '../types.js'

export type ValidationResult = { ok: true; value: AnthropicRequest } | { ok: false; error: string }

const VALID_ROLES = new Set(['user', 'assistant'])
const VALID_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'thinking'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function validateAnthropicRequest(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }

  if (typeof input.model !== 'string' || input.model.length === 0) {
    return { ok: false, error: 'Field "model" is required and must be a string' }
  }

  if (!Array.isArray(input.messages)) {
    return { ok: false, error: 'Field "messages" is required and must be an array' }
  }

  if (input.messages.length === 0) {
    return { ok: false, error: 'Field "messages" cannot be empty' }
  }

  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i]
    if (!isPlainObject(msg)) {
      return { ok: false, error: `messages[${i}] must be an object` }
    }
    if (typeof msg.role !== 'string' || !VALID_ROLES.has(msg.role)) {
      return { ok: false, error: `messages[${i}].role must be "user" or "assistant"` }
    }
    if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
      return { ok: false, error: `messages[${i}].content must be a string or array` }
    }
    if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j]
        if (!isPlainObject(block) || typeof block.type !== 'string') {
          return { ok: false, error: `messages[${i}].content[${j}] missing valid "type"` }
        }
        if (!VALID_BLOCK_TYPES.has(block.type)) {
          return {
            ok: false,
            error: `messages[${i}].content[${j}].type "${block.type}" is not supported`,
          }
        }
        if (block.type === 'image') {
          const src = block.source
          if (
            !isPlainObject(src) ||
            src.type !== 'base64' ||
            typeof src.media_type !== 'string' ||
            typeof src.data !== 'string'
          ) {
            return {
              ok: false,
              error: `messages[${i}].content[${j}] image block requires source.type="base64", source.media_type and source.data`,
            }
          }
        }
        if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string') {
            return {
              ok: false,
              error: `messages[${i}].content[${j}] tool_use block requires "id" and "name"`,
            }
          }
        }
        if (block.type === 'tool_result') {
          if (typeof block.tool_use_id !== 'string') {
            return {
              ok: false,
              error: `messages[${i}].content[${j}] tool_result block requires "tool_use_id"`,
            }
          }
        }
      }
    }
  }

  if (typeof input.max_tokens !== 'number' || input.max_tokens <= 0) {
    return { ok: false, error: 'Field "max_tokens" is required and must be a positive number' }
  }

  if (input.temperature !== undefined && typeof input.temperature !== 'number') {
    return { ok: false, error: 'Field "temperature" must be a number' }
  }

  if (input.top_p !== undefined && typeof input.top_p !== 'number') {
    return { ok: false, error: 'Field "top_p" must be a number' }
  }

  if (input.stream !== undefined && typeof input.stream !== 'boolean') {
    return { ok: false, error: 'Field "stream" must be a boolean' }
  }

  if (
    input.system !== undefined &&
    typeof input.system !== 'string' &&
    !Array.isArray(input.system)
  ) {
    return { ok: false, error: 'Field "system" must be a string or array of blocks' }
  }

  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      return { ok: false, error: 'Field "tools" must be an array' }
    }
    for (let i = 0; i < input.tools.length; i++) {
      const tool = input.tools[i]
      if (
        !isPlainObject(tool) ||
        typeof tool.name !== 'string' ||
        !isPlainObject(tool.input_schema)
      ) {
        return { ok: false, error: `tools[${i}] requires "name" and "input_schema"` }
      }
    }
  }

  if (input.stop_sequences !== undefined && !Array.isArray(input.stop_sequences)) {
    return { ok: false, error: 'Field "stop_sequences" must be an array' }
  }

  return { ok: true, value: input as unknown as AnthropicRequest }
}
