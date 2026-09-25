import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentStore, EditorDocument, TextChange } from '../types'
import { CIPHER_FENCE_INFO } from './fence-info'
import { ProtectedEditorDocument, applyTextChange } from './protected-document'
import { createProtectedDocumentStore } from './protected-store'

const STORED = [`\`\`\`${CIPHER_FENCE_INFO}`, 'ARMOURED(sort code 00-00-00)', '```'].join('\n')

function innerStore(texts: Record<string, string>) {
    const opened: string[] = []
    /** Live subscriptions per target — what a `ytext.observe` handler would cost on a synced graph. */
    const subscribers = new Map<string, number>()
    const store: DocumentStore = {
        open(target) {
            opened.push(target)
            let text = texts[target] ?? ''
            const doc: EditorDocument = {
                id: target,
                getText: () => text,
                applyChange: (change: TextChange) => void (text = applyTextChange(text, change)),
                subscribe: () => {
                    subscribers.set(target, (subscribers.get(target) ?? 0) + 1)
                    return () => subscribers.set(target, (subscribers.get(target) ?? 1) - 1)
                },
            }
            return doc
        },
    }
    return {
        store,
        opened,
        subscribersOn: (target: string) => subscribers.get(target) ?? 0,
        textOf: (id: string) => texts[id],
    }
}

