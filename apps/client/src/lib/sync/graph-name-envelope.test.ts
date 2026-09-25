import { describe, expect, it, vi } from 'vitest'

import { bumpEpoch, createGraphKeyring, currentEpoch, envelopeEpochId, fromBase64Url } from '$lib/crypto'

import { GRAPH_NAME_MAX_BYTES, createGraphNamePublisher, openGraphName, sealGraphName } from './graph-name-envelope'

const GRAPH = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
const OTHER_GRAPH = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10001'

describe('graph name envelope', () => {
    it('seals a name under the current epoch and opens it again', async () => {
        const keyring = bumpEpoch(createGraphKeyring(GRAPH))

        const envelope = await sealGraphName(keyring, GRAPH, 'Physics Notes')

        expect(envelopeEpochId(envelope)).toBe(currentEpoch(keyring).epochId)
        await expect(openGraphName(keyring, GRAPH, envelope)).resolves.toBe('Physics Notes')
        expect(new TextDecoder().decode(envelope)).not.toContain('Physics')
    })

    it('opens a name sealed under an earlier epoch with the retained key', async () => {
        const before = createGraphKeyring(GRAPH)
        const envelope = await sealGraphName(before, GRAPH, 'Physics Notes')

        await expect(openGraphName(bumpEpoch(before), GRAPH, envelope)).resolves.toBe('Physics Notes')
    })

    it('refuses to read the name under another graph id', async () => {
        // The AAD binds the envelope to its graph, so a server that swapped two rows' columns
        // could not relabel one graph with another's name.
        const keyring = createGraphKeyring(GRAPH)
        const envelope = await sealGraphName(keyring, GRAPH, 'Physics Notes')

        await expect(openGraphName({ ...keyring, graphId: OTHER_GRAPH }, OTHER_GRAPH, envelope)).resolves.toBeNull()
    })

    it('reads nothing from a key of the wrong epoch, garbage, or an empty envelope', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const envelope = await sealGraphName(keyring, GRAPH, 'Physics Notes')
        const stranger = createGraphKeyring(GRAPH)

        await expect(openGraphName(stranger, GRAPH, envelope)).resolves.toBeNull()
        await expect(openGraphName(keyring, GRAPH, new Uint8Array([1, 2, 3]))).resolves.toBeNull()
        await expect(openGraphName(keyring, GRAPH, new Uint8Array())).resolves.toBeNull()
    })

    it('pads names into fixed buckets so the ciphertext length says little about the name', async () => {
        const keyring = createGraphKeyring(GRAPH)

        const short = await sealGraphName(keyring, GRAPH, 'A')
        const medium = await sealGraphName(keyring, GRAPH, 'A'.repeat(40))
        const longer = await sealGraphName(keyring, GRAPH, 'A'.repeat(100))

        expect(short.byteLength).toBe(medium.byteLength)
        expect(longer.byteLength).toBeGreaterThan(medium.byteLength)
    })

    it('rejects an empty or oversized name rather than publishing a useless label', async () => {
        const keyring = createGraphKeyring(GRAPH)

        await expect(sealGraphName(keyring, GRAPH, '   ')).rejects.toThrow(/empty/)
        await expect(sealGraphName(keyring, GRAPH, 'x'.repeat(GRAPH_NAME_MAX_BYTES + 1))).rejects.toThrow(/long/)
    })

    it('keeps multi-byte names intact through the padding', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const name = 'Notes de physique - été 2026 🧪'

        await expect(openGraphName(keyring, GRAPH, await sealGraphName(keyring, GRAPH, name))).resolves.toBe(name)
    })
})

describe('graph name publisher', () => {
    it('seals each name and sends it in order, one request at a time', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const sent: string[] = []
        let inFlight = 0
        let overlap = false
        const api = {
            setGraphName: vi.fn(async (_graphId: string, envelope: string) => {
                inFlight += 1
                if (inFlight > 1) overlap = true
                await new Promise((resolve) => setTimeout(resolve, 5))
                sent.push(envelope)
                inFlight -= 1
            }),
        }

        const publisher = createGraphNamePublisher({ api, keyring, graphId: GRAPH })
        publisher.publish('First')
        publisher.publish('Second')
        await publisher.settled()

        expect(overlap).toBe(false)
        expect(api.setGraphName).toHaveBeenCalledTimes(2)
        expect(api.setGraphName.mock.calls.map(([graphId]) => graphId)).toEqual([GRAPH, GRAPH])
        const names = await Promise.all(sent.map((envelope) => openGraphName(keyring, GRAPH, fromBase64Url(envelope))))
        expect(names).toEqual(['First', 'Second'])
    })

    it('reports a failed publish and carries on with the next one', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const api = {
            setGraphName: vi
                .fn<(graphId: string, envelope: string) => Promise<void>>()
                .mockRejectedValueOnce(new Error('offline'))
                .mockResolvedValue(undefined),
        }
        const onError = vi.fn()

        const publisher = createGraphNamePublisher({ api, keyring, graphId: GRAPH, onError })
        publisher.publish('First')
        publisher.publish('Second')
        await publisher.settled()

        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
        expect(api.setGraphName).toHaveBeenCalledTimes(2)
    })

    it('reports a name it cannot seal without sending anything', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const api = { setGraphName: vi.fn<(graphId: string, envelope: string) => Promise<void>>().mockResolvedValue(undefined) }
        const onError = vi.fn()

        const publisher = createGraphNamePublisher({ api, keyring, graphId: GRAPH, onError })
        publisher.publish('x'.repeat(GRAPH_NAME_MAX_BYTES + 1))
        await publisher.settled()

        expect(api.setGraphName).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledTimes(1)
    })
})

