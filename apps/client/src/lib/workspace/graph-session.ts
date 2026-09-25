/**
 * Framework-free owner for one graph workspace lifetime.
 *
 * Svelte owns rendering, while this object owns cancellation, resource teardown and
 * presenter transition ordering. Every asynchronous graph-open boundary should pass
 * through an attempt's `wait()`, which rejects as soon as the attempt is superseded or
 * the workspace is disposed.
 */

export class GraphSessionCancelledError extends Error {
    constructor(readonly graphId: string) {
        super(`Graph session "${graphId}" was cancelled`)
        this.name = 'GraphSessionCancelledError'
    }
}

export interface GraphOpenAttempt {
    readonly signal: AbortSignal
    wait<T>(work: Promise<T>): Promise<T>
    checkpoint(): void
    isCurrent(): boolean
    /** Own a candidate resource until this attempt is committed or cancelled. */
    own(dispose: () => void | Promise<void>): void
    /** Promote all candidate resources into the session's lifetime. */
    commit(): void
    /** Abandon this attempt and release candidates immediately. */
    discard(): void
}

export interface GraphSession {
    readonly graphId: string
    beginOpen(): GraphOpenAttempt
    own(dispose: () => void | Promise<void>): () => void
    transitionPresenter<T>(transition: () => Promise<T>): Promise<T>
    dispose(): Promise<void>
    isDisposed(): boolean
}

export function createGraphSession(graphId: string): GraphSession {
    let disposed = false
    let generation = 0
    let currentAbort: AbortController | undefined
    let cancelCurrentCandidates: (() => void) | undefined
    const disposers: Array<() => void | Promise<void>> = []
    let disposePromise: Promise<void> | undefined
    let presenterTail: Promise<void> = Promise.resolve()

    function cancelled(): GraphSessionCancelledError {
        return new GraphSessionCancelledError(graphId)
    }

    function beginOpen(): GraphOpenAttempt {
        if (disposed) throw cancelled()
        currentAbort?.abort()
        cancelCurrentCandidates?.()
        const attemptGeneration = ++generation
        const abort = new AbortController()
        currentAbort = abort
        let committed = false
        const candidates: Array<() => void | Promise<void>> = []
        const discardCandidates = () => {
            if (committed) return
            const owned = candidates.splice(0).reverse()
            for (const release of owned) void release()
        }
        cancelCurrentCandidates = discardCandidates

        const isCurrent = () =>
            !disposed &&
            !abort.signal.aborted &&
            attemptGeneration === generation
        const checkpoint = () => {
            if (!isCurrent()) throw cancelled()
        }
        return {
            signal: abort.signal,
            checkpoint,
            isCurrent,
            own(dispose) {
                checkpoint()
                candidates.push(dispose)
            },
            commit() {
                checkpoint()
                if (committed) return
                committed = true
                // Session-level teardown was registered before open. Prepending candidates
                // means reverse-order disposal clears UI/listeners first, then releases
                // index, assets, store and cache in dependency order.
                disposers.unshift(...candidates.splice(0))
            },
            discard() {
                if (attemptGeneration !== generation || committed) return
                abort.abort()
                discardCandidates()
            },
            async wait<T>(work: Promise<T>): Promise<T> {
                checkpoint()
                let onAbort: (() => void) | undefined
                const aborted = new Promise<never>((_resolve, reject) => {
                    onAbort = () => reject(cancelled())
                    abort.signal.addEventListener('abort', onAbort, { once: true })
                })
                try {
                    const value = await Promise.race([work, aborted])
                    checkpoint()
                    return value
                } finally {
                    if (onAbort) abort.signal.removeEventListener('abort', onAbort)
                }
            },
        }
    }

    function own(dispose: () => void | Promise<void>): () => void {
        if (disposed) {
            void dispose()
            return () => {}
        }
        disposers.push(dispose)
        let removed = false
        return () => {
            if (removed) return
            removed = true
            const index = disposers.indexOf(dispose)
            if (index >= 0) disposers.splice(index, 1)
        }
    }

    async function transitionPresenter<T>(transition: () => Promise<T>): Promise<T> {
        if (disposed) throw cancelled()
        const run = presenterTail.then(async () => {
            if (disposed) throw cancelled()
            const value = await transition()
            if (disposed) throw cancelled()
            return value
        })
        presenterTail = run.then(
            () => {},
            () => {},
        )
        return run
    }

    function dispose(): Promise<void> {
        if (disposePromise) return disposePromise
        disposed = true
        generation += 1
        currentAbort?.abort()
        disposePromise = (async () => {
            const owned = disposers.splice(0).reverse()
            for (const release of owned) {
                try {
                    await release()
                } catch {
                    // Teardown is best-effort across independent resources. One failed
                    // disposer must never strand the socket, worker or later listeners.
                }
            }
            cancelCurrentCandidates?.()
        })()
        return disposePromise
    }

    return {
        graphId,
        beginOpen,
        own,
        transitionPresenter,
        dispose,
        isDisposed: () => disposed,
    }
}
