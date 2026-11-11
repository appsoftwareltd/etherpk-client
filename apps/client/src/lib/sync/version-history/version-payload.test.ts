import { describe, expect, it } from 'vitest'
import { bumpEpoch, createGraphKeyring } from '#lib/crypto/index.js'
import { decodeVersionPayload, encodeVersionPayload, openVersion, sealVersion, type DocumentVersionPayload } from './version-payload'

const GRAPH = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'

const payload: DocumentVersionPayload = {
    v: 1,
    identity: { kind: 'page', title: 'Garden', aliases: ['Allotment'] },
    text: '---\ntags: [outdoors]\n---\n- water the beans\n  - [[Kitchen]] herbs\n',
}

describe('document version payload', () => {
    it('round-trips the text exactly and the identity', () => {
        expect(decodeVersionPayload(encodeVersionPayload(payload))).toEqual(payload)
        const journal: DocumentVersionPayload = { v: 1, identity: { kind: 'journal', date: '2026-11-11', aliases: [] }, text: '' }
        expect(decodeVersionPayload(encodeVersionPayload(journal))).toEqual(journal)
    })

    it('refuses a payload it cannot read rather than guessing', () => {
        const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
        expect(() => decodeVersionPayload(encode({ ...payload, v: 2 }))).toThrow()
        expect(() => decodeVersionPayload(encode({ ...payload, text: 4 }))).toThrow()
        expect(() => decodeVersionPayload(encode({ v: 1, identity: { kind: 'board', aliases: [] }, text: '' }))).toThrow()
        expect(() => decodeVersionPayload(new TextEncoder().encode('not json'))).toThrow()
    })

    it('seals under the current epoch and opens only as the version it was sealed for', async () => {
        const keyring = bumpEpoch(createGraphKeyring(GRAPH))
        const sealed = await sealVersion({ keyring, graphId: GRAPH, docId: DOC, versionId: VERSION, payload })
        expect(sealed.epochId).toBe(2)
        expect(await openVersion({ keyring, graphId: GRAPH, docId: DOC, versionId: VERSION, envelope: sealed.envelope })).toEqual(payload)
        // Bound to its document and its id: a server cannot hand one document's version to another.
        const OTHER = '44444444-4444-4444-8444-444444444444'
        await expect(openVersion({ keyring, graphId: GRAPH, docId: OTHER, versionId: VERSION, envelope: sealed.envelope })).rejects.toThrow()
        await expect(openVersion({ keyring, graphId: GRAPH, docId: DOC, versionId: OTHER, envelope: sealed.envelope })).rejects.toThrow()
    })
})
