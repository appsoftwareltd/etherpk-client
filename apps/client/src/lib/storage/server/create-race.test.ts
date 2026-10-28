import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createGraphKeyring, type GraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { type Relay, device, entriesFor, eventually, textOf } from './sync-device-fixture'

// Two devices creating a document for one name before either hears of the other's (ADR 0157).

const DAY = '2026-03-14'

describe('two devices creating one name', () => {
    it('share one journal entry holding both texts when both start the day offline', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-day')
        const a = await device(relay, keyring, { online: false })
        const b = await device(relay, keyring, { online: false })

        await a.store.createJournal(DAY, '- water the beans\n')
        await b.store.createJournal(DAY, '- feed the cat\n')
        a.net.goOnline()
        b.net.goOnline()

        for (const d of [a, b]) {
            await eventually(async () => {
                expect(entriesFor(d, DAY)).toHaveLength(1)
                const text = await textOf(d, DAY)
                expect(text).toContain('- water the beans')
                expect(text).toContain('- feed the cat')
            })
        }
    })

    it('hold one copy of a Journal Template both devices started the day with', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-template')
        const a = await device(relay, keyring, { online: false })
        const b = await device(relay, keyring, { online: false })
        const template = '## Morning\n- \n'

        await a.store.createJournal(DAY, `${template}- water the beans\n`, { template })
        await b.store.createJournal(DAY, `${template}- feed the cat\n`, { template })
        a.net.goOnline()
        b.net.goOnline()

        for (const d of [a, b]) {
            await eventually(async () => {
                const text = await textOf(d, DAY)
                expect(text.split('## Morning')).toHaveLength(2)
                expect(text.startsWith(template)).toBe(true)
                expect(text).toContain('- water the beans')
                expect(text).toContain('- feed the cat')
            })
        }
    })

    it('keep both templates when the devices started the day with different ones', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-templates')
        const a = await device(relay, keyring, { online: false })
        const b = await device(relay, keyring, { online: false })

        await a.store.createJournal(DAY, '## Morning\n', { template: '## Morning\n' })
        await b.store.createJournal(DAY, '## Evening\n', { template: '## Evening\n' })
        a.net.goOnline()
        b.net.goOnline()

        await eventually(async () => {
            const text = await textOf(a, DAY)
            expect(text).toContain('## Morning')
            expect(text).toContain('## Evening')
        })
    })

    it('keep opening their own page when the other device\'s arrives, so an open tab stays on its text', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-stable')
        const a = await device(relay, keyring, { online: false })
        const b = await device(relay, keyring, { online: false })
        await a.store.createPage('Garden', '- water the beans\n')
        await b.store.createPage('Garden', '- feed the cat\n')
        const own = [a.store.documentIdOf('Garden'), b.store.documentIdOf('Garden')]
        a.net.goOnline()
        b.net.goOnline()

        for (const d of [a, b]) await eventually(() => expect(entriesFor(d, 'Garden')).toHaveLength(2))
        expect([a.store.documentIdOf('Garden'), b.store.documentIdOf('Garden')]).toEqual(own)
        expect(await textOf(a, 'Garden')).toBe('- water the beans\n')
        expect(await textOf(b, 'Garden')).toBe('- feed the cat\n')
    })

    it('adopt the document another device created when the registry catches up within the wait', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-confirm')
        const a = await device(relay, keyring)
        const b = await device(relay, keyring)
        b.net.goOffline()

        await a.store.createPage('Garden', '- plant the seeds\n')
        await a.graph.flushAll()
        await a.graph.awaitAcked({ stallMs: 2000 })

        // B reconnects, and is connected but has not yet heard the registry's catch-up.
        b.net.hold()
        b.net.goOnline()
        await eventually(() => expect(b.graph.isConnected()).toBe(true))
        const created = b.store.createPage('Garden', '- water the seeds\n')
        setTimeout(() => b.net.release(), 50)

        await expect(created).rejects.toThrow(/already exists/)
        expect(entriesFor(b, 'Garden')).toHaveLength(1)
    })

    it('create at once while offline, without waiting for a registry that cannot arrive', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-race-offline')
        const a = await device(relay, keyring, { online: false })
        const started = Date.now()
        await a.store.createPage('Garden', '- plant the seeds\n')
        expect(Date.now() - started).toBeLessThan(1000)
        expect(entriesFor(a, 'Garden')).toHaveLength(1)
    })
})

describe('a journal day deleted and started again', () => {
    async function deletedDay(relay: Relay, keyring: GraphKeyring): Promise<void> {
        const a = await device(relay, keyring)
        await a.store.createJournal(DAY, '- the old line\n')
        await a.graph.flushAll()
        await a.graph.awaitAcked({ stallMs: 2000 })
        await a.store.deleteDocument(DAY)
        await a.graph.flushAll()
        await a.graph.awaitAcked({ stallMs: 2000 })
        await a.store.dispose()
    }

    it('keeps the new text when another device starts it again online', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-recreate-online')
        await deletedDay(relay, keyring)

        const b = await device(relay, keyring)
        await b.store.createJournal(DAY, '- the new line\n')
        await b.graph.flushAll()

        const c = await device(relay, keyring)
        await eventually(async () => expect(await textOf(c, DAY)).toBe('- the new line\n'))
        expect(await textOf(b, DAY)).toBe('- the new line\n')
    })

    // Several rounds: the device's registry entry is a concurrent set of a key another device set
    // and deleted, and which of two concurrent sets Yjs keeps turns on the devices' client ids.
    it.each([1, 2, 3, 4, 5, 6])('keeps the new text when another device started it again offline (round %i)', async (round) => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring(`g-recreate-offline-${round}`)
        const b = await device(relay, keyring)
        b.net.goOffline()
        await deletedDay(relay, keyring)

        await b.store.createJournal(DAY, '- the new line\n', { template: '- the new line\n' })
        b.net.goOnline()
        await eventually(async () => expect(b.graph.activity().unsentDocuments).toBe(0))

        const c = await device(relay, keyring)
        await eventually(async () => expect(await textOf(c, DAY)).toBe('- the new line\n'))
        expect(await textOf(b, DAY)).toBe('- the new line\n')
    })

    it('shows no deleted text on a device whose cache held the day before it was deleted', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-recreate-cache')
        const a = await device(relay, keyring)
        await a.store.createJournal(DAY, '- the old line\n')
        await a.graph.flushAll()
        await a.graph.awaitAcked({ stallMs: 2000 })

        // B reads the day into its Local Cache, then closes.
        const b = await device(relay, keyring)
        await eventually(async () => expect(await textOf(b, DAY)).toBe('- the old line\n'))
        await b.graph.flushAll()
        const cacheName = b.cacheName
        await b.store.dispose()

        await a.store.deleteDocument(DAY)
        await a.graph.flushAll()
        await a.graph.awaitAcked({ stallMs: 2000 })
        await a.store.dispose()
        // Started again by a device that never held the old text, so nothing it sends deletes it.
        const fresh = await device(relay, keyring)
        await fresh.store.createJournal(DAY, '- the new line\n')
        await fresh.graph.flushAll()
        await fresh.graph.awaitAcked({ stallMs: 2000 })

        const again = await device(relay, keyring, { cacheName })
        await eventually(async () => expect(await textOf(again, DAY)).toBe('- the new line\n'))
    })
})
