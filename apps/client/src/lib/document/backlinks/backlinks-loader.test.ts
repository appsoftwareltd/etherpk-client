import { describe, expect, it } from 'vitest'

import type { ConceptCandidate, DbBacklinkGroup, DbBacklinkRef } from '../index-db'
import type { IndexUpdate } from '../index-worker/client'
import { conceptKey } from './backlink-index'
import { type BacklinksIndex, type BacklinksState, createBacklinksLoader, linksToConcept, updateNamesConcept } from './backlinks-loader'

/**
 * The loader behind both places Backlinks are shown, the panel and the section beneath every
 * document (ADR 0135): what it says while an answer is on its way, which answers it keeps, and
 * when it asks the index again.
 */

function ref(sourceConcept: string, line: number): DbBacklinkRef {
    return { sourceConcept, sourceKind: 'page', line, kind: 'prose', breadcrumb: [], subtree: [], context: { text: `line ${line}`, matchStart: 0, matchEnd: 0, truncated: false } }
}

function group(sourceConcept: string, lines: number[], sourceIsTarget = false): DbBacklinkGroup {
    return { sourceConcept, sourceKind: 'page', refs: lines.map((line) => ref(sourceConcept, line)), bodyNames: [], sourceIsTarget }
}

function update(names: string[] = [], full = false): IndexUpdate {
    return { full, changedConceptKeys: new Set(), backlinkTargetsChanged: new Set(names), mapsChanged: false }
}

