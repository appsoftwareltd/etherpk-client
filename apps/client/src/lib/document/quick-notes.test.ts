import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    addQuickNote,
    adoptQuickNotes,
    getQuickNoteDraft,
    getQuickNotes,
    offerQuickNoteDraft,
    type QuickNote,
    removeQuickNotes,
    requestQuickNoteFocus,
    resetQuickNotes,
    sanitizeQuickNotes,
    takeQuickNoteFocusRequest,
    setQuickNoteDraft,
    setQuickNotes,
    subscribeQuickNoteDraft,
    subscribeQuickNotes,
    unionQuickNotes,
} from './quick-notes'

const note = (id: string, createdAt: number, text = id): QuickNote => ({ id, text, createdAt })

function persistSpy() {
    return { add: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) }
}

beforeEach(() => resetQuickNotes())

describe('quick notes', () => {
    it('reads newest first by creation time, whatever order the backend hands them over in', () => {
        // A CRDT merge of concurrent inserts orders the array arbitrarily (ADR 0078), so the
        // order shown is derived from the timestamp, never from list position.
        setQuickNotes([note('a', 100), note('c', 300), note('b', 200)], persistSpy())
        expect(getQuickNotes().map((n) => n.id)).toEqual(['c', 'b', 'a'])
    })

    it('adds a trimmed note with a fresh id and the moment it was written, and persists that one note', async () => {
        const persist = persistSpy()
        setQuickNotes([], persist)
        vi.useFakeTimers({ now: 1_700_000_000_000 })
        try {
            const added = await addQuickNote('  Ring the dentist \n')
            expect(added).not.toBeNull()
            expect(added?.text).toBe('Ring the dentist')
            expect(added?.createdAt).toBe(1_700_000_000_000)
            expect(added?.id).toMatch(/\S/)
            expect(getQuickNotes()).toEqual([added])
            expect(persist.add).toHaveBeenCalledWith(added)
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps an explicit moment of writing: a share that waited behind an unlock lands under its own day', async () => {
        const persist = persistSpy()
        setQuickNotes([], persist)
        const added = await addQuickNote('Shared earlier', { createdAt: 1_600_000_000_000 })
        expect(added?.createdAt).toBe(1_600_000_000_000)
        expect(persist.add).toHaveBeenCalledWith(added)
    })

    it('refuses a blank note without touching the backend', async () => {
        const persist = persistSpy()
        setQuickNotes([], persist)
        expect(await addQuickNote('   \n\t')).toBeNull()
        expect(getQuickNotes()).toEqual([])
        expect(persist.add).not.toHaveBeenCalled()
    })

    it('keeps inner line breaks (a multi-line note is one note)', async () => {
        setQuickNotes([], persistSpy())
        const added = await addQuickNote('first line\nsecond line')
        expect(added?.text).toBe('first line\nsecond line')
    })

    it('removes by id, only the ids asked for, and persists exactly those', async () => {
        const persist = persistSpy()
        setQuickNotes([note('a', 1), note('b', 2), note('c', 3)], persist)
        await removeQuickNotes(['a', 'c', 'never-existed'])
        expect(getQuickNotes().map((n) => n.id)).toEqual(['b'])
        expect(persist.remove).toHaveBeenCalledWith(['a', 'c'])
    })

    it('removing nothing that exists writes nothing', async () => {
        const persist = persistSpy()
        setQuickNotes([note('a', 1)], persist)
        await removeQuickNotes(['zzz'])
        expect(persist.remove).not.toHaveBeenCalled()
    })

    it('rolls back and rethrows when the backend refuses an add', async () => {
        const persist = persistSpy()
        persist.add.mockRejectedValue(new Error('offline'))
        setQuickNotes([note('a', 1)], persist)
        await expect(addQuickNote('new')).rejects.toThrow('offline')
        expect(getQuickNotes().map((n) => n.id)).toEqual(['a'])
    })

    it('rolls back and rethrows when the backend refuses a remove', async () => {
        const persist = persistSpy()
        persist.remove.mockRejectedValue(new Error('read-only'))
        setQuickNotes([note('a', 1)], persist)
        await expect(removeQuickNotes(['a'])).rejects.toThrow('read-only')
        expect(getQuickNotes().map((n) => n.id)).toEqual(['a'])
    })

    it('notifies subscribers on every change, immediately on subscribe, sorted', async () => {
        const seen: string[][] = []
        setQuickNotes([note('a', 1)], persistSpy())
        const unsubscribe = subscribeQuickNotes((notes) => seen.push(notes.map((n) => n.id)))
        await addQuickNote('b')
        adoptQuickNotes([note('a', 1), note('z', 9)])
        unsubscribe()
        adoptQuickNotes([])
        expect(seen[0]).toEqual(['a'])
        expect(seen[1]?.[1]).toBe('a')
        expect(seen[2]).toEqual(['z', 'a'])
        expect(seen).toHaveLength(3)
    })

    it('adopting an identical list is silent', () => {
        const listener = vi.fn()
        setQuickNotes([note('a', 1)], persistSpy())
        subscribeQuickNotes(listener)
        adoptQuickNotes([note('a', 1)])
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('holds the unsent draft text until the graph closes', () => {
        setQuickNotes([], persistSpy())
        setQuickNoteDraft('half a thou')
        expect(getQuickNoteDraft()).toBe('half a thou')
        resetQuickNotes()
        expect(getQuickNoteDraft()).toBe('')
        expect(getQuickNotes()).toEqual([])
    })
})

describe('a draft offered from outside the View', () => {
    it('becomes the draft and reaches a mounted View, which the box seeds from otherwise', () => {
        // The workspace puts a refused share into the box (ADR 0087). A View already mounted
        // hears about it; one that mounts later reads the draft as it always has.
        const listener = vi.fn()
        const off = subscribeQuickNoteDraft(listener)
        offerQuickNoteDraft('Shared text')
        expect(listener).toHaveBeenCalledWith('Shared text')
        expect(getQuickNoteDraft()).toBe('Shared text')
        off()
        offerQuickNoteDraft('Another')
        expect(listener).toHaveBeenCalledTimes(1)
    })

    it('goes after text already in the box, a blank line between, so neither is lost', () => {
        // One rule, here, not in the View: a box holding "buy milk" keeps it AND gets the share.
        const listener = vi.fn()
        const off = subscribeQuickNoteDraft(listener)
        setQuickNoteDraft('buy milk')
        offerQuickNoteDraft('Shared text')
        expect(getQuickNoteDraft()).toBe('buy milk\n\nShared text')
        expect(listener).toHaveBeenCalledWith('buy milk\n\nShared text')
        off()
    })

    it('typing into the box does not echo back to the listeners', () => {
        const listener = vi.fn()
        const off = subscribeQuickNoteDraft(listener)
        setQuickNoteDraft('typed')
        expect(listener).not.toHaveBeenCalled()
        off()
    })
})

describe('focus request', () => {
    it('is taken once by the next mount, and cleared on graph close', () => {
        expect(takeQuickNoteFocusRequest()).toBe(false)
        requestQuickNoteFocus()
        expect(takeQuickNoteFocusRequest()).toBe(true)
        expect(takeQuickNoteFocusRequest()).toBe(false)
        requestQuickNoteFocus()
        resetQuickNotes()
        expect(takeQuickNoteFocusRequest()).toBe(false)
    })
})

describe('unionQuickNotes', () => {
    it('adds only the incoming notes whose id the existing list lacks, keeping the existing spelling', () => {
        expect(unionQuickNotes([note('a', 1, 'mine')], [note('a', 9, 'theirs'), note('b', 2)])).toEqual([note('a', 1, 'mine'), note('b', 2)])
    })
})

describe('sanitizeQuickNotes', () => {
    it('keeps well-formed notes, trims text, drops the malformed and dedupes by id', () => {
        expect(
            sanitizeQuickNotes([
                { id: 'a', text: ' keep ', createdAt: 1 },
                { id: 'a', text: 'duplicate id', createdAt: 2 },
                { id: 'b', text: '   ', createdAt: 3 },
                { id: 'c', text: 'no time' },
                { id: '', text: 'no id', createdAt: 4 },
                { id: 'd', text: 'bad time', createdAt: Number.NaN },
                'not an object',
                null,
                { id: 'e', text: 'fine', createdAt: 5, extra: 'ignored' },
            ]),
        ).toEqual([
            { id: 'a', text: 'keep', createdAt: 1 },
            { id: 'e', text: 'fine', createdAt: 5 },
        ])
    })

    it('reads anything that is not an array as no notes', () => {
        expect(sanitizeQuickNotes(undefined)).toEqual([])
        expect(sanitizeQuickNotes({ id: 'a' })).toEqual([])
        expect(sanitizeQuickNotes('[]')).toEqual([])
    })
})