function build(locked = false) {
    const inner = innerStore({ bank: STORED, notes: '# Plain notes' })
    const store = createProtectedDocumentStore(inner.store, {
        encrypt: async (plaintext) => {
            if (locked) throw new Error('locked')
            return `ARMOURED(${plaintext})`
        },
        decryptEnvelope: async (armoured: string) => {
            if (locked) throw new Error('locked')
            const match = /^ARMOURED\((.*)\)$/s.exec(armoured)
            if (!match) throw new Error('not ours')
            return match[1]
        },
    })
    return { inner, store, lock: () => (locked = true), unlockKey: () => (locked = false) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('opening', () => {
    it('projects a protected document once the key is held', async () => {
        const { store } = build()

        const doc = store.open('bank')
        await vi.advanceTimersByTimeAsync(0)

        expect(doc.getText()).toBe('sort code 00-00-00')
    })

    it('leaves an ordinary document completely alone', async () => {
        const { store } = build()

        const doc = store.open('notes')
        await vi.advanceTimersByTimeAsync(0)

        expect(doc.getText()).toBe('# Plain notes')
    })

    // Two panels on one protected page must share a buffer; separate projections would each
    // re-encrypt over the other's work.
    it('returns the same document for repeated opens of one id', () => {
        const { store } = build()

        expect(store.open('bank')).toBe(store.open('bank'))
    })
})

// On a Server Backend a store subscription is a `ytext.observe` handler that calls `toString()` on
// EVERY remote transaction. A synced graph's collab editor deliberately does not subscribe, so a
// decorator that subscribes unconditionally makes catching up a 1,400-update document into 1,400
// full-document string materialisations on the main thread.
describe('the cost of decorating a document', () => {
    it('does not subscribe to an ordinary document nobody is listening to', () => {
        const { inner, store } = build()
        store.open('notes')
        expect(inner.subscribersOn('notes')).toBe(0)
    })

    it('subscribes once someone listens, and lets go again', () => {
        const { inner, store } = build()
        const unsubscribe = store.open('notes').subscribe(() => {})
        expect(inner.subscribersOn('notes')).toBe(1)
        unsubscribe()
        expect(inner.subscribersOn('notes')).toBe(0)
    })

    it('subscribes while projecting, so a remote change re-projects', async () => {
        const { inner, store } = build()
        store.open('bank')
        await vi.advanceTimersByTimeAsync(0)
        expect(inner.subscribersOn('bank')).toBe(1)
    })

    it('keeps its subscription while projecting even after the last listener goes', async () => {
        const { inner, store } = build()
        const unsubscribe = store.open('bank').subscribe(() => {})
        await vi.advanceTimersByTimeAsync(0)
        unsubscribe()
        expect(inner.subscribersOn('bank')).toBe(1)
    })
})

// This answers a tab renderer, which runs for every panel on every repaint. `open()` is not a free
// read on a Server Backend - it retains a sync engine and materialises the document - so asking it
// must never be a way to open one.
describe('the protection kind of an open document', () => {
    it('reports a whole Protected Document', () => {
        const { store } = build()
        store.open('bank')
        expect(store.protectionKindFor('bank')).toBe('document')
    })

    it('reports an ordinary document as unprotected', () => {
        const { store } = build()
        store.open('notes')
        expect(store.protectionKindFor('notes')).toBe('none')
    })

    it('opens nothing for a document that is not already open', () => {
        const { inner, store } = build()
        expect(store.protectionKindFor('bank')).toBeUndefined()
        expect(inner.opened).toEqual([])
    })

    it('opens nothing on repeated asks about an open document', () => {
        const { inner, store } = build()
        store.open('bank')
        store.protectionKindFor('bank')
        store.protectionKindFor('bank')
        expect(inner.opened).toEqual(['bank'])
    })

    it('announces an open, so anything drawn from it can redraw', () => {
        const inner = innerStore({ bank: STORED })
        const opened: string[] = []
        const store = createProtectedDocumentStore(inner.store, {
            encrypt: async (p) => `ARMOURED(${p})`,
            decryptEnvelope: async () => 'plain',
            onOpened: (target) => opened.push(target),
        })
        store.open('bank')
        store.open('bank')
        expect(opened).toEqual(['bank'])
    })
})

describe('locking and unlocking every open document', () => {
    it('projects them all on unlock', async () => {
        const { store, lock, unlockKey } = build(true)
        const doc = store.open('bank')
        await vi.advanceTimersByTimeAsync(0)
        expect(doc.getText()).toBe(STORED)

        unlockKey()
        await store.unlockAll()

        expect(doc.getText()).toBe('sort code 00-00-00')
        void lock
    })

    it('drops them all on relock, so no plaintext survives the key', async () => {
        const { store } = build()
        const doc = store.open('bank')
        await vi.advanceTimersByTimeAsync(0)

        await store.relockAll()

        expect(doc.getText()).toContain(CIPHER_FENCE_INFO)
    })

    it('commits pending work without dropping the projection', async () => {
        const { store } = build()
        const doc = store.open('bank')
        await vi.advanceTimersByTimeAsync(0)
        doc.applyChange({ from: 0, to: 18, insert: 'sort code 11-11-11' })

        expect(store.hasPendingWrites).toBe(true)
        await store.commitAll()

        expect(store.hasPendingWrites).toBe(false)
        expect(doc.getText()).toBe('sort code 11-11-11')
    })
})

describe('protecting an open document in one step', () => {
    it('projects the sealed body over the fence it writes, and its editor never hears the fence', () => {
        const { store } = build()
        const doc = store.open('notes')
        const seen: string[] = []
        doc.subscribe((t) => seen.push(t))

        expect(store.protect('notes', 'ARMOURED(# Plain notes)', '# Plain notes')).toBe(true)

        expect(store.protectionKindFor('notes')).toBe('document')
        expect(doc.getText()).toBe('# Plain notes')
        expect(seen).toEqual([])
    })

    it('declines a document that is not open, leaving the raw write to the caller', () => {
        const { store } = build()

        expect(store.protect('notes', 'ARMOURED(x)', 'x')).toBe(false)
        expect(store.protectionKindFor('notes')).toBeUndefined()
    })
})

describe('disposal', () => {
    it('drops every projection', async () => {
        const { store } = build()
        const doc = store.open('bank')
        await vi.advanceTimersByTimeAsync(0)

        store.dispose()

        expect(doc.getText()).toContain(CIPHER_FENCE_INFO)
    })
})

describe('collaboration capabilities', () => {
    function withCollab() {
        const inner = innerStore({ bank: STORED, notes: '# Plain notes' })
        return createProtectedDocumentStore(
            Object.assign(inner.store, {
                getYText: (target: string) => `ytext:${target}`,
                getAwareness: (target: string) => `awareness:${target}`,
                retainDocument: (target: string) => () => void target,
            }),
            { encrypt: async (p: string) => `ARMOURED(${p})`, decryptEnvelope: async (a: string) => a },
        )
    }

    // Without this the View reads "no Y.Text" as "not a synced graph" and silently drops
    // multiplayer for every document, protected or not.
    it('forwards the Y.Text for an ordinary document', () => {
        expect(withCollab().getYText?.('notes')).toBe('ytext:notes')
    })

    // ADR 0002 made structural: with no Y.Text the editor takes the non-collaborative path and
    // binds to the projected plaintext rather than to the ciphertext.
    it('withholds the Y.Text for a Protected Document', () => {
        expect(withCollab().getYText?.('bank')).toBeUndefined()
    })

    it('forwards awareness for an ordinary document', () => {
        expect(withCollab().getAwareness?.('notes')).toBe('awareness:notes')
    })

    // Presence suppression: a Player can see the document exists, but not that you are inside it.
    it('withholds awareness for a Protected Document', () => {
        expect(withCollab().getAwareness?.('bank')).toBeUndefined()
    })

    it('forwards document retention for both', () => {
        expect(typeof withCollab().retainDocument?.('bank')).toBe('function')
    })

    it('exposes nothing when the inner store has no collaboration surface', () => {
        expect(build().store.getYText).toBeUndefined()
        expect(build().store.getAwareness).toBeUndefined()
    })
})

describe('delegation to the inner store', () => {
    // The regression that broke the workspace: the first version hand-listed the methods it
    // forwarded, so `listDocuments` vanished, the sidebar threw and the editor hung on
    // "Loading document". A DocumentStore is used through far more than its declared interface.
    it('forwards a method the DocumentStore interface does not declare', () => {
        const inner = innerStore({ notes: '# Plain notes' })
        const withExtras = Object.assign(inner.store, {
            listDocuments: () => ['notes'],
            scan: async () => 'scanned',
        })

        const store = createProtectedDocumentStore(withExtras, {
            encrypt: async (p) => p,
            decryptEnvelope: async (a: string) => a,
        }) as unknown as { listDocuments: () => string[]; scan: () => Promise<string> }

        expect(store.listDocuments()).toEqual(['notes'])
    })

    it('forwards whenReady, which drives the editor’s loading state', async () => {
        const inner = innerStore({ notes: '# Plain notes' })
        const withReady = Object.assign(inner.store, { whenReady: async () => undefined })

        const store = createProtectedDocumentStore(withReady, {
            encrypt: async (p) => p,
            decryptEnvelope: async (a: string) => a,
        })

        await expect(store.whenReady?.('notes')).resolves.toBeUndefined()
    })

    it('reports absent capabilities as absent rather than inventing them', () => {
        const store = createProtectedDocumentStore(innerStore({}).store, {
            encrypt: async (p) => p,
            decryptEnvelope: async (a: string) => a,
        })

        expect(store.whenReady).toBeUndefined()
    })
})

/**
 * An inner store shaped like the Server Backend's: documents are FRESH handles on every `open()`
 * bound to whatever engine exists, `retainDocument` is what keeps an engine alive, `whenReady`
 * settles when the cache seed lands, and `getYText` hands over the collaborative buffer.
 */
function serverLikeStore(texts: Record<string, string>) {
    const retained = new Map<string, number>()
    let opens = 0
    const seeded = new Map<string, () => void>()
    const landed = new Set<string>()
    const store: DocumentStore & {
        retainDocument(target: string): () => void
        whenReady(target: string): Promise<void>
        getYText(target: string): object | undefined
    } = {
        open(target) {
            opens++
            // Read live, like a Y.Text: a seed that lands after open must be visible through the
            // handle, or the whole point of these tests is lost.
            return {
                id: target,
                getText: () => texts[target] ?? '',
                applyChange: (change: TextChange) => void (texts[target] = applyTextChange(texts[target] ?? '', change)),
                subscribe: () => () => {},
            }
        },
        retainDocument(target) {
            retained.set(target, (retained.get(target) ?? 0) + 1)
            return () => retained.set(target, (retained.get(target) ?? 1) - 1)
        },
        whenReady(target) {
            // Settles when the seed lands; already settled for a document that has.
            if (landed.has(target)) return Promise.resolve()
            return new Promise<void>((resolve) => seeded.set(target, resolve))
        },
        getYText: () => ({ collaborative: true }),
    }
    return {
        store,
        opened: () => opens,
        retainedOn: (t: string) => retained.get(t) ?? 0,
        /** The cache seed lands: the stored text becomes real and `whenReady` settles. */
        seed(target: string, text: string) {
            texts[target] = text
            landed.add(target)
            seeded.get(target)?.()
        },
        textOf: (t: string) => texts[t],
    }
}

function buildServerLike(texts: Record<string, string>, extra: Partial<Parameters<typeof createProtectedDocumentStore>[1]> = {}) {
    const inner = serverLikeStore(texts)
    const store = createProtectedDocumentStore(inner.store, {
        encrypt: async (p) => `ARMOURED(${p})`,
        decryptEnvelope: async (armoured) => {
            const match = /^ARMOURED\((.*)\)$/s.exec(armoured)
            if (!match) throw new Error('not ours')
            return match[1]
        },
        ...extra,
    })
    return { inner, store }
}

// On a Server Backend the inner store retires a document's sync engine once nothing retains it. A
// wrapper that outlived that showed a frozen copy on reopen and never synced again — which is what
// "this block did not unlock" looked like from the outside.
describe('the wrapper lives as long as the editor’s retain', () => {
    it('is shared by two viewers of one document', () => {
        const { store } = buildServerLike({ bank: STORED })
        const r1 = store.retainDocument!('bank')
        const first = store.open('bank')
        const r2 = store.retainDocument!('bank')
        expect(store.open('bank')).toBe(first)
        r1()
        expect(store.open('bank')).toBe(first)
        r2()
    })

    it('is dropped when the last viewer lets go, so a reopen gets a fresh one', async () => {
        const { inner, store } = buildServerLike({ bank: STORED })
        const release = store.retainDocument!('bank')
        const first = store.open('bank')

        release()
        await vi.advanceTimersByTimeAsync(0)

        store.retainDocument!('bank')
        expect(store.open('bank')).not.toBe(first)
        expect(inner.retainedOn('bank')).toBe(1)
    })

    it('writes its pending plaintext before letting the inner retain go', async () => {
        const { inner, store } = buildServerLike({ bank: STORED })
        const release = store.retainDocument!('bank')
        const doc = store.open('bank') as ProtectedEditorDocument
        await doc.unlock()
        doc.applyChange({ from: 0, to: doc.getText().length, insert: 'changed' })

        release()
        // Still retained underneath while the commit is in flight…
        expect(inner.retainedOn('bank')).toBe(1)
        await vi.advanceTimersByTimeAsync(0)
        await store.commitAll()

        expect(inner.textOf('bank')).toContain('ARMOURED(changed)')
        expect(inner.retainedOn('bank')).toBe(0)
    })

    it('has commitAll wait for a wrapper that is closing', async () => {
        const { inner, store } = buildServerLike({ bank: STORED })
        const release = store.retainDocument!('bank')
        const doc = store.open('bank') as ProtectedEditorDocument
        await doc.unlock()
        doc.applyChange({ from: 0, to: doc.getText().length, insert: 'closing edit' })
        release()

        await store.commitAll()

        expect(inner.textOf('bank')).toContain('ARMOURED(closing edit)')
    })

    it('opens through the inner store on every call, as the raw store did', () => {
        const { inner, store } = buildServerLike({ bank: STORED })
        store.retainDocument!('bank')
        store.open('bank')
        store.open('bank')
        expect(inner.opened()).toBe(2)
    })
})

// The View asks for the Y.Text the instant it opens a document — before the cache seed has landed
// on a fresh page. A protected document whose text was still empty then was judged unprotected,
// bound to the CRDT, and could never show the projection the unlock produced.
describe('a document that seeds after its editor asked for a Y.Text', () => {
    it('is reported once it turns out to be protected, so the editor can remount', async () => {
        const reported: string[] = []
        const { inner, store } = buildServerLike({ bank: '' }, { onCollabBoundProtected: (t) => reported.push(t) })
        store.retainDocument!('bank')
        store.open('bank')
        const ready = store.whenReady!('bank')
        // Not protected yet, as far as anyone can tell: the Y.Text goes out.
        expect(store.getYText!('bank')).toBeDefined()

        inner.seed('bank', STORED)
        await ready

        expect(reported).toEqual(['bank'])
    })

    it('is not reported when the editor was never handed a Y.Text', async () => {
        const reported: string[] = []
        const { inner, store } = buildServerLike({ bank: STORED }, { onCollabBoundProtected: (t) => reported.push(t) })
        store.retainDocument!('bank')
        store.open('bank')
        const ready = store.whenReady!('bank')
        expect(store.getYText!('bank')).toBeUndefined()

        inner.seed('bank', STORED)
        await ready

        expect(reported).toEqual([])
    })

    it('is not reported when it seeds as an ordinary document', async () => {
        const reported: string[] = []
        const { inner, store } = buildServerLike({ notes: '' }, { onCollabBoundProtected: (t) => reported.push(t) })
        store.retainDocument!('notes')
        store.open('notes')
        const ready = store.whenReady!('notes')
        store.getYText!('notes')

        inner.seed('notes', '# plain')
        await ready

        expect(reported).toEqual([])
    })

    it('is reported only once', async () => {
        const reported: string[] = []
        const { inner, store } = buildServerLike({ bank: '' }, { onCollabBoundProtected: (t) => reported.push(t) })
        store.retainDocument!('bank')
        store.open('bank')
        const ready = store.whenReady!('bank')
        store.getYText!('bank')
        inner.seed('bank', STORED)
        await ready
        // The remount asks again — and is withheld this time, so nothing further to report.
        expect(store.getYText!('bank')).toBeUndefined()
        await store.whenReady!('bank')

        expect(reported).toEqual(['bank'])
    })
})
