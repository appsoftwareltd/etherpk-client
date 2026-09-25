import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type IndexDoc, backlinkCount, backlinksFor } from './backlink-index'
import { type IndexSource, createGraphIndex } from './live-index'

/** A controllable IndexSource: swap the docs, fire onChange on demand. */
function fakeSource() {
    let docs: IndexDoc[] = []
    const listeners = new Set<() => void>()
    return {
        setDocs(next: IndexDoc[]) {
            docs = next
        },
        fireChange() {
            for (const l of listeners) l()
        },
        source: {
            async snapshotForIndex() {
                return docs
            },
            onChange(listener: () => void) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        } satisfies IndexSource,
    }
}

const doc = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

describe('createGraphIndex', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('is empty until refreshed, then reflects the snapshot', async () => {
        const f = fakeSource()
        const index = createGraphIndex(f.source, { debounceMs: 100 })
        expect(backlinkCount(backlinksFor(index.get(), 'Physics'))).toBe(0)

        f.setDocs([doc('Physics', ''), doc('A', '[[Physics]]')])
        await index.refresh()
        expect(backlinkCount(backlinksFor(index.get(), 'Physics'))).toBe(1)
        index.dispose()
    })

    it('rebuilds (debounced) on a source change and notifies subscribers', async () => {
        const f = fakeSource()
        const index = createGraphIndex(f.source, { debounceMs: 100 })
        let updates = 0
        index.onUpdated(() => updates++)

        f.setDocs([doc('Physics', ''), doc('A', '[[Physics]]'), doc('B', '[[Physics]]')])
        f.fireChange()
        expect(updates).toBe(0) // debounced, not yet
        await vi.advanceTimersByTimeAsync(100)
        expect(updates).toBe(1)
        expect(backlinkCount(backlinksFor(index.get(), 'Physics'))).toBe(2)
        index.dispose()
    })

    it('coalesces rapid changes into one rebuild', async () => {
        const f = fakeSource()
        const index = createGraphIndex(f.source, { debounceMs: 100 })
        let updates = 0
        index.onUpdated(() => updates++)
        f.fireChange()
        f.fireChange()
        f.fireChange()
        await vi.advanceTimersByTimeAsync(100)
        expect(updates).toBe(1)
        index.dispose()
    })

    it('stops rebuilding after dispose', async () => {
        const f = fakeSource()
        const index = createGraphIndex(f.source, { debounceMs: 100 })
        let updates = 0
        index.onUpdated(() => updates++)
        index.dispose()
        f.fireChange()
        await vi.advanceTimersByTimeAsync(100)
        expect(updates).toBe(0)
    })
})
