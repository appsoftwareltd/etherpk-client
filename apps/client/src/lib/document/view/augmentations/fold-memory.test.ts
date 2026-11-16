import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toggleBulletFoldSpec } from './outline-folds'
import { createFoldMemory, type FoldStorage, foldFingerprint, foldMemoryKey } from './fold-memory'
import { foldsToEffects, keptFoldsOf, resolveKeptFolds } from './fold-persistence'
import { editorFixture } from '../testing/editor-state-fixture'

function memoryStorage(): FoldStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('fold memory', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('keeps each document’s folds under the graph’s key, written after a pause', () => {
        const storage = memoryStorage()
        const memory = createFoldMemory({ storage: () => storage, storageKey: foldMemoryKey('g1'), saveDelayMs: 100 })
        memory.set('garden', [{ line: 1, fingerprint: foldFingerprint('Garden') }])
        expect(storage.data.size).toBe(0)
        vi.advanceTimersByTime(100)
        const again = createFoldMemory({ storage: () => storage, storageKey: foldMemoryKey('g1') })
        expect(again.get('garden')).toEqual([{ line: 1, fingerprint: foldFingerprint('Garden') }])
        expect(again.get('kitchen')).toEqual([])
    })

    it('forgets a document whose folds are all opened', () => {
        const storage = memoryStorage()
        const memory = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        memory.set('garden', [{ line: 1, fingerprint: 'aaaaaaaa' }])
        memory.flush()
        memory.set('garden', [])
        memory.flush()
        expect(JSON.parse(storage.data.get('k')!).docs).toEqual([])
    })

    it('keeps another tab’s documents when it writes its own', () => {
        const storage = memoryStorage()
        const one = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        const two = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        one.get('garden')
        two.set('kitchen', [{ line: 2, fingerprint: 'bbbbbbbb' }])
        two.flush()
        one.set('garden', [{ line: 1, fingerprint: 'aaaaaaaa' }])
        one.flush()
        const read = createFoldMemory({ storage: () => storage, storageKey: 'k' })
        expect(read.get('kitchen')).toHaveLength(1)
        expect(read.get('garden')).toHaveLength(1)
    })

    it('tells the document’s other editors of a change, not the one that made it', () => {
        const memory = createFoldMemory({ storage: () => null, storageKey: '' })
        const heard: (object | undefined)[] = []
        const me = {}
        memory.subscribe('garden', (source) => heard.push(source))
        memory.set('garden', [{ line: 1, fingerprint: 'aaaaaaaa' }], me)
        // The same folds again is no change, and no one is told.
        memory.set('garden', [{ line: 1, fingerprint: 'aaaaaaaa' }], me)
        expect(heard).toEqual([me])
    })

    it('reads nothing it cannot trust', () => {
        const storage = memoryStorage()
        storage.data.set('k', JSON.stringify({ v: 1, docs: [['garden', [[0, 'aaaaaaaa'], [2, 'not-hex'], [3, 'cccccccc']]]] }))
        expect(createFoldMemory({ storage: () => storage, storageKey: 'k' }).get('garden')).toEqual([{ line: 3, fingerprint: 'cccccccc' }])
        storage.data.set('k', '{not json')
        expect(createFoldMemory({ storage: () => storage, storageKey: 'k' }).get('garden')).toEqual([])
    })
})

describe('finding kept folds again', () => {
    const text = '- Garden|\n  - Beans\n- Kitchen\n  - Pantry'

    it('keeps each folded bullet by its line and its text’s fingerprint', () => {
        const editor = editorFixture(text)
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 3)!))
        expect(keptFoldsOf(editor.state)).toEqual([{ line: 3, fingerprint: foldFingerprint('Kitchen') }])
    })

    it('finds a fold at its line, or at the nearest bullet with its fingerprint when lines moved', () => {
        const { state } = editorFixture('- Cellar|\n- Garden\n  - Beans\n- Kitchen\n  - Pantry')
        expect(resolveKeptFolds(state, [{ line: 4, fingerprint: foldFingerprint('Kitchen') }])).toEqual([4])
        expect(resolveKeptFolds(state, [{ line: 3, fingerprint: foldFingerprint('Kitchen') }])).toEqual([4])
    })

    it('drops a fold whose bullet was reworded or lost its children', () => {
        const { state } = editorFixture('- Garden plot|\n  - Beans\n- Kitchen')
        expect(resolveKeptFolds(state, [{ line: 1, fingerprint: foldFingerprint('Garden') }])).toEqual([])
        expect(resolveKeptFolds(state, [{ line: 3, fingerprint: foldFingerprint('Kitchen') }])).toEqual([])
    })

    it('makes an editor’s folds exactly the kept ones', () => {
        const editor = editorFixture(text)
        editor.dispatch(editor.state.update(toggleBulletFoldSpec(editor.state, 1)!))
        editor.dispatch(editor.state.update({ effects: foldsToEffects(editor.state, [3]) }))
        expect(keptFoldsOf(editor.state).map((fold) => fold.line)).toEqual([3])
    })
})
