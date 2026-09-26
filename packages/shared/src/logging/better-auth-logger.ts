/**
 * Better Auth's log lines, written through the app's structured JSON logger.
 *
 * Left alone, better-auth 1.6.15 writes plain text to the console: `2026-09-24T... ERROR
 * [Better Auth]: User not found { email: '...' }`. That breaks a JSON log pipeline (OpenObserve
 * mis-parses the line), counts every mistyped password as an error, and keeps each address
 * somebody tried, including addresses with no account behind them. Pass
 * {@link createBetterAuthLogger} as `logger` to `betterAuth()` and the same events arrive as
 * structured lines with the address removed.
 *
 * The library reports a user's mistake (wrong password, unknown address, a password too short) at
 * `error` with a plain object or nothing beside the message; those become `warn` here. A genuine
 * failure (the database refusing a write, a background task throwing) arrives with an `Error`,
 * and stays at `error` with that error's stack, so it can still raise an alert.
 */

/** The app logger's shape: `logger` in `logging/logger.ts`. */
export interface AppLogger {
    debug(message: string, extra?: Record<string, unknown>): void
    info(message: string, extra?: Record<string, unknown>): void
    warn(message: string, extra?: Record<string, unknown>): void
    error(message: string, extra?: Record<string, unknown>): void
}

/** The levels Better Auth hands a custom `log`, after it has folded `success` into `info`. */
type BetterAuthLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Structurally Better Auth's `logger` option (`@better-auth/core` `Logger`). Declared here so
 * the shared package does not depend on better-auth for one type.
 */
export interface BetterAuthLoggerOption {
    level: BetterAuthLevel
    log?: (level: BetterAuthLevel, message: string, ...args: unknown[]) => void
}

const REDACTED = '[redacted]'
const REDACTED_EMAIL = '[redacted email]'

/** Keys whose value is dropped outright: an address, or anything credential-shaped. */
const SENSITIVE_KEY = /email|password|passphrase|secret|token|otp|code/i

/**
 * An email address inside free text. Deliberately loose: a false positive costs a redacted
 * word in a log line, a false negative puts an address in the log store.
 */
const EMAIL_IN_TEXT = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[^\s<>"'(),;:]+/g

/** How deep an argument is copied. Better Auth's arguments are flat; this only bounds a cycle. */
const MAX_DEPTH = 4

function redactValue(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return value.replace(EMAIL_IN_TEXT, REDACTED_EMAIL)
    if (value === null || typeof value !== 'object') return value
    if (value instanceof Error) {
        return {
            name: value.name,
            message: redactValue(value.message, depth),
            // The stack's first line repeats the message, so it is redacted the same way.
            ...(value.stack ? { stack: redactValue(value.stack, depth) } : {}),
        }
    }
    if (depth >= MAX_DEPTH) return '[truncated]'
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1),
        ]),
    )
}

/** Build the `logger` option for `betterAuth()` from the app's structured logger. */
export function createBetterAuthLogger(appLogger: AppLogger): BetterAuthLoggerOption {
    return {
        level: 'warn',
        log(level, message, ...args) {
            const failure = args.some((arg) => arg instanceof Error)
            const target = level === 'error' && !failure ? 'warn' : level
            const detail = args.length > 0 ? { detail: args.map((arg) => redactValue(arg, 0)) } : undefined
            appLogger[target](`better-auth: ${redactValue(message, 0) as string}`, detail)
        },
    }
}
