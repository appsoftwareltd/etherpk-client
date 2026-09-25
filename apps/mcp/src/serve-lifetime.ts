/**
 * What ends a `serve`, and that whichever comes first ends it once.
 *
 * An MCP client shuts a stdio server down in the order the protocol's lifecycle gives: close
 * the server's stdin, wait for it to exit, and only then SIGTERM, then SIGKILL. So EOF on stdin
 * is an end - once a client has spoken. Before one has, it is not: `serve … </dev/null &` is
 * the documented way to keep a graph's embedding store current with no agent attached, and its
 * stdin is at EOF before the first line is served. A serve that ignored EOF altogether (0.7.0)
 * made every client wait out its grace period and signal instead (2026-09-21, reported from
 * Windows 11; the SDK's own client waits two seconds before it sends SIGTERM).
 *
 * "Spoken" is a byte on stdin, not the `initialized` notification: the byte is seen in the same
 * `data` event the SDK reads it from, while the notification's handler runs a microtask later,
 * and a client that sends `initialized` and closes in one write would race it.
 */

export type ServeEnd = 'SIGINT' | 'SIGTERM' | 'the transport closed' | 'the client closed stdin'

export interface ServeLifetimeDeps {
    /** `process`: SIGINT and SIGTERM. */
    signals: { on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown }
    /** `process.stdin`: a first byte means a client is speaking; `end` after that is the client leaving. */
    stdin: { once(event: 'data' | 'end', listener: () => void): unknown }
    /** Given the listener for the transport's own close (`transport.onclose`). */
    transportClosed(listener: () => void): void
    /** Flush, dispose and exit. Called once, with the first end to arrive. */
    shutdown(end: ServeEnd): Promise<void>
}

/** Bind every end to one single-flight shutdown; returns it, for an end the caller finds itself. */
export function bindServeLifetime(deps: ServeLifetimeDeps): (end: ServeEnd) => Promise<void> {
    let ending: Promise<void> | undefined
    const shutdown = (end: ServeEnd): Promise<void> => (ending ??= deps.shutdown(end))
    let spoken = false
    deps.stdin.once('data', () => {
        spoken = true
    })
    deps.stdin.once('end', () => {
        if (spoken) void shutdown('the client closed stdin')
    })
    deps.signals.on('SIGINT', () => void shutdown('SIGINT'))
    deps.signals.on('SIGTERM', () => void shutdown('SIGTERM'))
    deps.transportClosed(() => void shutdown('the transport closed'))
    return shutdown
}
