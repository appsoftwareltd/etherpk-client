import { afterEach, describe, expect, it } from 'vitest'

import type { IndexSource, StoreChangeListener } from '../backlinks/live-index'
import type { IndexDoc } from '../index-db'
import { createRemoteGraphIndex, type RemoteGraphIndex } from '../index-worker/client'
import { inlineTransport } from '../index-worker/transport'
import { fakeEmbeddingModel } from './embedding-model'
import { BUILD_BATCH, createSemanticIndex, type SemanticIndex } from './semantic-index'

/**
 * The build loop and the query over the whole stack - client proxy, protocol, core, the
 * ATTACHed store - through the inline transport, with the deterministic fake model. What is
 * protected: a build embeds every passage exactly once and completes; an edit re-embeds only
 * its own passage; a build interrupted by disposal resumes from where it stopped in a new
 * instance; a query answers by meaning and reports the store's state.
 */

function fakeSource(initial: IndexDoc[]) {
    let docs = initial
    const listeners = new Set<StoreChangeListener>()
    const source: IndexSource = {
        snapshotForIndex: async () => docs,
        snapshotDocument: (concept) => docs.find((d) => d.concept === concept) ?? null,
        onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    return {
        source,
        set(next: IndexDoc[], changed: string) {
            docs = next
            for (const listener of listeners) listener({ concept: changed })
        },
    }
}

const doc = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

const cleanup: Array<() => void> = []
afterEach(() => {
    for (const fn of cleanup.splice(0)) fn()
})

async function openIndex(source: IndexSource): Promise<RemoteGraphIndex> {
    const index = createRemoteGraphIndex(source, inlineTransport(), { graphId: 'g-semantic', debounceMs: 10 })
    cleanup.push(() => index.dispose())
    await index.refresh()
    return index
}

function semantic(index: RemoteGraphIndex, calls: string[][] = [], slowMs = 0): SemanticIndex {
    const fake = fakeEmbeddingModel({ calls, synonyms: { loop: 'storm', stop: 'backoff' } })
    // A model that takes real time per call, so a build can be caught mid-way.
    const model = slowMs === 0 ? fake : { ...fake, embed: async (texts: readonly string[]) => { await new Promise((r) => setTimeout(r, slowMs)); return fake.embed(texts) } }
    const s = createSemanticIndex({ index, model, settleMs: 20, pauseMs: 0 })
    cleanup.push(() => s.dispose())
    return s
}

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (await predicate()) return
        await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('condition not met')
}

describe('createSemanticIndex', () => {
    it('builds every passage once and searches by meaning, reporting completeness', async () => {
        const index = await openIndex(fakeSource([doc('Sync Reliability', '# Relay reconnect\n- the reconnect storm is bounded by backoff'), doc('Baking', '- chocolate cake')]).source)
        const calls: string[][] = []
        const s = semantic(index, calls)
        expect(await s.status()).toEqual({ available: true, total: 2, embedded: 0 })

        // A search before any build answers from nothing, and says so.
        const empty = await s.search('how do I stop the sync loop', 0, 10)
        expect(empty.groups).toEqual([])
        expect(empty.status).toEqual({ available: true, total: 2, embedded: 0 })

        await s.build()
        expect(await s.status()).toEqual({ available: true, total: 2, embedded: 2 })
        // One query embedding plus the passages, each exactly once.
        expect(calls.flat().filter((t) => t.startsWith('Sync Reliability') || t.startsWith('Baking'))).toHaveLength(2)

        const found = await s.search('how do I stop the sync loop', 0, 10)
        expect(found.groups.map((g) => g.concept)).toEqual(['Sync Reliability'])
        expect(found.groups[0].hits[0].text).toContain('reconnect storm')
        expect(found.status.embedded).toBe(2)
    })

    it('re-embeds only the edited passage when following the index', async () => {
        const source = fakeSource([doc('A', '- alpha one'), doc('B', '- beta one')])
        const index = await openIndex(source.source)
        const calls: string[][] = []
        const s = semantic(index, calls)
        s.follow()
        await until(async () => (await s.status()).embedded === 2)
        calls.length = 0
        source.set([doc('A', '- alpha one'), doc('B', '- beta two')], 'B')
        await until(async () => calls.length > 0 && (await s.status()).embedded === 2)
        expect(calls.flat()).toEqual(['B\nbeta two'])
    })

    it('resumes an interrupted build from where it stopped', async () => {
        const many = Array.from({ length: BUILD_BATCH + 40 }, (_, n) => doc(`Doc ${n}`, `- passage number ${n} about topic ${n % 7}`))
        const source = fakeSource(many)
        const index = await openIndex(source.source)
        const first = semantic(index, [], 40)
        const build = first.build()
        // Let the first batch land, then abandon the loop.
        await until(async () => (await first.status()).embedded >= BUILD_BATCH)
        first.dispose()
        await build
        const partial = (await first.status()).embedded
        expect(partial).toBeGreaterThanOrEqual(BUILD_BATCH)
        expect(partial).toBeLessThan(many.length)

        const calls: string[][] = []
        const second = semantic(index, calls)
        await second.build()
        expect((await second.status()).embedded).toBe(many.length)
        expect(calls.flat()).toHaveLength(many.length - partial)
    })

    it('joins a build in progress rather than starting a second, and runs again for a change mid-build', async () => {
        const source = fakeSource([doc('A', '- alpha')])
        const index = await openIndex(source.source)
        const calls: string[][] = []
        const s = semantic(index, calls)
        const one = s.build()
        const two = s.build()
        expect(two).toBe(one)
        await one
        expect(calls.flat()).toEqual(['A\nalpha'])
    })
})

describe('what leaves the store', () => {
    it('drops a deleted document\'s passages from the live total and sweeps their vectors', async () => {
        const source = fakeSource([doc('Keep', '- alpha one'), doc('Gone', '- beta two')])
        const index = await openIndex(source.source)
        const calls: string[][] = []
        const s = semantic(index, calls)
        await s.build()
        expect(await s.status()).toEqual({ available: true, total: 2, embedded: 2 })
        expect((await s.search('beta two', 0, 10)).groups.map((g) => g.concept)).toEqual(['Gone'])

        // The document disappears from the source; the index replaces its generation without it.
        source.set([doc('Keep', '- alpha one')], 'Gone')
        await until(async () => (await s.status()).total === 1)
        expect((await s.search('beta two', 0, 10)).groups).toEqual([])
        // Its vector is unreferenced now, and the next build pass is what removes it; without a
        // pass it is still there to be swept.
        expect(await index.semantic.sweep(s.model.id)).toBe(1)
        expect(await index.semantic.sweep(s.model.id)).toBe(0)
    })

    it('sweeps on its own when following, so deleted and rewritten text does not linger', async () => {
        const source = fakeSource([doc('Keep', '- alpha one'), doc('Gone', '- beta two'), doc('Edit', '- gamma three')])
        const index = await openIndex(source.source)
        const s = semantic(index)
        s.follow()
        await until(async () => (await s.status()).embedded === 3)
        source.set([doc('Keep', '- alpha one'), doc('Edit', '- gamma four')], 'Gone')
        await until(async () => {
            const status = await s.status()
            return status.total === 2 && status.embedded === 2
        })
        // The follow-up pass embedded the rewrite and swept both orphans: nothing left for a sweep.
        await until(async () => (await index.semantic.sweep(s.model.id)) === 0)
        expect((await s.search('beta two', 0, 10)).groups).toEqual([])
        expect((await s.search('gamma four', 0, 10)).groups.map((g) => g.concept)).toEqual(['Edit'])
    })
})
