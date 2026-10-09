import { describe, expect, it, vi } from 'vitest'

import type { LinkGraph } from '@appsoftwareltd/etherpk-extension-api'
import type { IndexUpdate } from '@appsoftwareltd/etherpk-extension-api'

import { LinkGraphSource } from './link-graph-source'
import { linkGraphOf } from './model/link-graph-fixture'

const LINE_CHANGED: IndexUpdate = { full: false, changedConceptKeys: new Set(['a']), backlinkTargetsChanged: new Set(), mapsChanged: false }
const TEXT_ONLY: IndexUpdate = { full: false, changedConceptKeys: new Set(), backlinkTargetsChanged: new Set(), mapsChanged: false }

/**
 * An index that answers each request only when the test says so, with a fresh copy of the
 * graph as it is then, the way the index worker's answers arrive (a new object every time).
 */
function fakeIndex(initial: LinkGraph) {
    let current = initial
    const waiting: { resolve: (graph: LinkGraph) => void; reject: (error: Error) => void }[] = []
    const listeners = new Set<(update: IndexUpdate) => void>()
    const index = {
        linkGraph: vi.fn(
            () =>
                new Promise<LinkGraph>((resolve, reject) => {
                    waiting.push({ resolve, reject })
                }),
        ),
        onUpdated(listener: (update: IndexUpdate) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    return {
        index,
        listeners,
        /** Answer the oldest request with the graph as it is now. */
        answer() {
            waiting.shift()?.resolve(structuredClone(current))
        },
        fail() {
            waiting.shift()?.reject(new Error('the index worker stopped'))
        },
        /** Change the graph and report it, as a saved edit would. */
        update(next: LinkGraph, update: IndexUpdate = LINE_CHANGED) {
            current = next
            for (const listener of [...listeners]) listener(update)
        },
    }
}

const TWO = linkGraphOf({ pages: ['A', 'B'], links: [['A', 'B']] })
const THREE = linkGraphOf({ pages: ['A', 'B', 'C'], links: [['A', 'B'], ['B', 'C']] })

describe('LinkGraphSource', () => {
    it('gives two copies reading at once one request, one model and the same snapshot', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        source.onStale(() => {})
        const local = source.read()
        const whole = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(1)
        fake.answer()
        const [a, b] = await Promise.all([local, whole])
        expect(a).toBe(b)
        expect([...a.model.concepts.keys()]).toEqual(['a', 'b'])
        expect(a.model.graph.size).toBe(1)
    })

    it('answers a read from the last answer when nothing has changed since, without asking', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        source.onStale(() => {})
        const first = source.read()
        fake.answer()
        const before = await first
        expect(await source.read()).toBe(before)
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(1)
    })

    it('tells its listeners when a line may have changed, and asks again on the next read', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const stale = vi.fn()
        source.onStale(stale)
        const first = source.read()
        fake.answer()
        const before = await first
        fake.update(THREE)
        expect(stale).toHaveBeenCalledTimes(1)
        const next = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        const after = await next
        expect(after).not.toBe(before)
        expect([...after.model.concepts.keys()]).toEqual(['a', 'b', 'c'])
    })

    it('keeps the same snapshot when the new answer holds the same concepts and lines', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        source.onStale(() => {})
        const first = source.read()
        fake.answer()
        const before = await first
        // A wikilink typed and then deleted again: the index reports both, the lines end the same.
        fake.update(structuredClone(TWO))
        const next = source.read()
        fake.answer()
        expect(await next).toBe(before)
    })

    it('ignores an update that touched no concept and no wikilink', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const stale = vi.fn()
        source.onStale(stale)
        const first = source.read()
        fake.answer()
        const before = await first
        fake.update(TWO, TEXT_ONLY)
        expect(stale).not.toHaveBeenCalled()
        expect(await source.read()).toBe(before)
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(1)
    })

    it('never hands a read made after an update the answer to a request sent before it', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        source.onStale(() => {})
        const early = source.read()
        fake.update(THREE)
        const late = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        fake.answer()
        // The first request was answered after the change here, but the source cannot know that.
        expect((await early).model.concepts.size).toBe(3)
        expect((await late).model.concepts.size).toBe(3)
        // And once both are in, a further read needs no request.
        expect(await source.read()).toBe(await late)
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
    })

    it('fails every copy waiting on a failed request, and asks again on the next read', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        source.onStale(() => {})
        const local = source.read()
        const whole = source.read()
        fake.fail()
        await expect(local).rejects.toThrow('stopped')
        await expect(whole).rejects.toThrow('stopped')
        const retry = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        expect((await retry).model.concepts.size).toBe(2)
    })

    it('listens to the index only while a copy listens to it, and trusts nothing from before', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const stopLocal = source.onStale(() => {})
        const stopWhole = source.onStale(() => {})
        expect(fake.listeners.size).toBe(1)
        const first = source.read()
        fake.answer()
        await first
        stopLocal()
        expect(fake.listeners.size).toBe(1)
        stopWhole()
        expect(fake.listeners.size).toBe(0)
        // An edit nobody heard: the next copy to listen must not be given the old answer.
        fake.update(THREE)
        source.onStale(() => {})
        const next = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        expect((await next).model.concepts.size).toBe(3)
    })

    it('trusts no answer it read before it started listening', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const unheard = source.read()
        fake.answer()
        await unheard
        source.onStale(() => {})
        const next = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        await next
    })

    it('lets go of its last answer once no copy listens, rather than keeping a model nobody shows', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const stop = source.onStale(() => {})
        const first = source.read()
        fake.answer()
        const before = await first
        stop()
        source.onStale(() => {})
        const next = source.read()
        fake.answer()
        // The same concepts and lines, but built afresh: the old snapshot was not held on to.
        expect(await next).not.toBe(before)
    })

    it('asks the index on every read while nothing listens, since no update is heard', async () => {
        const fake = fakeIndex(TWO)
        const source = new LinkGraphSource(fake.index)
        const first = source.read()
        const second = source.read()
        expect(fake.index.linkGraph).toHaveBeenCalledTimes(2)
        fake.answer()
        fake.answer()
        await Promise.all([first, second])
    })
})
