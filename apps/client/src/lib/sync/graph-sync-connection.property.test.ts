import 'fake-indexeddb/auto'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { createGraphKeyring } from '#lib/crypto/index.js'
import { createGraphSync, type SyncActivity, type TransportSocket } from './graph-sync'
import { openGraphCache } from './local-cache'
import { fixedSyncToken } from './sync-token'

/**
 * What a session says about its connection, over any run of sockets the relay closes.
 *
 * Fixed seed and run count, so a failure reproduces. `SYNC_FUZZ_RUNS` and `SYNC_FUZZ_SEED`
 * change them for a longer local run, or to replay a seed a failure printed.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.SYNC_FUZZ_SEED
    return { numRuns: Number(process.env.SYNC_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde20000'
/** The relay's "no connection left for this account on this graph". */
const TURNED_AWAY = 4429

/** One socket's life: whether it opened, and the code it closed with. Access-ending codes are left out. */
const socketLife = fc.record({
    opens: fc.boolean(),
    code: fc.constantFrom(1000, 1006, 1011, 1012, TURNED_AWAY, 4499),
})

let run = 0

describe('graph-sync connection state', () => {
    it('follows the last close: turned away after 4429 and on its own schedule, reconnecting after any other, and always asks again', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(socketLife, { minLength: 1, maxLength: 12 }), async (lives) => {
                const sockets: Array<{ open(): void; close(code: number): void }> = []
                const connect = (): TransportSocket => {
                    let onOpen = () => {}
                    let onClose: (event?: { code: number; reason: string }) => void = () => {}
                    sockets.push({ open: () => onOpen(), close: (code) => onClose({ code, reason: '' }) })
                    return {
                        send: () => {},
                        close: () => {},
                        onOpen: (cb) => { onOpen = cb },
                        onMessage: () => {},
                        onClose: (cb) => { onClose = cb },
                    }
                }
                const ordinary: number[] = []
                const turnedAway: number[] = []
                const graphId = `g-connection-property-${++run}`
                const cache = await openGraphCache(graphId)
                const gs = createGraphSync({
                    graphId,
                    rootDocId: ROOT,
                    keyring: createGraphKeyring(graphId),
                    relayUrl: 'ws://relay/sync',
                    token: fixedSyncToken('t'),
                    cache,
                    connect,
                    retryDelayMs: (attempt) => (ordinary.push(attempt), 0),
                    turnedAwayRetryDelayMs: (round) => (turnedAway.push(round), 0),
                })
                try {
                    let refusedInARow = 0
                    for (const [index, life] of lives.entries()) {
                        // Every close is followed by another attempt: the session never gives up.
                        await vi.waitFor(() => expect(sockets).toHaveLength(index + 1))
                        if (life.opens) {
                            sockets[index].open()
                            expect(gs.activity().connection).toBe('open')
                        }
                        const before = { ordinary: ordinary.length, turnedAway: turnedAway.length }
                        sockets[index].close(life.code)
                        const expected: SyncActivity['connection'] = life.code === TURNED_AWAY ? 'turned-away' : 'reconnecting'
                        expect(gs.activity().connection).toBe(expected)
                        expect(gs.accessLoss()).toBeNull()
                        if (life.code === TURNED_AWAY) {
                            refusedInARow += 1
                            // Its own schedule, counted from the first refusal of this run of them.
                            expect(turnedAway.slice(before.turnedAway)).toEqual([refusedInARow])
                            expect(ordinary).toHaveLength(before.ordinary)
                        } else {
                            refusedInARow = 0
                            expect(ordinary).toHaveLength(before.ordinary + 1)
                            expect(turnedAway).toHaveLength(before.turnedAway)
                        }
                    }
                    await vi.waitFor(() => expect(sockets).toHaveLength(lives.length + 1))
                } finally {
                    gs.dispose()
                    cache.dispose()
                }
            }),
            fuzz(60),
        )
    }, 60_000)
})
