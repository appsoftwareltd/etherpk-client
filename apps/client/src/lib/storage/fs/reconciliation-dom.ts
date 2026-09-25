/**
 * DOM glue for external-change detection. The File System Access API has no file
 * watcher, so we re-scan on window focus and on a light interval poll (DESIGN.md →
 * The git workflow). All decisions live in the store's `reconcile()`; this just
 * triggers it, guarding against overlapping runs.
 */

import type { FilesystemDocumentStore } from './filesystem-store'

export interface ReconciliationOptions {
    /** Poll interval (ms) while the tab is active. */
    pollMs?: number
}

/** Wire focus + poll to `store.reconcile()`. Returns a detach function. */
export function attachReconciliation(
    store: FilesystemDocumentStore,
    { pollMs = 4000 }: ReconciliationOptions = {},
): () => void {
    let running = false

    async function run() {
        if (running) return // never overlap reconcile passes
        running = true
        try {
            await store.reconcile()
        } finally {
            running = false
        }
    }

    const onFocus = () => void run()
    window.addEventListener('focus', onFocus)
    const timer = setInterval(() => void run(), pollMs)

    return () => {
        window.removeEventListener('focus', onFocus)
        clearInterval(timer)
    }
}
