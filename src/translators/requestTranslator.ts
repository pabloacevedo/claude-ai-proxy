/**
 * Traductor de Request: Anthropic Messages API → OpenAI Chat Completions API
 *
 * Convierte el formato de petición de Anthropic al formato de OpenAI,
 * preservando el orden original de los bloques de contenido.
 */

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
  targetModel: string,
): OpenAIRequest {
  const openaiMessages: OpenAIMessage[] = []

  const systemText = extractSystemText(anthropicReq.system)
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText })
  }

  for (const msg of anthropicReq.messages) {
    const translated = translateMessage(msg)
    openaiMessages.push(...translated)
  }

  const tools = translateTools(anthropicReq.tools)
  const toolChoice = translateToolChoice(anthropicReq.tool_choice)

  const openaiReq: OpenAIRequest = {
    model: targetModel,
    messages: openaiMessages,
    temperature: anthropicReq.temperature,
    top_p: anthropicReq.top_p,
    stream: anthropicReq.stream,
  }

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

  if (anthropicReq.stream) {
    openaiReq.stream_options = { include_usage: true }
  }

  return openaiReq
}

function extractSystemText(system: AnthropicRequest['system']): string | null {
  if (!system) return null
  if (typeof system === 'string') return system
  return (system as AnthropicSystemBlock[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

/**
 * Traduce un mensaje Anthropic preservando el orden de los bloques.
 *
 * Para mensajes de usuario con tool_results intercalados, generamos
 * múltiples mensajes en el mismo orden: por ejemplo
 *   [text, tool_result, text] → [user(text), tool, user(text)]
 */
function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === 'string') {
    if (msg.role === 'user') {
      return [{ role: 'user', content: msg.content }]
    }
    return [{ role: 'assistant', content: msg.content }]
  }

  const blocks = msg.content as AnthropicContentBlock[]

  if (msg.role === 'user') {
    return translateUserBlocksOrdered(blocks)
  }
  return translateAssistantBlocks(blocks)
}

function translateUserBlocksOrdered(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []
  let pendingParts: OpenAIContentPart[] = []

  const flushUserParts = (): void => {
    if (pendingParts.length === 0) return
    const userMsg: OpenAIUserMessage = {
      role: 'user',
      content:
        pendingParts.length === 1 && pendingParts[0]!.type === 'text'
          ? pendingParts[0]!.text!
          : pendingParts,
    }
    messages.push(userMsg)
    pendingParts = []
  }

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      // Antes de un tool_result, cierra cualquier contenido de usuario pendiente
      flushUserParts()
      const content = extractToolResultContent(block.content)
      const toolMsg: OpenAIToolMessage = {
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `[ERROR] ${content}` : content,
      }
      messages.push(toolMsg)
    } else if (block.type === 'text') {
      pendingParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      // Defensa runtime: el body viene del cliente y aunque pase el validador,
      // el shape de `source` puede ser inválido (provider raro, contenido truncado).
      const src = block.source
      if (!src || typeof src !== 'object' || !src.media_type || !src.data) continue
      pendingParts.push({
        type: 'image_url',
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      })
    }
  }

  flushUserParts()
  return messages
}

function extractToolResultContent(content: AnthropicContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function translateAssistantBlocks(blocks: AnthropicContentBlock[]): OpenAIMessage[] {
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'thinking') {
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

function translateTools(tools: AnthropicRequest['tools']): OpenAITool[] | undefined {
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
