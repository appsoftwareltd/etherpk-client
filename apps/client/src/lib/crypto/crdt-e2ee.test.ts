import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { EnvelopeError, contextAad, openSymmetric, sealSymmetric } from './envelope'
import { createGraphKeyring, currentEpoch, keyForEpoch } from './keyring'

describe('E2EE CRDT round-trip (the ADR 0024 premise)', () => {
    it('out-of-order encrypted updates from two clients converge on any third', async () => {
        const keyring = createGraphKeyring('g1')
        const aad = contextAad('update', 'graph:g1', 'doc:d1')
        const seal = (update: Uint8Array) =>
            sealSymmetric({ key: currentEpoch(keyring).key, epochId: 1, plaintext: update, aad })
        const open = async (envelope: Uint8Array) =>
            (await openSymmetric({ keyForEpoch: (id) => keyForEpoch(keyring, id), envelope, aad })).plaintext

        const clientA = new Y.Doc()
        const clientB = new Y.Doc()
        clientA.getText('content').insert(0, 'hello ')
        clientB.getText('content').insert(0, 'world')
        // The "server" is just these two ciphertext blobs — it can order them, never read them.
        const envelopeA = await seal(Y.encodeStateAsUpdate(clientA))
        const envelopeB = await seal(Y.encodeStateAsUpdate(clientB))

        const joinsLate = new Y.Doc()
        Y.applyUpdate(joinsLate, await open(envelopeB))
        Y.applyUpdate(joinsLate, await open(envelopeA))
        const joinsEarly = new Y.Doc()
        Y.applyUpdate(joinsEarly, await open(envelopeA))
        Y.applyUpdate(joinsEarly, await open(envelopeB))

        expect(joinsLate.getText('content').toString()).toBe(joinsEarly.getText('content').toString())
        expect(joinsLate.getText('content').toString()).toContain('hello')
        expect(joinsLate.getText('content').toString()).toContain('world')
    })

    it('an envelope spliced onto another document is rejected (AAD binding)', async () => {
        const keyring = createGraphKeyring('g1')
        const doc = new Y.Doc()
        doc.getText('content').insert(0, 'secret')
        const envelope = await sealSymmetric({
            key: currentEpoch(keyring).key,
            epochId: 1,
            plaintext: Y.encodeStateAsUpdate(doc),
            aad: contextAad('update', 'graph:g1', 'doc:d1'),
        })
        await expect(
            openSymmetric({
                keyForEpoch: (id) => keyForEpoch(keyring, id),
                envelope,
                aad: contextAad('update', 'graph:g1', 'doc:d2'),
            }),
        ).rejects.toThrow(EnvelopeError)
    })
})
