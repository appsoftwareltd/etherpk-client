import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { bumpEpoch, createGraphKeyring } from './keyring'
import { deriveJournalIdSecret, journalDocId } from './journal-doc-id'

async function idFor(keyring: ReturnType<typeof createGraphKeyring>, day: string): Promise<string> {
    return journalDocId(await deriveJournalIdSecret(keyring), day)
}

describe('journalDocId', () => {
    it('gives one day the same id every time, on every device holding the graph key', async () => {
        const keyring = createGraphKeyring('graph-a')
        const copy = { graphId: keyring.graphId, epochs: keyring.epochs.map((e) => ({ ...e, key: new Uint8Array(e.key) })) }
        expect(await idFor(keyring, '2026-03-14')).toBe(await idFor(copy, '2026-03-14'))
    })

    it('is a version 8 UUID the sync protocol accepts', async () => {
        const id = await idFor(createGraphKeyring('graph-a'), '2026-03-14')
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(z.uuid().safeParse(id).success).toBe(true)
    })

    it('differs between days, graphs and keys', async () => {
        const keyring = createGraphKeyring('graph-a')
        const day = await idFor(keyring, '2026-03-14')
        expect(await idFor(keyring, '2026-10-23')).not.toBe(day)
        expect(await idFor({ ...keyring, graphId: 'graph-b' }, '2026-03-14')).not.toBe(day)
        expect(await idFor(createGraphKeyring('graph-a'), '2026-03-14')).not.toBe(day)
    })

    it('keeps the id when the graph moves to a new key epoch', async () => {
        const keyring = createGraphKeyring('graph-a')
        expect(await idFor(bumpEpoch(bumpEpoch(keyring)), '2026-03-14')).toBe(await idFor(keyring, '2026-03-14'))
    })

    it('refuses anything that is not a calendar day', async () => {
        const secret = await deriveJournalIdSecret(createGraphKeyring('graph-a'))
        await expect(journalDocId(secret, 'Garden')).rejects.toThrow()
        await expect(journalDocId(secret, ' 2026-03-14')).rejects.toThrow()
    })
})
