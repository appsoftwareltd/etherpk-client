import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring, toBase64Url, type GraphKeyring } from '$lib/crypto'
import { sealGraphName } from '$lib/sync/graph-name-envelope'
import type { ServerGraphRecord } from '$lib/sync/sync-api'

import { NO_KEY_LABEL, NO_NAME_LABEL, describeGraphLabel, findGraphByName, graphLabel, resolveGraphLabel } from './graph-labels'

const PHYSICS = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const HISTORY = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10001'
const STRANGER = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10002'

function record(id: string, nameEnvelope: string | null | undefined): ServerGraphRecord {
    return { id, rootDocId: `${id}-root`, role: 'owner', ...(nameEnvelope === undefined ? {} : { nameEnvelope }) }
}

describe('graph labels from the name envelope', () => {
    it('names a graph from its envelope with the keyring the vault holds, without opening it', async () => {
        const keyring = createGraphKeyring(PHYSICS)
        const sealed = toBase64Url(await sealGraphName(keyring, PHYSICS, 'Physics Notes'))

        const label = await graphLabel(record(PHYSICS, sealed), { keyrings: [keyring] })

        expect(label).toEqual({ kind: 'named', name: 'Physics Notes' })
        expect(describeGraphLabel(label)).toBe('Physics Notes')
    })

    it('says when the account holds no key for the graph, before anything else', async () => {
        const keyring = createGraphKeyring(PHYSICS)
        const sealed = toBase64Url(await sealGraphName(keyring, PHYSICS, 'Physics Notes'))

        const label = await graphLabel(record(PHYSICS, sealed), { keyrings: [] })

        expect(label).toEqual({ kind: 'no-key' })
        expect(describeGraphLabel(label)).toBe(NO_KEY_LABEL)
    })

    it('says when no name has been published, or the published one does not open here', async () => {
        const keyring = createGraphKeyring(PHYSICS)
        const stranger = toBase64Url(await sealGraphName(createGraphKeyring(PHYSICS), PHYSICS, 'Physics Notes'))

        await expect(graphLabel(record(PHYSICS, null), { keyrings: [keyring] })).resolves.toEqual({ kind: 'unnamed' })
        await expect(graphLabel(record(PHYSICS, undefined), { keyrings: [keyring] })).resolves.toEqual({ kind: 'unnamed' })
        await expect(graphLabel(record(PHYSICS, stranger), { keyrings: [keyring] })).resolves.toEqual({ kind: 'unnamed' })
        expect(describeGraphLabel({ kind: 'unnamed' })).toBe(NO_NAME_LABEL)
        expect(NO_NAME_LABEL).toBe('(unnamed)')
    })

    it('finds a graph by its published name, case-insensitively, skipping graphs it cannot read', async () => {
        const physics = createGraphKeyring(PHYSICS)
        const history = createGraphKeyring(HISTORY)
        const records = [
            record(PHYSICS, toBase64Url(await sealGraphName(physics, PHYSICS, 'Physics Notes'))),
            record(HISTORY, toBase64Url(await sealGraphName(history, HISTORY, 'History'))),
            record(STRANGER, toBase64Url(await sealGraphName(createGraphKeyring(STRANGER), STRANGER, 'Secret'))),
        ]
        const vault = { keyrings: [physics, history] }
        const readMeta = vi.fn<(record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>>().mockResolvedValue(null)

        await expect(findGraphByName(records, vault, 'physics notes', readMeta)).resolves.toEqual({ record: records[0], name: 'Physics Notes' })
        await expect(findGraphByName(records, vault, 'History', readMeta)).resolves.toEqual({ record: records[1], name: 'History' })
        await expect(findGraphByName(records, vault, 'Secret', readMeta)).resolves.toBeNull()
        await expect(findGraphByName(records, vault, 'Chemistry', readMeta)).resolves.toBeNull()
        // Every graph here carries an envelope the account can read, so nothing was opened.
        expect(readMeta).not.toHaveBeenCalled()
    })

    describe('resolveGraphLabel: the envelope first, then one read of the root document', () => {
        it('takes the envelope without opening the graph', async () => {
            const keyring = createGraphKeyring(PHYSICS)
            const sealed = toBase64Url(await sealGraphName(keyring, PHYSICS, 'Physics Notes'))
            const readMeta = vi.fn<(record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>>()

            await expect(resolveGraphLabel(record(PHYSICS, sealed), { keyrings: [keyring] }, readMeta)).resolves.toEqual({ kind: 'named', name: 'Physics Notes' })
            expect(readMeta).not.toHaveBeenCalled()
        })

        it('reads the root document once for a graph with no envelope, with the keyring it holds', async () => {
            const keyring = createGraphKeyring(PHYSICS)
            const readMeta = vi.fn<(record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>>().mockResolvedValue('From the meta map')

            const unpublished = record(PHYSICS, null)
            await expect(resolveGraphLabel(unpublished, { keyrings: [keyring] }, readMeta)).resolves.toEqual({ kind: 'named', name: 'From the meta map' })
            expect(readMeta).toHaveBeenCalledWith(unpublished, keyring)
        })

        it('stays unnamed when the root document has no name either, and never opens a graph it has no key for', async () => {
            const keyring = createGraphKeyring(PHYSICS)
            const readMeta = vi.fn<(record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>>().mockResolvedValue(null)

            await expect(resolveGraphLabel(record(PHYSICS, null), { keyrings: [keyring] }, readMeta)).resolves.toEqual({ kind: 'unnamed' })
            await expect(resolveGraphLabel(record(PHYSICS, null), { keyrings: [] }, readMeta)).resolves.toEqual({ kind: 'no-key' })
            expect(readMeta).toHaveBeenCalledTimes(1)
        })

        it('finds a graph by name through the fallback read', async () => {
            const keyring = createGraphKeyring(PHYSICS)
            const readMeta = vi.fn<(record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>>().mockResolvedValue('Physics Notes')
            const unpublished = record(PHYSICS, null)

            await expect(findGraphByName([unpublished], { keyrings: [keyring] }, 'PHYSICS NOTES', readMeta)).resolves.toEqual({ record: unpublished, name: 'Physics Notes' })
        })
    })
})
