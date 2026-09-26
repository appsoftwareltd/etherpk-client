/**
 * Structured logger with console and OpenObserve output.
 *
 * - Logs structured JSON to OpenObserve when OPENOBSERVE_URL is set
 * - Always logs to console as a fallback
 * - Respects LOG_LEVEL for filtering
 * - Batches OpenObserve shipments to reduce HTTP overhead
 *
 * Framework-agnostic — no SvelteKit imports. Callers pass env values explicitly.
 *
 * Usage (SvelteKit hooks.server.ts):
 *   import { env } from '$env/dynamic/private'
 *   import { initLoggerFromEnv, logger } from '$lib/server/logger'
 *   initLoggerFromEnv({ logLevel: env.LOG_LEVEL, openObserveUrl: env.OPENOBSERVE_URL, ... })
 *
 * Usage (standalone scripts like migrate.ts):
 *   import { initLoggerFromEnv, shutdownLogger, logger } from './lib/server/logger'
 *   initLoggerFromEnv({ logLevel: process.env.LOG_LEVEL, ... })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
    timestamp: string
    level: LogLevel
    message: string
    [key: string]: unknown
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
}

const FLUSH_INTERVAL_MS = 5_000
const MAX_BATCH_SIZE = 100

let openObserveUrl: string | undefined
let openObserveAuth: string | undefined
let minLevel: LogLevel = 'info'
let buffer: LogEntry[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

/**
 * Initialise the logger from explicit values.
 * Call once at startup — from hooks.server.ts (with $env values) or standalone scripts (with process.env).
 */
export function initLoggerFromEnv(opts: {
    logLevel?: string
    openObserveUrl?: string
    openObserveAuth?: string
}): void {
    const level = opts.logLevel as LogLevel
    minLevel = (level && level in LEVEL_ORDER) ? level : 'info'
    openObserveUrl = opts.openObserveUrl || undefined
    openObserveAuth = opts.openObserveAuth || undefined

    if (openObserveUrl && !flushTimer) {
        flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
        // Allow the process to exit even if the timer is pending
        if (flushTimer.unref) flushTimer.unref()
    }

    // Diagnostic: confirm init in console so production config issues are visible
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'Logger initialised',
        logLevel: minLevel,
        openObserve: openObserveUrl ? 'enabled' : 'disabled',
        openObserveUrl: openObserveUrl ?? null
    }))
}

/**
 * Gracefully shut down — flush remaining logs and clear the timer.
 */
export async function shutdownLogger(): Promise<void> {
    if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
    }
    await flush()
}

/**
 * Reset internal state (for tests only).
 */
export function _resetLogger(): void {
    if (flushTimer) {
        clearInterval(flushTimer)
        flushTimer = null
    }
    buffer = []
    openObserveUrl = undefined
    openObserveAuth = undefined
    minLevel = 'info'
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return

    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...extra
    }

    // Always write to console
    const consoleFn =
        level === 'error' ? console.error
            : level === 'warn' ? console.warn
                : level === 'debug' ? console.debug
                    : console.log
    consoleFn(JSON.stringify(entry))

    // Buffer for OpenObserve
    if (openObserveUrl) {
        buffer.push(entry)
        if (buffer.length >= MAX_BATCH_SIZE) {
            void flush()
        }
    }
}

/**
 * Flush buffered log entries to OpenObserve.
 */
export async function flush(): Promise<void> {
    if (!openObserveUrl || buffer.length === 0) return

    const batch = buffer
    buffer = []

    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (openObserveAuth) {
            headers['Authorization'] = openObserveAuth
        }

        const response = await fetch(openObserveUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(5_000)
        })

        if (!response.ok) {
            console.error(
                `[logger] OpenObserve POST failed: ${response.status} ${response.statusText}`
            )
        }
    } catch (err) {
        console.error(
            `[logger] OpenObserve POST error: ${err instanceof Error ? err.message : String(err)}`
        )
    }
}

// ─── Public logging API ──────────────────────────────────────────────

export const logger = {
    debug(message: string, extra?: Record<string, unknown>): void {
        emit('debug', message, extra)
    },
    info(message: string, extra?: Record<string, unknown>): void {
        emit('info', message, extra)
    },
    warn(message: string, extra?: Record<string, unknown>): void {
        emit('warn', message, extra)
    },
    error(message: string, extra?: Record<string, unknown>): void {
        emit('error', message, extra)
    }
}
