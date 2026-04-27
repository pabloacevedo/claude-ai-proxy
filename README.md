# 🔀 AI Proxy — Usa cualquier modelo de IA con Claude Code

Proxy HTTP en TypeScript que traduce peticiones del formato **Anthropic Messages API** al formato **OpenAI Chat Completions API** y viceversa.

Esto permite usar **cualquier modelo compatible con la API de OpenAI** (GPT-4o, Gemini, Llama, Mistral, DeepSeek, modelos locales con Ollama, etc.) directamente desde **Claude Code**.

## 📁 Estructura

```
ai-proxy/
├── src/
│   ├── server.ts                   # Servidor HTTP principal
│   ├── config.ts                          # Configuración y mapeo de modelos
│   ├── types.ts                       # Tipos Anthropic + OpenAI
│   └── translators/
│       ├── requestTranslator.ts           # Anthropic → OpenAI (request)
│       ├── responseTranslator.ts          # OpenAI → Anthropic (response)
│       └── streamTranslator.ts            # Streaming SSE OpenAI → Anthropic
├── package.json
├── tsconfig.json
└── README.md
```

## 🚀 Instalación

```bash
cd ai-proxy
npm install
```

## ⚡ Uso rápido

### Con OpenAI (GPT-4o)

```bash
TARGET_API_KEY=sk-tu-api-key \
TARGET_MODEL=gpt-4o \
TARGET_BASE_URL=https://api.openai.com \
npm run dev
```

### Con Google Gemini

```bash
TARGET_API_KEY=tu-gemini-key \
TARGET_MODEL=gemini-2.5-flash \
TARGET_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
npm run dev
```

### Con Ollama (modelos locales)

```bash
TARGET_API_KEY=ollama \
TARGET_MODEL=llama3.1 \
TARGET_BASE_URL=http://localhost:11434 \
npm run dev
```

### Con DeepSeek

```bash
TARGET_API_KEY=tu-deepseek-key \
TARGET_MODEL=deepseek-chat \
TARGET_BASE_URL=https://api.deepseek.com \
npm run dev
```

### Con Groq

```bash
TARGET_API_KEY=tu-groq-key \
TARGET_MODEL=llama-3.3-70b-versatile \
TARGET_BASE_URL=https://api.groq.com/openai \
npm run dev
```

### Con OpenRouter (acceso a 100+ modelos)

```bash
TARGET_API_KEY=tu-openrouter-key \
TARGET_MODEL=google/gemini-2.5-pro \
TARGET_BASE_URL=https://openrouter.ai/api \
npm run dev
```

## 🔗 Conectar con Claude Code

Una vez que el proxy esté corriendo, configura Claude Code para usarlo:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8082
```

¡Eso es todo! Claude Code enviará sus peticiones al proxy, que las traducirá y reenviará al modelo que hayas configurado.

## ⚙️ Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `TARGET_API_KEY` | *(requerida)* | API key del proveedor destino |
| `TARGET_MODEL` | `gpt-4o` | Modelo a usar en el proveedor destino |
| `TARGET_BASE_URL` | `https://api.openai.com` | URL base del proveedor destino |
| `PROXY_PORT` | `8082` | Puerto donde escucha el proxy |
| `LOG_REQUESTS` | `false` | Loguear peticiones y respuestas |

## 🔄 ¿Qué traduce?

| Feature | Anthropic → OpenAI | Soportado |
|---|---|---|
| System prompt | `system` → `messages[0].role: "system"` | ✅ |
| Mensajes texto | `content[].type: "text"` → `content` | ✅ |
| Imágenes | `source.base64` → `image_url.url` (data URI) | ✅ |
| Tools (definición) | `input_schema` → `parameters` | ✅ |
| Tool use (llamada) | `tool_use` block → `tool_calls` array | ✅ |
| Tool result | `tool_result` block → `role: "tool"` message | ✅ |
| Tool choice | `auto/any/tool/none` → `auto/required/function/none` | ✅ |
| Streaming SSE | Eventos Anthropic ← chunks OpenAI | ✅ |
| Thinking | `thinking` block → `<thinking>` tags en texto | ✅ |
| `max_tokens` | → `max_completion_tokens` | ✅ |
| `stop_sequences` | → `stop` | ✅ |
| `cache_control` | Ignorado (no existe en OpenAI) | ⚠️ |

## ⚠️ Limitaciones

1. **Calidad variable**: Los prompts de Claude Code están optimizados para Claude. Otros modelos pueden no seguir las instrucciones tan bien.
2. **Thinking**: Se convierte a tags `<thinking>` en texto plano, no es thinking nativo.
3. **Cache control**: Las directivas `cache_control` de Anthropic se ignoran (OpenAI no las soporta).
4. **Betas/headers especiales**: Headers beta de Anthropic (`anthropic-beta`) se ignoran.
5. **Tool use complejo**: Algunos modelos más pequeños pueden tener problemas con tool calling extensivo.

## 🛠️ Desarrollo

```bash
# Modo desarrollo con hot-reload
npm run dev

# Compilar a JavaScript
npm run build

# Ejecutar compilado
npm start
```

## 📝 Personalizar mapeo de modelos

Edita `src/config.ts` para mapear modelos específicos de Anthropic a modelos del proveedor destino:

```typescript
const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'gpt-4o',
  'claude-opus-4-20250514': 'gpt-4o',
  'claude-3-5-haiku-20241022': 'gpt-4o-mini',
}
```
