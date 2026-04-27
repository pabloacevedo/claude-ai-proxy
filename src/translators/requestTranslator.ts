/**
 * Traductor de Request: Anthropic Messages API → OpenAI Chat Completions API
 *
 * Convierte el formato de petición de Anthropic al formato de OpenAI,
 * incluyendo system prompts, mensajes, tools y configuración de streaming.
 */

import { mapModel } from '../config.js'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicSystemBlock,
  AnthropicToolChoice,
  OpenAIAssistantMessage,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from '../types.js'

export function translateRequest(
  anthropicReq: AnthropicRequest,
  defaultModel: string,
): OpenAIRequest {
  const openaiMessages: OpenAIMessage[] = []

  // 1. Traducir system prompt
  const systemText = extractSystemText(anthropicReq.system)
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText })
  }

  // 2. Traducir mensajes
  for (const msg of anthropicReq.messages) {
    const translated = translateMessage(msg)
    openaiMessages.push(...translated)
  }

  // 3. Traducir tools
  const tools = translateTools(anthropicReq.tools)

  // 4. Traducir tool_choice
  const toolChoice = translateToolChoice(anthropicReq.tool_choice)

  // 5. Construir request OpenAI
  const openaiReq: OpenAIRequest = {
    model: mapModel(anthropicReq.model, defaultModel),
    messages: openaiMessages,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
    stream: anthropicReq.stream,
  }

  // max_tokens: OpenAI usa max_completion_tokens para modelos nuevos
  if (anthropicReq.max_tokens) {
    openaiReq.max_completion_tokens = anthropicReq.max_tokens
  }

  if (anthropicReq.stop_sequences?.length) {
    openaiReq.stop = anthropicReq.stop_sequences
  }

  if (tools && tools.length > 0) {
    openaiReq.tools = tools
  }

  if (toolChoice !== undefined) {
    openaiReq.tool_choice = toolChoice
  }

  // Si es streaming, pedir usage en el último chunk
  if (anthropicReq.stream) {
    openaiReq.stream_options = { include_usage: true }
  }

  return openaiReq
}

// ==========================================================
// Helpers
// ========================================

function extractSystemText(
  system: AnthropicRequest['system'],
): string | null {
  if (!system) return null
  if (typeof system === 'string') return system
  // Array de bloques de sistema
  return (system as AnthropicSystemBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

/**
 * Traduce un mensaje Anthropic a uno o más mensajes OpenAI.
 * Un solo mensaje Anthropic con tool_use + text puede generar múltiples mensajes OpenAI.
 */
function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  // Contenido simple (string)
  if (typeof msg.content === 'string') {
    if (msg.role === 'user') {
      return [{ role: 'user', content: msg.content }]
    }
    return [{ role: 'assistant', content: msg.content }]
  }

  // Contenido como array de bloques
  const blocks = msg.content as AnthropicContentBlock[]

  if (msg.role === 'user') {
    return translateUserBlocks(blocks)
  }

  return translateAssistantBlocks(blocks)
}

function translateUserBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []

  // Separar tool_results de contenido normal
  const toolResults = blocks.filter((b) => b.type === 'tool_result')
  const otherBlocks = blocks.filter((b) => b.type !== 'tool_result')

  // Primero los tool_results (van como mensajes role: "tool")
  for (const block of toolResults) {
    if (block.type !== 'tool_result') continue
    const content = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : ''

    const toolMsg: OpenAIToolMessage = {
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: block.is_error ? `[ERROR] ${content}` : content,
    }
    messages.push(toolMsg)
  }

  // Luego el contenido normal del usuario
  if (otherBlocks.length > 0) {
    const parts: OpenAIContentPart[] = []

    for (const block of otherBlocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
      }
    }

    if (parts.length > 0) {
      const userMsg: OpenAIUserMessage = {
        role: 'user',
        content: parts.length === 1 && parts[0]!.type === 'text'
          ? parts[0]!.text!
          : parts,
      }
      messages.push(userMsg)
    }
  }

  return messages
}

function translateAssistantBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'thinking') {
      // Incluir thinking como texto entre tags para modelos que no lo soportan
      textParts.push(`<thinking>\n${block.thinking}\n</thinking>`)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    }
  }

  const assistantMsg: OpenAIAssistantMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n') : null,
  }

  if (toolCalls.length > 0) {
    assistantMsg.tool_calls = toolCalls
  }

  return [assistantMsg]
}

function translateTools(
  tools: AnthropicRequest['tools'],
): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateToolChoice(
  choice: AnthropicToolChoice | undefined,
): OpenAIRequest['tool_choice'] | undefined {
  if (!choice) return undefined

  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: choice.name } }
    default:
      return undefined
  }
}
