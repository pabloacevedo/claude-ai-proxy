/**
 * Logger estructurado con niveles, formato JSON o pretty, y request IDs.
 *
 * Sin dependencias externas. Escribe directo a stdout/stderr para no bloquear
 * el event loop.
 */

import { sanitize } from './sanitizer.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export interface LoggerOptions {
  level: LogLevel
  format: 'pretty' | 'json'
  redact: boolean
}

const ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️ ',
  warn: '⚠️ ',
  error: '❌',
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}
const RESET = '\x1b[0m'

let currentOptions: LoggerOptions = {
  level: (process.env.LOG_LEVEL as LogLevel) || 'info',
  format: process.env.LOG_FORMAT === 'json' ? 'json' : 'pretty',
  redact: process.env.LOG_REDACT !== 'false',
}

export function configureLogger(options: Partial<LoggerOptions>): void {
  currentOptions = { ...currentOptions, ...options }
}

export interface LogContext {
  requestId?: string
  [key: string]: unknown
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentOptions.level]
}

function format(level: LogLevel, message: string, context: LogContext): string {
  const safeMessage = currentOptions.redact ? sanitize(message) : message
  const safeContext: LogContext = currentOptions.redact
    ? Object.fromEntries(
        Object.entries(context).map(([k, v]) => [k, typeof v === 'string' ? sanitize(v) : v]),
      )
    : context

  if (currentOptions.format === 'json') {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message: safeMessage,
      ...safeContext,
    })
  }

  const ts = new Date().toISOString().slice(11, 23)
  const reqId = safeContext.requestId ? ` [${safeContext.requestId}]` : ''
  const color = COLORS[level]
  const icon = ICONS[level]
  const extra = Object.entries(safeContext)
    .filter(([k]) => k !== 'requestId')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ')
  const extraStr = extra ? ` | ${extra}` : ''
  return `${color}${ts} ${icon} ${level.toUpperCase()}${RESET}${reqId} ${safeMessage}${extraStr}`
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  if (!shouldLog(level)) return
  const line = format(level, message, context) + '\n'
  if (level === 'warn' || level === 'error') {
    process.stderr.write(line)
  } else {
    process.stdout.write(line)
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => write('debug', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
  child: (baseContext: LogContext) => ({
    debug: (message: string, context?: LogContext) =>
      write('debug', message, { ...baseContext, ...context }),
    info: (message: string, context?: LogContext) =>
      write('info', message, { ...baseContext, ...context }),
    warn: (message: string, context?: LogContext) =>
      write('warn', message, { ...baseContext, ...context }),
    error: (message: string, context?: LogContext) =>
      write('error', message, { ...baseContext, ...context }),
  }),
}

export type Logger = typeof logger
export type ChildLogger = ReturnType<typeof logger.child>
