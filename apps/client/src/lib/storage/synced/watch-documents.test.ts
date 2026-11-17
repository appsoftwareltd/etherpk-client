/**
 * Watching a document: hearing other devices' edits to it as they are made, without showing it.
 * A tab subscribes to the documents it shows; a view of tasks across documents (the Kanban board)
 * watches the documents its cards come from, so a move made on a phone or by an agent reaches the
 * board while it is open. A watch subscribes on the relay and nothing more: it keeps no engine
 * alive and says nothing of this device's presence in the document.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '#lib/crypto/index.js'
import { createRemoteGraphIndex } from '#lib/document/index-worker/client.js'
import { inlineTransport } from '#lib/document/index-worker/transport.js'
import { TASK_PRIORITY_FILTERS } from '#lib/document/index-db.js'
import { writeTaskChanges } from '#lib/document/task-write.js'
import { createLoopbackRelay } from '#lib/sync/loopback-relay.js'
import { device, eventually } from './sync-device-fixture'

async function twoDevices() {
    const relay = createLoopbackRelay()
    const keyring = createGraphKeyring('watch-documents')
    const a = await device(relay, keyring)
    await a.store.createPage('Garden', '- [ ] water the beans')
    await a.store.createPage('Kitchen', '- [ ] wipe the shelves')
    await a.graph.flushAll()
    const b = await device(relay, keyring)
    await eventually(() => expect(b.store.listIdentities().map((identity) => identity.concept).sort()).toEqual(['Garden', 'Kitchen']))
    return { a, b }
}

/** Every document the store announced as changed, in order. */
function changes(store: { onChange(listener: (change?: { concept: string }) => void): () => void }): string[] {
    const heard: string[] = []
    store.onChange((change) => {
        if (change) heard.push(change.concept)
    })
    return heard
}

describe('a watched document', () => {
    it("hears another device's edit as it is made, and says which document changed", async () => {
        const { a, b } = await twoDevices()
        // A has read Garden once, as a board's first move does, and then shows nothing of it.
        await a.store.whenCurrent('Garden')
        const release = a.store.watchDocuments(['Garden'])
        const heard = changes(a.store)

        expect((await writeTaskChanges(b.store, { concept: 'Garden', line: 0, text: 'water the beans' }, { status: 'doing' })).ok).toBe(true)
        await b.graph.flushAll()

        await eventually(() => expect(heard).toContain('Garden'))
        await eventually(async () => {
            await a.store.whenReady('Garden')
            expect(a.store.open('Garden').getText()).toBe('- [ ] #D water the beans')
        })
        release()
    })

    it.each([
        ['watched, as a board watches the documents its cards come from', true, '#D water the beans'],
        ['not watched, the index keeps what it had', false, 'water the beans'],
    ])("reaches this device's task index when %s", async (_name, watching, expected) => {
        const { a, b } = await twoDevices()
        const index = createRemoteGraphIndex(a.store, inlineTransport(), { graphId: 'watch-documents', debounceMs: 5 })
        await index.refresh()
        await a.store.whenCurrent('Garden')
        const release = watching ? a.store.watchDocuments(['Garden']) : () => {}
        const query = { concept: 'Garden', statuses: ['open', 'doing'] as const, priorities: TASK_PRIORITY_FILTERS, due: 'any' as const, groupBy: 'document' as const, today: '2026-11-17' }
        const texts = async () => (await index.tasks({ ...query, statuses: [...query.statuses] }, 0, 10)).hits.map((hit) => hit.text)

        expect((await writeTaskChanges(b.store, { concept: 'Garden', line: 0, text: 'water the beans' }, { status: 'doing' })).ok).toBe(true)
        await b.graph.flushAll()
        await new Promise((resolve) => setTimeout(resolve, 400))
        await index.settled?.()
        expect(await texts()).toEqual([expected])
        release()
        index.dispose()
    })

    it('is not heard once the watch is released', async () => {
        const { a, b } = await twoDevices()
        await a.store.whenCurrent('Kitchen')
        a.store.watchDocuments(['Kitchen'])()
        const heard = changes(a.store)

        expect((await writeTaskChanges(b.store, { concept: 'Kitchen', line: 0, text: 'wipe the shelves' }, { status: 'doing' })).ok).toBe(true)
        await b.graph.flushAll()
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(heard).not.toContain('Kitchen')
    })

    it('keeps no engine alive and shows no presence until an edit arrives', async () => {
        const { a } = await twoDevices()
        const before = a.graph.diagnostics().activeEngines
        const release = a.store.watchDocuments(['Garden', 'Kitchen'])
        expect(a.graph.diagnostics()).toMatchObject({ activeEngines: before, retainedDocuments: 1 })
        release()
    })

    it('is watched again after the connection drops and comes back', async () => {
        const { a, b } = await twoDevices()
        await a.store.whenCurrent('Garden')
        const release = a.store.watchDocuments(['Garden'])
        a.net.goOffline()
        await new Promise((resolve) => setTimeout(resolve, 50))
        a.net.goOnline()
        await eventually(() => expect(a.graph.isConnected()).toBe(true))
        const heard = changes(a.store)

        expect((await writeTaskChanges(b.store, { concept: 'Garden', line: 0, text: 'water the beans' }, { status: 'test' })).ok).toBe(true)
        await b.graph.flushAll()
        await eventually(() => expect(heard).toContain('Garden'))
        release()
    })
})
