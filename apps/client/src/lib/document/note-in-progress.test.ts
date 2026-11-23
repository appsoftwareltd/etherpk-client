import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssetStore, SavedAsset } from '#lib/storage/fs/asset-store.js'

import { NoteInProgress, type NoteStorage } from './note-in-progress'
import { getQuickNotes, type QuickNotesPersist, resetQuickNotes, setQuickNotes } from './quick-notes'

const file = (name: string) => new File(['water the beans'], name, { type: 'text/plain' })
const asset = (name: string): SavedAsset => ({ name, stem: name, isImage: false, ref: `../assets/${name}` })

/** A graph's asset store that keeps what it is given, or refuses it. */
function storage(save: (name: string) => Promise<SavedAsset> = async (name) => asset(name)): NoteStorage {
    return {
        assets: () => ({ save: ({ name }: { name: string }) => save(name) }) as unknown as AssetStore,
        imageSize: () => undefined,
        optimize: async (given) => ({ file: given }) as never,
    }
}
const persist = (over: Partial<QuickNotesPersist> = {}): QuickNotesPersist => ({ add: async () => {}, remove: async () => {}, ...over })
const texts = () => getQuickNotes().map((note) => note.text)

/** A promise and the ways to settle it, for a write that is still in flight. */
function held<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((ok, no) => {
        resolve = ok
        reject = no
    })
    return { promise, resolve, reject }
}

let note: NoteInProgress
beforeEach(() => {
    resetQuickNotes()
    setQuickNotes([], persist())
    note = new NoteInProgress()
})

describe('what is in the box', () => {
    it('holds the text, the files, the concept and the task tick until it is cleared', () => {
        note.text = 'water the beans'
        note.files.add([file('plan.txt')])
        note.under = 'Garden'
        note.asTask = true
        expect(note.canAdd).toBe(true)
        expect(note.isEmpty).toBe(false)
        note.clear()
        expect([note.text, note.files.count, note.under, note.asTask, note.isEmpty]).toEqual(['', 0, null, false, true])
    })

    it('goes with the graph', () => {
        note.text = 'half a thou'
        note.files.add([file('plan.txt')])
        note.error = 'refused'
        note.reset()
        expect([note.text, note.files.count, note.error]).toEqual(['', 0, ''])
    })

    it('can add blank text only with a file', () => {
        note.text = '  \n '
        expect(note.canAdd).toBe(false)
        note.files.add([file('plan.txt')])
        expect(note.canAdd).toBe(true)
    })

    it('takes text offered from outside after what it holds, a blank line between', () => {
        note.offer('Shared text')
        expect(note.text).toBe('Shared text')
        note.text = 'buy milk  \n'
        note.offer('Shared text')
        expect(note.text).toBe('buy milk\n\nShared text')
    })
})

describe('adding', () => {
    it('empties the box at once and adds the note, filed and as a task', async () => {
        note.text = 'water the beans'
        note.under = 'Garden'
        note.asTask = true
        const added = note.add(storage())
        expect(note.isEmpty).toBe(true)
        await added
        expect(getQuickNotes()).toMatchObject([{ text: '[ ] water the beans', under: 'Garden' }])
        expect(note.announcement).toBe('Note added')
    })

    it('stores the files first and names them after the text', async () => {
        note.text = 'the plan'
        note.files.add([file('plan.txt')])
        await note.add(storage())
        expect(texts()[0]).toContain('the plan')
        expect(texts()[0]).toContain('plan.txt')
    })

    it('takes a second note while the first is still being stored', async () => {
        const first = held<SavedAsset>()
        note.text = 'one'
        note.files.add([file('plan.txt')])
        const slow = note.add(storage(() => first.promise))
        await vi.waitFor(() => expect(note.storing).toBe(1))
        note.text = 'two'
        await note.add(storage())
        expect(texts()).toEqual(['two'])
        first.resolve(asset('plan.txt'))
        await slow
        expect(note.storing).toBe(0)
        expect(getQuickNotes()).toHaveLength(2)
    })

    it('puts everything back when the write is refused', async () => {
        setQuickNotes([], persist({ add: async () => Promise.reject(new Error('the disk is full')) }))
        note.text = 'water the beans'
        note.under = 'Garden'
        note.asTask = true
        await note.add(storage())
        expect([note.text, note.under, note.asTask]).toEqual(['water the beans', 'Garden', true])
        expect(note.error).toBe('Could not add the note: the disk is full')
        expect(texts()).toEqual([])
    })

    it('keeps refused text beside what was typed meanwhile', async () => {
        const write = held<void>()
        setQuickNotes([], persist({ add: () => write.promise }))
        note.text = 'one'
        note.files.add([file('plan.txt')])
        const adding = note.add(storage())
        await vi.waitFor(() => expect(texts()).toHaveLength(1))
        note.text = 'two'
        note.under = 'Kitchen'
        write.reject(new Error('offline'))
        await adding
        expect(note.text).toBe('two\n\none')
        expect(note.files.files.map((held) => held.name)).toEqual(['plan.txt'])
        expect(note.under).toBe('Kitchen')
    })

    it('names a file that was stored before the one that could not be', async () => {
        note.files.add([file('plan.txt'), file('beds.txt')])
        await note.add(storage(async (name) => (name === 'beds.txt' ? Promise.reject(new Error('too large')) : asset(name))))
        expect(note.error).toContain('plan.txt was stored and is not in any note.')
        expect(note.files.count).toBe(2)
    })

    it('refuses files on a graph that cannot store them, and gives them back', async () => {
        note.files.add([file('plan.txt')])
        await note.add({ ...storage(), assets: () => null })
        expect(note.error).toBe('Could not add the note: this graph cannot store files.')
        expect(note.files.count).toBe(1)
    })

    it('a write refused after the graph closed puts nothing in the next graph’s box', async () => {
        const write = held<void>()
        setQuickNotes([], persist({ add: () => write.promise }))
        note.text = 'one'
        const adding = note.add(storage())
        note.reset()
        write.reject(new Error('closed'))
        await adding
        expect([note.text, note.error, note.announcement, note.storing]).toEqual(['', '', '', 0])
    })

    it('a file being stored when the graph closes does not add its note to the next graph', async () => {
        const saved = held<SavedAsset>()
        note.text = 'one'
        note.files.add([file('plan.txt')])
        const adding = note.add(storage(() => saved.promise))
        await vi.waitFor(() => expect(note.storing).toBe(1))
        note.reset()
        resetQuickNotes()
        setQuickNotes([], persist())
        saved.resolve(asset('plan.txt'))
        await adding
        expect(texts()).toEqual([])
        expect(note.storing).toBe(0)
    })
})

describe('where the keyboard should go', () => {
    it('is asked for before the View is there, and taken once', () => {
        note.askFocus('box')
        expect(note.focusAsked).toBe('box')
        note.focusTaken()
        expect(note.focusAsked).toBeNull()
    })

    it('goes with the graph', () => {
        note.askFocus('list')
        note.reset()
        expect(note.focusAsked).toBeNull()
    })
})

describe('listeners', () => {
    it('hear every change until they stop', () => {
        const heard = vi.fn()
        const stop = note.subscribe(heard)
        note.text = 'a'
        note.under = 'Garden'
        note.files.add([file('plan.txt')])
        expect(heard).toHaveBeenCalledTimes(2)
        stop()
        note.text = 'b'
        expect(heard).toHaveBeenCalledTimes(2)
    })
})
