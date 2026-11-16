import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toggleBulletFoldSpec } from './outline-folds'
import { createFoldMemory, foldDocumentKey, type FoldStorage, foldFingerprint, foldMemoryKey, foldMemoryKeysIn, foldPath } from './fold-memory'
import { foldsToEffects, keptFoldsOf, resolveKeptFolds } from './fold-persistence'
import { editorFixture } from '../testing/editor-state-fixture'

function memoryStorage(): FoldStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, v),
        removeItem: (k) => void data.delete(k),
        get length() {
            return data.size
        },
        key: (i) => [...data.keys()][i] ?? null,
    }
}

const fold = (line: number, fingerprint = 'aaaaaaaa', nth = 0) => ({ line, fingerprint, nth })

describe('fold memory', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('keeps each document’s folds under a key of its own, written after a pause', () => {
        const storage = memoryStorage()
        const memory = createFoldMemory({ storage: () => storage, storageKey: foldMemoryKey('g1'), saveDelayMs: 100 })
        memory.set('garden', [fold(1)])
        expect(storage.data.size).toBe(0)
        vi.advanceTimersByTime(100)
        expect([...storage.data.keys()]).toEqual([foldDocumentKey(foldMemoryKey('g1'), 'garden')])
        const again = createFoldMemory({ storage: () => storage, storageKey: foldMemoryKey('g1') })
        expect(again.get('garden')).toEqual([fold(1)])
        expect(again.get('kitchen')).toEqual([])
    })

    it('forgets a document whose folds are all opened', () => {
        const storage = memoryStorage()
        const memory = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        memory.set('garden', [fold(1)])
        memory.flush()
        memory.set('garden', [])
        memory.flush()
        expect(storage.data.size).toBe(0)
    })

    it('writes only the documents it changed, so two tabs writing at once lose nothing', () => {
        // spec/fold-memory: with one key for the graph, a write read every document and stored them
        // all, and the later of two writes put the other tab's document back as it had read it.
        const storage = memoryStorage()
        const one = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        const two = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        // Both tabs have read both documents before either writes.
        one.get('garden')
        one.get('kitchen')
        two.get('garden')
        two.get('kitchen')
        one.set('garden', [fold(1)])
        two.set('kitchen', [fold(2, 'bbbbbbbb')])
        one.flush()
        two.flush()
        const read = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        expect(read.get('garden')).toEqual([fold(1)])
        expect(read.get('kitchen')).toEqual([fold(2, 'bbbbbbbb')])
    })

    it('drops the least recently written documents past the limit, and the first format’s key', () => {
        const storage = memoryStorage()
        storage.data.set('k', JSON.stringify({ v: 1, docs: [['garden', [[1, 'aaaaaaaa']]]] }))
        let clock = 0
        const memory = createFoldMemory({ storage: () => storage, storageKey: 'k', documentLimit: 2, now: () => ++clock })
        for (const key of ['garden', 'kitchen', 'shed']) {
            memory.set(key, [fold(1)])
            memory.flush()
        }
        expect([...storage.data.keys()].sort()).toEqual([foldDocumentKey('k', 'kitchen'), foldDocumentKey('k', 'shed')])
    })

    it('lists every key of a graph’s folds, and no other graph’s', () => {
        const storage = memoryStorage()
        for (const key of ['etherpk:folds:g1', 'etherpk:folds:g1:garden', 'etherpk:folds:g10:garden', 'etherpk:other:g1']) storage.data.set(key, '{}')
        expect(foldMemoryKeysIn(storage, 'g1')).toEqual(['etherpk:folds:g1', 'etherpk:folds:g1:garden'])
    })

    it('tells the document’s other editors of a change, not the one that made it', () => {
        const memory = createFoldMemory({ storage: () => null, storageKey: '' })
        const heard: (object | undefined)[] = []
        const me = {}
        memory.subscribe('garden', (source) => heard.push(source))
        memory.set('garden', [fold(1)], me)
        // The same folds again is no change, and no one is told.
        memory.set('garden', [fold(1)], me)
        expect(heard).toEqual([me])
    })

    it('reads nothing it cannot trust', () => {
        const storage = memoryStorage()
        const at = foldDocumentKey('k', 'garden')
        storage.data.set(at, JSON.stringify({ v: 2, t: 1, folds: [[0, 'aaaaaaaa', 0], [2, 'not-hex', 0], [3, 'cccccccc', 1], [4, 'dddddddd']] }))
        expect(createFoldMemory({ storage: () => storage, storageKey: 'k' }).get('garden')).toEqual([fold(3, 'cccccccc', 1)])
        storage.data.set(at, '{not json')
        expect(createFoldMemory({ storage: () => storage, storageKey: 'k' }).get('garden')).toEqual([])
    })
})

