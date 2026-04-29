# 🔀 AI Proxy — Usa cualquier modelo de IA con Claude Code

Proxy HTTP en TypeScript que traduce peticiones del formato **Anthropic Messages API** al formato **OpenAI Chat Completions API** y viceversa.

Esto permite usar **cualquier modelo compatible con la API de OpenAI** (NVIDIA NIM, GPT-4o, Gemini, Llama, Mistral, DeepSeek, modelos locales con Ollama, etc.) directamente desde **Claude Code**.

## 📁 Estructura

```
ai-proxy/
├── src/
│   ├── server.ts                   # Entry point: routing + lifecycle
│   ├── types.ts                    # Tipos Anthropic + OpenAI
│   ├── config/
│   │   ├── index.ts                # Carga ProxyConfig desde .env
│   │   └── providers.ts            # Routing multi-proveedor + MODEL_MAP
│   ├── lib/
│   │   ├── logger.ts               # Logger estructurado JSON/pretty
│   │   ├── sanitizer.ts            # Redacta API keys en logs
│   │   ├── retry.ts                # Backoff exponencial con jitter
│   │   ├── httpClient.ts           # undici Agent/Pool dispatcher
│   │   ├── cache.ts                # LRU cache + hashRequest
│   │   └── bufferPool.ts           # Pool de buffers para reducir GC
│   ├── middleware/
│   │   ├── rateLimit.ts            # Rate limit por IP
│   │   ├── metrics.ts              # Métricas con percentiles
│   │   ├── cors.ts                 # CORS con allowlist
│   │   └── requestId.ts            # IDs correlación de logs
│   ├── handlers/
│   │   ├── messages.ts             # POST /v1/messages
│   │   ├── health.ts               # GET /health
│   │   └── metrics.ts              # GET /metrics
│   ├── validators/
│   │   └── anthropicRequest.ts     # Validación zero-dep del body
│   └── translators/
│       ├── requestTranslator.ts    # Anthropic → OpenAI (request)
│       ├── responseTranslator.ts   # OpenAI → Anthropic (response)
│       └── streamTranslator.ts     # SSE OpenAI → SSE Anthropic
├── tests/                          # node:test (65 tests)
├── .github/workflows/ci.yml        # GitHub Actions CI
├── eslint.config.js
├── .prettierrc.json
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

### Con NVIDIA NIM (NVIDIA Inference Microservices)

```bash
# Obtén tu API key en: https://build.nvidia.com/
TARGET_API_KEY=nvapi-tu-api-key-aqui \
TARGET_MODEL=meta/llama-3.1-8b-instruct \
TARGET_BASE_URL=https://integrate.api.nvidia.com \
npm run dev
```

**Modelos populares de NVIDIA:**
- `meta/llama-3.1-8b-instruct` - Llama 3.1 8B
- `meta/llama-3.1-70b-instruct` - Llama 3.1 70B
- `nvidia/llama-3.1-nemotron-70b-instruct` - Nemotron 70B
- `google/gemma-2-27b-it` - Gemma 2 27B
- `mistralai/mistral-7b-instruct-v0.3` - Mistral 7B

Ver todos los modelos disponibles en: https://api.nvidia.com/v1/models

## 🔗 Conectar con Claude Code

Una vez que el proxy esté corriendo, configura Claude Code para usarlo:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8082
```

¡Eso es todo! Claude Code enviará sus peticiones al proxy, que las traducirá y reenviará al modelo que hayas configurado.

## ⚙️ Variables de entorno

### Proveedor por defecto
| Variable | Default | Descripción |
|---|---|---|
| `TARGET_API_KEY` | *(requerida)* | API key del proveedor destino |
| `TARGET_MODEL` | `gpt-4o` | Modelo a usar |
| `TARGET_BASE_URL` | `https://api.openai.com` | URL base del proveedor |
| `TARGET_PASSTHROUGH` | *(auto)* | Si el endpoint habla nativo Anthropic, no traduce. Auto-detectado por host |
| `PROXY_PORT` | `8082` | Puerto del proxy |

### Logging
| Variable | Default | Descripción |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `pretty` | `pretty` (color, dev) o `json` (prod) |
| `LOG_REDACT` | `true` | Redactar API keys en logs |

### Routing avanzado
| Variable | Descripción |
|---|---|
| `MODEL_MAP_JSON` | Alias simple: `{"claude-opus-4-20250514":"gpt-4-turbo"}` |
| `PROVIDERS_JSON` | Routing por modelo a providers distintos (ver `.env.example`) |

### Rate limiting, CORS, cache, retry
Ver `.env.example` para la lista completa con defaults y comentarios.

## 📊 Endpoints

| Endpoint | Descripción |
|---|---|
| `POST /v1/messages` | Endpoint principal compatible con Anthropic Messages API |
| `GET /health` | Health check con uptime y versión |
| `GET /metrics` | Métricas en texto plano. `Accept: application/json` para JSON |

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
npm run dev              # Hot-reload con tsx watch
npm run build            # Compila a dist/
npm start                # Ejecuta el build
npm test                 # Tests con node:test
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run format           # Prettier write
npm run format:check     # Prettier check
```

## 📝 Personalizar mapeo de modelos

Hay tres niveles, de más simple a más avanzado:

**1. Provider único (`.env`)** — todos los modelos van al mismo proveedor:
```bash
TARGET_BASE_URL=https://api.openai.com
TARGET_MODEL=gpt-4o
```

**2. Alias por modelo (`MODEL_MAP_JSON`)** — mismo provider, distinto modelo:
```bash
MODEL_MAP_JSON='{"claude-opus-4-20250514":"gpt-4-turbo","claude-3-5-haiku-20241022":"gpt-4o-mini"}'
```

**3. Routing por modelo a providers distintos (`PROVIDERS_JSON`)**:
```bash
PROVIDERS_JSON='{
  "claude-opus-4-20250514": {
    "name": "nvidia",
    "baseUrl": "https://integrate.api.nvidia.com",
    "apiKey": "nvapi-xxx",
    "model": "meta/llama-3.1-70b-instruct"
  },
  "claude-3-5-haiku-20241022": {
    "name": "groq",
    "baseUrl": "https://api.groq.com/openai",
    "apiKey": "gsk-xxx",
    "model": "llama-3.3-70b-versatile"
  }
}'
```

Si el `baseUrl` apunta a `api.anthropic.com`, el proxy detecta automáticamente passthrough (sin traducción).
