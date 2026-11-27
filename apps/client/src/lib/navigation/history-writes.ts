/**
 * The Client's shallow history writes, one after another.
 *
 * Since SvelteKit 3 a shallow `goto` changes the address only after it has resolved the route, a
 * microtask or more after the call. The workspace and the Graphs page build each address from the
 * window's (`location.pathname`, `location.search`) and each state from `page.state`, so a write
 * that started before the one ahead of it finished would build on the old address and undo it.
 * A write passed here runs once every write queued before it has finished, and reads the address
 * and state then. A `history.back()` that must follow a write goes through here too, and so does
 * every `goto` that leaves those pages: a write still waiting would otherwise land on the page
 * that `goto` opened, and replace its address with the old page's.
 */

let pending: Promise<unknown> = Promise.resolve()

/** Told after each write, so a surface that shows the address reads it again (`current-address.ts`). */
const written = new Set<() => void>()

/** Call `listener` after every write, whether it succeeded or not. Returns a stop function. */
export function afterEachHistoryWrite(listener: () => void): () => void {
    written.add(listener)
    return () => written.delete(listener)
}

/**
 * Run `write` after the writes queued before it. The promise settles as `write` does. A failed
 * write is logged and does not hold up the ones after it. Each one is told to whatever shows the
 * address (`afterEachHistoryWrite`), since a shallow write never reaches `page.url`.
 */
export function queueHistoryWrite(write: () => unknown): Promise<void> {
    const run = pending.then(async () => {
        try {
            await write()
        } finally {
            for (const listener of written) listener()
        }
    })
    pending = run.catch((error: unknown) => console.warn('[navigation] history write failed', error))
    return run
}