describe('finding kept folds again', () => {
    const text = '- Garden|\n  - Beans\n- Kitchen\n  - Pantry'
    const print = (...words: string[]) => foldFingerprint(foldPath(words))

    it('keeps each folded bullet by its line, the fingerprint of its words and its ancestors’, and its place among its like', () => {
        const editor = editorFixture(text)
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 3)!))
        expect(keptFoldsOf(editor.state)).toEqual([{ line: 3, fingerprint: print('Kitchen'), nth: 0 }])
        const nested = editorFixture('- Garden|\n  - Comments\n    - looks good\n- Kitchen\n  - Comments\n    - wash pans')
        nested.dispatch(nested.state.update(toggleBulletFoldSpec(nested.state, 5)!))
        expect(keptFoldsOf(nested.state)).toEqual([{ line: 5, fingerprint: print('Kitchen', 'Comments'), nth: 0 }])
    })

    it('finds a fold at its line, or among the bullets with its fingerprint when lines moved', () => {
        const { state } = editorFixture('- Cellar|\n- Garden\n  - Beans\n- Kitchen\n  - Pantry')
        expect(resolveKeptFolds(state, [{ line: 4, fingerprint: print('Kitchen'), nth: 0 }])).toEqual([4])
        expect(resolveKeptFolds(state, [{ line: 3, fingerprint: print('Kitchen'), nth: 0 }])).toEqual([4])
    })

    it('finds the second of two bullets with the same words under one parent, after lines were added above', () => {
        // The browser hunt of 2026-11-16: two "Comments", the second folded, seven lines added above
        // by another device. Kept by line and words alone, the first came back folded.
        const before = editorFixture('- Garden|\n  - Comments\n    - looks good\n  - Comments\n    - needs water')
        before.dispatch(before.state.update(toggleBulletFoldSpec(before.state, 4)!))
        const kept = keptFoldsOf(before.state)
        expect(kept).toEqual([{ line: 4, fingerprint: print('Garden', 'Comments'), nth: 1 }])
        const after = editorFixture('- note|\n- note\n- Garden\n  - Comments\n    - looks good\n  - Comments\n    - needs water')
        expect(resolveKeptFolds(after.state, kept)).toEqual([6])
    })

    it('drops a fold whose bullet was reworded or lost its children', () => {
        const { state } = editorFixture('- Garden plot|\n  - Beans\n- Kitchen')
        expect(resolveKeptFolds(state, [{ line: 1, fingerprint: print('Garden'), nth: 0 }])).toEqual([])
        expect(resolveKeptFolds(state, [{ line: 3, fingerprint: print('Kitchen'), nth: 0 }])).toEqual([])
    })

    it('makes an editor’s folds exactly the kept ones', () => {
        const editor = editorFixture(text)
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 1)!))
        editor.dispatch(editor.state.update({ effects: foldsToEffects(editor.state, [3]) }))
        expect(keptFoldsOf(editor.state).map((fold) => fold.line)).toEqual([3])
    })
})
