import { beforeEach, describe, expect, it } from 'vitest'

import { createSafetyCopy, safetyCopyKey } from './safety-copy'

function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (key) => map.get(key) ?? null,
        key: (index) => [...map.keys()][index] ?? null,
        removeItem: (key) => void map.delete(key),
        setItem: (key, value) => void map.set(key, String(value)),
    }
}

interface Row {
    id: string
    name: string
}

const parseRow = (value: unknown): Row | null => {
    const row = value as Partial<Row> | null
    return row && typeof row.id === 'string' && typeof row.name === 'string' ? { id: row.id, name: row.name } : null
}

let storage: Storage

beforeEach(() => {
    storage = memoryStorage()
})

describe('a safety copy', () => {
    it('round-trips a record under a namespaced key', () => {
        const copy = createSafetyCopy('rows', parseRow, storage)
        copy.write('a', { id: 'a', name: 'Alpha' })

        expect(copy.read('a')).toEqual({ id: 'a', name: 'Alpha' })
        expect(storage.getItem(safetyCopyKey('rows', 'a'))).toBe(JSON.stringify({ id: 'a', name: 'Alpha' }))
    })

    it('enumerates only its own namespace', () => {
        const rows = createSafetyCopy('rows', parseRow, storage)
        const other = createSafetyCopy('other', parseRow, storage)
        rows.write('a', { id: 'a', name: 'Alpha' })
        rows.write('b', { id: 'b', name: 'Beta' })
        other.write('c', { id: 'c', name: 'Gamma' })
        storage.setItem('etherpk:unrelated', 'x')

        expect([...rows.readAll().keys()].sort()).toEqual(['a', 'b'])
        expect(other.readAll().get('c')).toEqual({ id: 'c', name: 'Gamma' })
    })

    it('removes a record, so a forgotten graph cannot come back from the copy', () => {
        const copy = createSafetyCopy('rows', parseRow, storage)
        copy.write('a', { id: 'a', name: 'Alpha' })
        copy.remove('a')

        expect(copy.read('a')).toBeNull()
        expect(copy.readAll().size).toBe(0)
    })

    it('ignores an entry that does not parse rather than throwing', () => {
        const copy = createSafetyCopy('rows', parseRow, storage)
        storage.setItem(safetyCopyKey('rows', 'broken'), '{not json')
        storage.setItem(safetyCopyKey('rows', 'wrong-shape'), JSON.stringify({ id: 42 }))
        copy.write('a', { id: 'a', name: 'Alpha' })

        expect(copy.read('broken')).toBeNull()
        expect([...copy.readAll().keys()]).toEqual(['a'])
    })

    it('is inert without a storage, which is what SSR and a blocked storage look like', () => {
        const copy = createSafetyCopy('rows', parseRow, null)
        expect(() => copy.write('a', { id: 'a', name: 'Alpha' })).not.toThrow()
        expect(copy.read('a')).toBeNull()
        expect(copy.readAll().size).toBe(0)
    })

    it('survives a storage that throws on write, since the copy is a safety net and not the record', () => {
        const throwing: Storage = {
            ...storage,
            length: 0,
            setItem: () => {
                throw new DOMException('quota', 'QuotaExceededError')
            },
        }
        const copy = createSafetyCopy('rows', parseRow, throwing)
        expect(() => copy.write('a', { id: 'a', name: 'Alpha' })).not.toThrow()
    })

    it('finds a record whose id contains the separator', () => {
        const copy = createSafetyCopy('rows', parseRow, storage)
        copy.write('a:b', { id: 'a:b', name: 'Colon' })
        expect(copy.read('a:b')).toEqual({ id: 'a:b', name: 'Colon' })
        expect([...copy.readAll().keys()]).toEqual(['a:b'])
    })
})
