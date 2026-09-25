/**
 * A raw IndexedDB connection that survives the browser closing it underneath the page.
 *
 * Browsers close a connection without the page asking when they evict or reclaim storage,
 * when a discarded tab is restored (common on Android), when the storage process crashes,
 * and when another tab opens a newer database version. From then on every `transaction()`
 * on the old handle throws `InvalidStateError: The database connection is closing`. Before
 * 2026-09-01 the sync Local Cache held one such handle for the life of the workspace, so a
 * page that stayed open kept failing every save until a reload, and the keystrokes typed in
 * between reached neither the cache nor the relay.
 *
 * This wrapper keeps the "one connection per cache" shape but notices the close (via the
 * `close` event, the `versionchange` event, or the synchronous throw) and reopens on the
 * next use. A reopen that fails is reported to the caller once rather than retried in a
 * loop, and `dispose()` closes for good.
 */
export interface ReopenableConnection {
    /** The live database, opening a fresh connection first if the last one was closed. */
    current(): Promise<IDBDatabase>
    /**
     * `current().transaction(stores, mode)`, retried once through a reopen when the handle
     * turns out to be closed. Call sites place their first request synchronously after
     * awaiting this, exactly as they would after a bare `db.transaction()`.
     */
    transaction(stores: string | string[], mode: IDBTransactionMode): Promise<IDBTransaction>
    /** Close for good. Later calls reject with {@link ConnectionDisposedError} rather than reopen. */
    dispose(): void
}

export class ConnectionDisposedError extends Error {
    constructor() {
        super('The IndexedDB connection has been disposed')
        this.name = 'ConnectionDisposedError'
    }
}

/**
 * The error `IDBDatabase.transaction()` throws once the connection has closed. Every engine
 * uses the `InvalidStateError` name for it; only the message wording differs.
 */
export function isClosedConnectionError(error: unknown): boolean {
    return error instanceof Error && error.name === 'InvalidStateError'
}

export async function createReopenableConnection(
    open: () => Promise<IDBDatabase>,
): Promise<ReopenableConnection> {
    let live: IDBDatabase | null = null
    let opening: Promise<IDBDatabase> | null = null
    let disposed = false

    const forget = (handle: IDBDatabase) => {
        if (live === handle) live = null
    }

    const attach = (handle: IDBDatabase): IDBDatabase => {
        live = handle
        // Fired when the browser terminates the connection abnormally. It is NOT fired for
        // the page's own close(), so the synchronous-throw path below still matters.
        handle.onclose = () => forget(handle)
        // A newer version is being opened elsewhere, typically a deploy picked up by another
        // tab. Releasing the handle lets that upgrade proceed instead of blocking it; the
        // next use reopens at whatever version the browser now holds, and a VersionError
        // there surfaces as a "reload this tab" rather than a silently stuck upgrade.
        handle.onversionchange = () => {
            handle.close()
            forget(handle)
        }
        return handle
    }

    attach(await open())

    async function current(): Promise<IDBDatabase> {
        if (disposed) throw new ConnectionDisposedError()
        if (live) return live
        if (!opening) {
            // One reopen at a time, and a failed one is not memoised: the next caller tries
            // afresh, which is what makes a transient VersionError recoverable after the
            // other tab's upgrade completes.
            opening = open()
                .then(attach)
                .finally(() => {
                    opening = null
                })
        }
        return opening
    }

    return {
        current,
        async transaction(stores, mode) {
            const first = await current()
            try {
                return first.transaction(stores, mode)
            } catch (error) {
                if (!isClosedConnectionError(error)) throw error
                // Closed without a `close` event reaching us yet. Drop the handle and go
                // through exactly one reopen; a second failure is the caller's to report.
                forget(first)
                return (await current()).transaction(stores, mode)
            }
        },
        dispose() {
            disposed = true
            live?.close()
            live = null
        },
    }
}
