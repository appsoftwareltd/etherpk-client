/**
 * A write from outside an editor (a Kanban move, a tick in the Tasks View, an agent's `set_task`)
 * opens its document through a handle that no tab retains. The engine behind that handle stays
 * alive afterwards but is not subscribed to the relay, so without a catch-up before the next write
 * its copy stays as it was at the first one: the next write reads that old copy, and the board,
 * which reads the index, disagrees with it (a card that moves back, a move that writes nothing).
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'

import { createGraphKeyring } from '#lib/crypto/index.js'
import { findIndexedTask, writeTaskChanges } from '#lib/document/task-write.js'
import { createLoopbackRelay } from '#lib/sync/loopback-relay.js'
import { device, eventually } from './sync-device-fixture'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a write from outside an editor reads the document as every copy has it', () => {
    it.each([
        ['another device', false],
        ['another tab on the same cache', true],
    ])('after %s moved a task since this one last wrote there', async (_name, sameCache) => {
        const relay = createLoopbackRelay()
        const keyring = createGraphKeyring('outside-write')
        const a = await device(relay, keyring)
        await a.store.createPage('Garden', '- [ ] water the beans\n- [ ] weed the path')
        await a.graph.flushAll()
        const b = await device(relay, keyring, sameCache ? { cacheName: a.cacheName } : {})
        await eventually(() => expect(b.store.listIdentities().some((identity) => identity.concept === 'Garden')).toBe(true))

        // A moves a card, as the board does: its engine for Garden lives on, held by nobody.
        expect((await writeTaskChanges(a.store, { concept: 'Garden', line: 1, text: 'weed the path' }, { status: 'doing' })).ok).toBe(true)
        await a.graph.flushAll()

        // B moves the other card, once it has A's move.
        await b.store.whenReady('Garden')
        await eventually(async () => {
            await b.store.whenCurrent?.('Garden')
            expect(b.store.open('Garden').getText()).toContain('#D weed the path')
        })
        expect((await writeTaskChanges(b.store, { concept: 'Garden', line: 0, text: 'water the beans' }, { status: 'done' })).ok).toBe(true)
        await b.graph.flushAll()
        await pause(100)

        // A's next write finds the task as B left it, and moves it back from there.
        const found = await findIndexedTask(a.store, { concept: 'Garden', line: 0, text: 'water the beans' })
        expect('reason' in found ? found.reason : found.lines[found.index]).toBe('- [x] water the beans')
        const outcome = await writeTaskChanges(a.store, { concept: 'Garden', line: 0, text: 'water the beans' }, { status: 'test' })
        expect(outcome).toMatchObject({ ok: true, changed: true, after: '- [ ] #T water the beans' })
        await a.graph.flushAll()
        await eventually(async () => {
            await b.store.whenCurrent?.('Garden')
            expect(b.store.open('Garden').getText()).toBe('- [ ] #T water the beans\n- [ ] #D weed the path')
        })
    })
})
