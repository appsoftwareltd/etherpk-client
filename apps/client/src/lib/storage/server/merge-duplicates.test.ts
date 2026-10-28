import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { armourProtected, createGraphKeyring, keyFingerprint, randomBytes, sealProtected } from '$lib/crypto'
import { CIPHER_FENCE_INFO } from '$lib/document/protection/fence-info'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { mergedText } from './duplicate-names'
import { type Device, device, entriesFor, eventually, textOf } from './sync-device-fixture'

// The person-confirmed Merge of a Duplicate Name (ADR 0157).

/**
 * A page named Garden for each text, as two devices that each created it offline leave it: one
 * registry entry per document, every one with the same title. Returns their ids in that order.
 */
async function duplicates(d: Device, texts: string[], aliases: string[][] = []): Promise<string[]> {
    const ids: string[] = []
    for (const [index, text] of texts.entries()) {
        const id = crypto.randomUUID()
        d.graph.registry().set(id, { kind: 'page', title: 'Garden', ...(aliases[index]?.length ? { aliases: aliases[index] } : {}) })
        d.graph.docSync(id).doc.getText('content').insert(0, text)
        ids.push(id)
    }
    await d.graph.flushAll()
    await d.graph.awaitAcked({ stallMs: 2000 })
    return ids
}

/** Each document's text as this device holds it, read once its engine has seeded. */
async function textsOf(d: Device, ids: string[]): Promise<Map<string, string>> {
    await Promise.all(ids.map((id) => d.graph.whenReady(id)))
    return new Map(ids.map((id) => [id, d.graph.docSync(id).doc.getText('content').toString()]))
}

describe('mergeDuplicates', () => {
    it('adds the other text to the first document, which keeps its block, and deletes the other', async () => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('g-merge-two')
        const a = await device(relay, keyring)
        const first = '---\ntitle: Garden\n---\n- plant the seeds\n'
        const ids = await duplicates(a, [first, '- water the seeds\n'], [[], ['Yard']])

        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids))).resolves.toBe('merged')

        const expected = mergedText([first, '- water the seeds\n'])
        expect(entriesFor(a, 'Garden').map((identity) => identity.docId)).toEqual([ids[0]])
        expect(a.graph.registry().get(ids[0])?.aliases).toEqual(['Yard'])
        expect(await textOf(a, 'Garden')).toContain('- plant the seeds\n\n- water the seeds\n')
        expect(['deleting', 'deleted']).toContain(a.graph.docSync(ids[1]).lifecycle())

        // Another device sees one document holding both texts.
        const b = await device(relay, keyring)
        await eventually(async () => {
            expect(entriesFor(b, 'Garden')).toHaveLength(1)
            const text = await textOf(b, 'Garden')
            expect(text).toContain('Yard')
            expect(text.endsWith(expected.slice(expected.indexOf('- plant')))).toBe(true)
        })
    })

    it('joins three documents in the order the person chose', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-three'))
        const ids = await duplicates(a, ['- one\n', '- two\n', '- three\n'])
        const order = [ids[2], ids[0], ids[1]]

        await expect(a.store.mergeDuplicates(order, await textsOf(a, ids))).resolves.toBe('merged')

        expect(entriesFor(a, 'Garden').map((identity) => identity.docId)).toEqual([ids[2]])
        expect(await textOf(a, 'Garden')).toBe('- three\n\n- one\n\n- two\n')
    })

    it('deletes the other document without adding its text again when the first already ends with it', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-same'))
        const ids = await duplicates(a, ['- water the beans\n', '- water the beans\n'])

        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids))).resolves.toBe('merged')

        expect(await textOf(a, 'Garden')).toBe('- water the beans\n')
        expect(entriesFor(a, 'Garden')).toHaveLength(1)
    })

    it('writes nothing when a text changed since the person read it', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-changed'))
        const ids = await duplicates(a, ['- one\n', '- two\n'])
        const read = await textsOf(a, ids)
        a.graph.docSync(ids[1]).doc.getText('content').insert(0, '- zero\n')

        await expect(a.store.mergeDuplicates(ids, read)).resolves.toBe('changed')

        expect(entriesFor(a, 'Garden')).toHaveLength(2)
        expect((await textsOf(a, ids)).get(ids[0])).toBe('- one\n')
    })

    it('never merges a Protected Document', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-protected'))
        const key = randomBytes(32)
        const armoured = armourProtected(await sealProtected({ key, fingerprint: await keyFingerprint(key), plaintext: 'the gate code', writtenAt: 1 }))
        const fenced = ['```' + CIPHER_FENCE_INFO, armoured, '```', ''].join('\n')
        const ids = await duplicates(a, ['- one\n', fenced])

        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids))).resolves.toBe('protected')

        expect(entriesFor(a, 'Garden')).toHaveLength(2)
        expect((await textsOf(a, ids)).get(ids[0])).toBe('- one\n')
    })

    it('waits for a connection, since nothing is deleted before the relay has the text', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-offline'))
        const ids = await duplicates(a, ['- one\n', '- two\n'])
        a.net.goOffline()
        await eventually(() => expect(a.graph.isConnected()).toBe(false))

        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids))).resolves.toBe('offline')
        expect(entriesFor(a, 'Garden')).toHaveLength(2)
    })

    it('keeps the other document when the relay does not acknowledge the addition, and adds it only once when asked again', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-unacked'))
        const ids = await duplicates(a, ['- one\n', '- two\n'])
        a.net.holdAcks()

        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids), { timeoutMs: 300 })).resolves.toBe('not-acknowledged')
        expect(entriesFor(a, 'Garden')).toHaveLength(2)
        expect((await textsOf(a, ids)).get(ids[0])).toBe('- one\n\n- two\n')

        a.net.release()
        await expect(a.store.mergeDuplicates(ids, await textsOf(a, ids))).resolves.toBe('merged')
        expect(await textOf(a, 'Garden')).toBe('- one\n\n- two\n')
    })

    it('keeps the other document when it changes while the addition is on its way', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-race'))
        const ids = await duplicates(a, ['- one\n', '- two\n'])
        a.net.holdAcks()

        const merging = a.store.mergeDuplicates(ids, (await textsOf(a, ids)))
        await eventually(async () => expect((await textsOf(a, ids)).get(ids[0])).toBe('- one\n\n- two\n'))
        a.graph.docSync(ids[1]).doc.getText('content').insert(7, '- three\n')
        a.net.release()

        await expect(merging).resolves.toBe('changed-after-append')
        expect(entriesFor(a, 'Garden')).toHaveLength(2)
        expect((await textsOf(a, ids)).get(ids[1])).toBe('- two\n- three\n')
    })

    it('reports a document deleted or renamed since it was read as gone', async () => {
        const relay = createLoopbackRelay()
        const a = await device(relay, createGraphKeyring('g-merge-gone'))
        const ids = await duplicates(a, ['- one\n', '- two\n'])
        const read = await textsOf(a, ids)
        a.graph.registry().set(ids[1], { kind: 'page', title: 'Kitchen' })

        await expect(a.store.mergeDuplicates(ids, read)).resolves.toBe('gone')
        expect((await textsOf(a, ids)).get(ids[0])).toBe('- one\n')
    })
})
