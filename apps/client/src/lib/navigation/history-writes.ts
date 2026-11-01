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

/**
 * Run `write` after the writes queued before it. The promise settles as `write` does. A failed
 * write is logged and does not hold up the ones after it.
 */
export function queueHistoryWrite(write: () => unknown): Promise<void> {
    const run = pending.then(async () => {
        await write()
    })
    pending = run.catch((error: unknown) => console.warn('[navigation] history write failed', error))
    return run
}