/** An index whose answers the test hands out, in any order, one request at a time. */
function fakeIndex(aliases: Record<string, string> = {}) {
    const requests: { concept: string; resolve: (groups: DbBacklinkGroup[]) => void; reject: (error: Error) => void }[] = []
    const listeners = new Set<(update: IndexUpdate) => void>()
    const index: BacklinksIndex = {
        backlinks: (concept) => new Promise((resolve, reject) => requests.push({ concept, resolve, reject })),
        onUpdated(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        candidate(name) {
            const canonical = aliases[conceptKey(name)]
            return canonical
                ? ({ display: name, key: conceptKey(name), kind: 'alias', canonical } as ConceptCandidate)
                : ({ display: name, key: conceptKey(name), kind: 'page' } as ConceptCandidate)
        },
    }
    return {
        index,
        requests,
        asked: () => requests.map((request) => request.concept),
        notify: (next: IndexUpdate) => listeners.forEach((listener) => listener(next)),
        listening: () => listeners.size,
    }
}

/** Let the answers handed out reach the loader. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function loaderOver(index: BacklinksIndex | null, onScreen = true) {
    const seen: BacklinksState[] = []
    const loader = createBacklinksLoader({ index, onScreen, onChange: (state) => seen.push(state) })
    return { loader, seen }
}

describe('backlinks loader', () => {
    it('is idle with nothing to show, and with no index', () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        expect(loader.state()).toEqual({ concept: null, status: 'idle', groups: [], count: 0 })

        const { loader: without } = loaderOver(null)
        without.show('Garden')
        expect(without.state()).toMatchObject({ concept: 'Garden', status: 'idle' })
    })

    it('loads the concept it is shown, then holds its groups and how many references they have', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)

        loader.show('Garden')
        expect(loader.state()).toMatchObject({ concept: 'Garden', status: 'loading', groups: [] })
        expect(fake.asked()).toEqual(['Garden'])

        fake.requests[0].resolve([group('Kitchen', [1, 4]), group('Shed', [2])])
        await settle()

        expect(loader.state()).toMatchObject({ status: 'ready', count: 3 })
        expect(loader.state().groups.map((g) => g.sourceConcept)).toEqual(['Kitchen', 'Shed'])
    })

    // A document is never its own backlink (CONTEXT.md). The index keeps those links for a rename.
    it("leaves out the document's own references", async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)

        loader.show('Garden')
        fake.requests[0].resolve([group('Garden', [3], true), group('Kitchen', [1])])
        await settle()

        expect(loader.state().groups.map((g) => g.sourceConcept)).toEqual(['Kitchen'])
        expect(loader.state().count).toBe(1)
    })

    it("says it is loading, never another concept's answer, while a new concept's answer is on its way", async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        loader.show('Orchard')

        expect(loader.state()).toMatchObject({ concept: 'Orchard', status: 'loading', groups: [], count: 0 })
    })

    it('drops an answer that arrives after another concept was asked for', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        loader.show('Orchard')

        fake.requests[1].resolve([group('Shed', [2])])
        await settle()
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        expect(loader.state()).toMatchObject({ concept: 'Orchard', status: 'ready' })
        expect(loader.state().groups.map((g) => g.sourceConcept)).toEqual(['Shed'])
    })

    it('keeps its answer on screen while it asks again after an update', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        fake.notify(update(['garden']))

        expect(fake.asked()).toEqual(['Garden', 'Garden'])
        expect(loader.state()).toMatchObject({ status: 'ready', count: 1 })

        fake.requests[1].resolve([group('Kitchen', [1]), group('Shed', [5])])
        await settle()
        expect(loader.state().count).toBe(2)
    })

    it('fails a first fetch it has nothing to fall back on, and tries again when asked', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')

        fake.requests[0].reject(new Error('no answer'))
        await settle()
        expect(loader.state()).toMatchObject({ concept: 'Garden', status: 'failed' })

        loader.retry()
        expect(loader.state().status).toBe('loading')
        fake.requests[1].resolve([group('Kitchen', [1])])
        await settle()
        expect(loader.state().status).toBe('ready')
    })

    it('keeps the answer it has when a later fetch fails', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        fake.notify(update(['garden']))
        fake.requests[1].reject(new Error('no answer'))
        await settle()

        expect(loader.state()).toMatchObject({ status: 'ready', count: 1 })
    })

    it('asks nothing while off screen, and asks for what it was shown when it comes back', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index, false)

        loader.show('Garden')
        loader.show('Orchard')
        expect(fake.asked()).toEqual([])

        loader.setOnScreen(true)
        expect(fake.asked()).toEqual(['Orchard'])
    })

    it('asks again once on coming back, for every update it heard while off screen', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        loader.setOnScreen(false)
        fake.notify(update(['garden']))
        fake.notify(update(['garden']))
        expect(fake.asked()).toEqual(['Garden'])

        loader.setOnScreen(true)
        expect(fake.asked()).toEqual(['Garden', 'Garden'])
        // Its answer stays on screen meanwhile: the update did not change whose it is.
        expect(loader.state()).toMatchObject({ status: 'ready', count: 1 })
    })

    it('does not ask again on coming back when nothing changed while it was away', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([])
        await settle()

        loader.setOnScreen(false)
        loader.setOnScreen(true)

        expect(fake.asked()).toEqual(['Garden'])
    })

    it('asks again for an update naming the concept by an alias, and not for one about another concept', async () => {
        const fake = fakeIndex({ veg: 'Garden' })
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([])
        await settle()

        fake.notify(update(['kitchen']))
        expect(fake.asked()).toEqual(['Garden'])

        fake.notify(update(['veg']))
        expect(fake.asked()).toEqual(['Garden', 'Garden'])
    })

    it('asks again for a full update', async () => {
        const fake = fakeIndex()
        const { loader } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([])
        await settle()

        fake.notify(update([], true))

        expect(fake.asked()).toEqual(['Garden', 'Garden'])
    })

    // The section sits under the text being typed, and every edit to the document is an update
    // about it: an answer that has not changed must not redraw the references under the caret.
    it('does not report an answer that is the same as the one it holds', async () => {
        const fake = fakeIndex()
        const { loader, seen } = loaderOver(fake.index)
        loader.show('Garden')
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()
        const reported = seen.length
        const groups = loader.state().groups

        fake.notify(update(['garden']))
        fake.requests[1].resolve([group('Kitchen', [1])])
        await settle()

        expect(seen).toHaveLength(reported)
        expect(loader.state().groups).toBe(groups)
    })

    it('stops listening, and drops answers still on their way, once destroyed', async () => {
        const fake = fakeIndex()
        const { loader, seen } = loaderOver(fake.index)
        loader.show('Garden')
        expect(fake.listening()).toBe(1)

        loader.destroy()
        fake.requests[0].resolve([group('Kitchen', [1])])
        await settle()

        expect(fake.listening()).toBe(0)
        expect(seen.at(-1)?.status).toBe('loading')
    })
})

describe('updateNamesConcept', () => {
    const { index } = fakeIndex({ veg: 'Garden' })

    it('is true for a name of the concept, by any of its names, in any case', () => {
        expect(updateNamesConcept(update(['GARDEN']), 'Garden', index.candidate)).toBe(true)
        expect(updateNamesConcept(update(['veg']), 'Garden', index.candidate)).toBe(true)
        expect(updateNamesConcept(update(['garden']), 'Veg', index.candidate)).toBe(true)
    })

    it('reads the changed documents as well as the changed link targets', () => {
        const changed: IndexUpdate = { ...update(), changedConceptKeys: new Set(['veg']) }
        expect(updateNamesConcept(changed, 'Garden', index.candidate)).toBe(true)
    })

    it('is false for an update about other names only', () => {
        expect(updateNamesConcept(update(['kitchen', 'shed']), 'Garden', index.candidate)).toBe(false)
    })
})

describe('linksToConcept', () => {
    it('matches a link by the concept name or an alias, in any case, and nothing else', () => {
        const { index } = fakeIndex({ veg: 'Garden' })
        const matches = linksToConcept('Garden', index.candidate)

        expect(matches('garden')).toBe(true)
        expect(matches('Veg')).toBe(true)
        expect(matches('Kitchen')).toBe(false)
    })

    it('matches by name alone without an index', () => {
        const matches = linksToConcept('Garden', undefined)

        expect(matches('GARDEN')).toBe(true)
        expect(matches('Veg')).toBe(false)
    })
})
