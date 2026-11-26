import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFilesystemDocumentStore } from './filesystem-store'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import { attachReconciliation } from './reconciliation-dom'
import { SETTLE_MS } from './folder-rescan'
import type { FolderWatch } from '../../native/folder-watch'

/** A watch the test speaks for. */
function testWatch() {
    let heard: ((paths: readonly string[] | null) => void) | null = null
    const watch: FolderWatch = (onChange) => {
        heard = onChange
        return () => { heard = null }
    }
    return { watch, change: (paths: readonly string[] | null) => heard?.(paths) }
}

describe('the passes a watched Folder graph runs', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    async function world() {
        const adapter = createMemoryDirectoryAdapter({ now: (() => { let t = 1000; return () => (t += 1000) })(), seed: { pages: { 'Garden.md': '- beans', 'Kitchen.md': '- pans' } } })
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        const garden = store.open('Garden')
        await store.whenReady('Garden')
        const reconcile = vi.spyOn(store, 'reconcile')
        const { watch, change } = testWatch()
        const detach = attachReconciliation(store, { watch, pollMs: 1_000_000 })
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 4)
        reconcile.mockClear()
        return { adapter, store, garden, reconcile, change, detach }
    }

    it('runs none for the app’s own save of an open document, or for a file it reads nothing of', async () => {
        const { garden, store, reconcile, change, detach } = await world()
        garden.applyChange({ from: garden.getText().length, to: garden.getText().length, insert: '\n- peas' })
        await store.flushAll()
        change(['pages/Garden.md', 'pages/.etherpk-1a2b.crswap', 'assets/bed.png'])
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 4)
        expect(reconcile).not.toHaveBeenCalled()
        detach()
    })

    it('runs one for another program’s edit of an open document', async () => {
        const { adapter, reconcile, change, detach } = await world()
        await adapter.write('pages', 'Garden.md', '- beans\n- from outside')
        change(['pages/Garden.md'])
        await vi.advanceTimersByTimeAsync(SETTLE_MS * 4)
        expect(reconcile).toHaveBeenCalledTimes(1)
        detach()
    })

    it('runs one for a document that is not open, a folder of documents, or a change the shell could not place', async () => {
        const { reconcile, change, detach } = await world()
        for (const paths of [['pages/Kitchen.md'], ['pages'], null]) {
            reconcile.mockClear()
            change(paths)
            await vi.advanceTimersByTimeAsync(SETTLE_MS * 8)
            expect(reconcile).toHaveBeenCalledTimes(1)
        }
        detach()
    })
})
