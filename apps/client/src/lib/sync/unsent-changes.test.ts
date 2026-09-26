import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { openGraphCache, type GraphCache } from './local-cache'
import { vi } from 'vitest'
import {
    acceptUnlessUnsent,
    discardUnlessUnsent,
    readUnsentChanges,
    staleCopyUnsentChanges,
    unsentChangesMarkdown,
} from './unsent-changes'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde40000'
const PLAN = '018f47a0-7b5d-7cc5-b5c1-f0fbcde40001'
const SYNCED = '018f47a0-7b5d-7cc5-b5c1-f0fbcde40002'

let nextOutbox = 0
const outboxId = () => `018f47a0-7b5d-7cc5-b5c1-${(0xf0fbcde41000 + nextOutbox++).toString(16)}`

/** Write a document's cache row, and an unacknowledged operation for it when `unsent`. */
async function write(cache: GraphCache, docId: string, doc: Y.Doc, unsent: boolean, role?: 'root') {
    const state = { update: Y.encodeStateAsUpdate(doc), lastSeq: 1, lastSyncedStateVector: new Uint8Array([0]) }
    const row = cache.docCache(docId, role)
    await row.save(state)
    if (!unsent) return
    await row.enqueue(
        {
            outboxId: outboxId(),
            kind: 'append',
            generation: 1,
            epochId: 1,
            envelope: 'ciphertext',
            stateVector: Y.encodeStateVector(doc),
            createdAt: 1,
        },
        state,
    )
}

/** A graph whose root registry names two pages, one with an edit the server never received. */
async function graphWithUnsentEdit(graphId: string, options: { rootUnsent?: boolean } = {}) {
    const cache = await openGraphCache(graphId)
    const root = new Y.Doc()
    root.getMap('registry').set(PLAN, { kind: 'page', title: 'Plan' })
    root.getMap('registry').set(SYNCED, { kind: 'page', title: 'Synced' })
    root.getArray('quickNotes').push([{ id: 'n1', text: 'call the plumber', createdAt: 1 }])
    await write(cache, ROOT, root, options.rootUnsent ?? false, 'root')
    const plan = new Y.Doc()
    plan.getText('content').insert(0, '- typed after removal')
    await write(cache, PLAN, plan, true)
    const synced = new Y.Doc()
    synced.getText('content').insert(0, '- on the server')
    await write(cache, SYNCED, synced, false)
    return cache
}

