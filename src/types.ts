// ============================================================
// Tipos para el formato Anthropic Messages API
// ============================================================

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicSystemBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: { user_id?: string }
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' }
}

export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' }

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicResponseBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type AnthropicResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string }

// ==========================================================
// Tipos para el formato OpenAI Chat Completions API
// ==========================================================

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: OpenAITool[]
  tool_choice?: string | { type: 'function'; function: { name: string } }
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage

export interface OpenAISystemMessage {
  role: 'system'
  content: string
}

export interface OpenAIUserMessage {
  role: 'user'
  content: string | OpenAIContentPart[]
}

export interface OpenAIAssistantMessage {
  role: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: OpenAIStreamChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null
}

export interface OpenAIStreamChoice {
  index: number
  delta: {
    role?: 'assistant'
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: OpenAIStreamToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface OpenAIStreamToolCall {
  index: number
  id?: string
  type?: 'function'
  function: {
    name?: string
    arguments?: string
  }
}

// ==========================================================
// Configuración del proxy
// ==========================================================

export interface ProxyConfig {
  port: number
  targetBaseUrl: string
  targetApiKey: string
  targetModel: string
  logRequests: boolean
  connectionTimeout: number
  requestTimeout: number
  maxSockets: number
  keepAlive: boolean
  allowH2: boolean
  maxRetries: number
  retryDelayMs: number
  retryBackoffMultiplier: number
  retryMaxDelayMs: number
}