describe('unsent changes', () => {
    it('reads each document with changes the server never acknowledged, named from the registry', async () => {
        const cache = await graphWithUnsentEdit('unsent-read')
        expect(await readUnsentChanges(cache, ROOT)).toEqual([
            { docId: PLAN, name: 'Plan', text: '- typed after removal' },
        ])
        cache.dispose()
    })

    it('counts unsent quick notes and settings as one more item, with the quick notes as its text', async () => {
        const cache = await graphWithUnsentEdit('unsent-root', { rootUnsent: true })
        expect(await readUnsentChanges(cache, ROOT)).toEqual([
            { docId: PLAN, name: 'Plan', text: '- typed after removal' },
            { docId: ROOT, name: 'Quick notes and graph settings', text: '- call the plumber' },
        ])
        cache.dispose()
    })

    it('prefers a live document over its cache row, so the last keystrokes are in the download', async () => {
        const cache = await graphWithUnsentEdit('unsent-live')
        // The engine began from the cached row and has typed further than the last save.
        const live = new Y.Doc()
        const row = await cache.docCache(PLAN).load()
        Y.applyUpdate(live, row!.update)
        live.getText('content').insert(live.getText('content').length, ', and more')
        expect(await readUnsentChanges(cache, ROOT, (docId) => (docId === PLAN ? live : undefined))).toEqual([
            { docId: PLAN, name: 'Plan', text: '- typed after removal, and more' },
        ])
        cache.dispose()
    })

    it('finds nothing in a graph whose changes all reached the server', async () => {
        const cache = await openGraphCache('unsent-clean')
        const synced = new Y.Doc()
        synced.getText('content').insert(0, 'done')
        await write(cache, SYNCED, synced, false)
        expect(await readUnsentChanges(cache, ROOT)).toEqual([])
        cache.dispose()
    })

    it('inspects the copy an earlier membership left without deleting anything', async () => {
        const graphId = 'unsent-stale-copy'
        ;(await graphWithUnsentEdit(graphId)).dispose()

        const found = await staleCopyUnsentChanges(graphId, ROOT)
        expect(found.map((change) => change.name)).toEqual(['Plan'])

        // A person who cancels the accept keeps every row.
        const reopened = await openGraphCache(graphId)
        expect(await reopened.pendingDocIds()).toEqual([PLAN])
        reopened.dispose()
        expect(await staleCopyUnsentChanges('never-opened-here', ROOT)).toEqual([])
    })

    it('writes one Markdown file with a heading per document', () => {
        expect(unsentChangesMarkdown([
            { docId: PLAN, name: 'Plan', text: '- one' },
            { docId: ROOT, name: 'Quick notes and graph settings', text: '- two' },
        ])).toBe('# Plan\n\n- one\n\n# Quick notes and graph settings\n\n- two\n')
    })

    /**
     * Accepting an invite discards this browser's copy of the graph, and that copy can hold edits
     * made while still a member that the server never acknowledged.
     */
    describe('accepting an invite to a graph this browser already holds', () => {
        const invite = { graphId: 'accept-check', rootDocId: ROOT }

        it('accepts at once, discarding the copy, when nothing in it is unsent', async () => {
            const accept = vi.fn(async () => {})
            const outcome = await acceptUnlessUnsent(invite, { inspect: async () => [], accept })
            expect(outcome).toEqual({ kind: 'accepted' })
            expect(accept).toHaveBeenCalledOnce()
        })

        it('does not accept, and hands back what would be lost, when changes are unsent', async () => {
            const graphId = 'accept-check-unsent'
            ;(await graphWithUnsentEdit(graphId)).dispose()
            const accept = vi.fn(async () => {})

            const outcome = await acceptUnlessUnsent({ graphId, rootDocId: ROOT }, { inspect: staleCopyUnsentChanges, accept })

            expect(outcome).toMatchObject({ kind: 'confirm', unsent: [{ name: 'Plan', text: '- typed after removal' }] })
            expect(accept).not.toHaveBeenCalled()
            // Until the person confirms, every unsent row is still there.
            const reopened = await openGraphCache(graphId)
            expect(await reopened.pendingDocIds()).toEqual([PLAN])
            reopened.dispose()
        })
    })

    describe('forgetting or leaving a graph this browser holds unsent changes for', () => {
        // Forget and Leave both delete the outbox, which holds edits that never reached the server.
        it('discards at once when nothing is unsent', async () => {
            const discard = vi.fn(async () => {})
            expect(await discardUnlessUnsent({ graphId: 'g', rootDocId: ROOT }, { inspect: async () => [], discard })).toEqual({ kind: 'done' })
            expect(discard).toHaveBeenCalledOnce()
        })

        it('discards nothing and hands back the unsent documents until the person has seen them', async () => {
            const graphId = 'forget-check-unsent'
            ;(await graphWithUnsentEdit(graphId)).dispose()
            const discard = vi.fn(async () => {})

            const outcome = await discardUnlessUnsent({ graphId, rootDocId: ROOT }, { inspect: staleCopyUnsentChanges, discard })

            expect(outcome).toMatchObject({ kind: 'confirm', unsent: [{ docId: PLAN, name: 'Plan' }] })
            expect(discard).not.toHaveBeenCalled()

            // Confirmed for exactly what was shown: now it goes ahead.
            const agreed = await discardUnlessUnsent({ graphId, rootDocId: ROOT }, { inspect: staleCopyUnsentChanges, discard, agreed: [PLAN] })
            expect(agreed).toEqual({ kind: 'done' })
            expect(discard).toHaveBeenCalledOnce()
        })

        it('discards nothing when the copy cannot be read: what could not be checked is not deleted', async () => {
            const discard = vi.fn(async () => {})
            const unreadable = new DOMException('The database connection is closing.', 'InvalidStateError')
            await expect(
                discardUnlessUnsent({ graphId: 'g', rootDocId: ROOT }, { inspect: async () => { throw unreadable }, discard, agreed: [PLAN] }),
            ).rejects.toBe(unreadable)
            expect(discard).not.toHaveBeenCalled()
        })

        it('asks again when more became unsent after the person agreed (another tab kept typing)', async () => {
            const discard = vi.fn(async () => {})
            const unsent = [
                { docId: PLAN, name: 'Plan', text: 'a' },
                { docId: SYNCED, name: 'Synced', text: 'b' },
            ]
            const outcome = await discardUnlessUnsent(
                { graphId: 'g', rootDocId: ROOT },
                { inspect: async () => unsent, discard, agreed: [PLAN] },
            )
            expect(outcome).toEqual({ kind: 'confirm', unsent })
            expect(discard).not.toHaveBeenCalled()
        })
    })
})
