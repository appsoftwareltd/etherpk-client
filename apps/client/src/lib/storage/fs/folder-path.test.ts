import { describe, expect, it } from 'vitest'

import { FOLDER_PATH_KEY_PREFIX, joinGraphPath, readGraphFolderPath, writeGraphFolderPath } from './folder-path'

function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, v),
    }
}

describe('joinGraphPath', () => {
    it('joins a POSIX folder path with the file below it', () => {
        expect(joinGraphPath('/home/you/notes', 'pages', 'Alpha.md')).toBe('/home/you/notes/pages/Alpha.md')
    })

    it('tolerates a trailing separator and surrounding whitespace on the folder path', () => {
        expect(joinGraphPath('  /home/you/notes/  ', 'journals', '2026-09-15.md')).toBe(
            '/home/you/notes/journals/2026-09-15.md',
        )
    })

    it('keeps backslashes for a Windows folder path', () => {
        expect(joinGraphPath('C:\\Users\\you\\notes\\', 'pages', 'Alpha.md')).toBe(
            'C:\\Users\\you\\notes\\pages\\Alpha.md',
        )
    })

    it('uses forward slashes when a path mixes both (a Windows path typed with slashes)', () => {
        expect(joinGraphPath('C:/Users/you/notes', 'pages', 'Alpha.md')).toBe('C:/Users/you/notes/pages/Alpha.md')
    })
})

describe('the remembered folder path', () => {
    it('is absent until written, then reads back trimmed', () => {
        const storage = memoryStorage()
        expect(readGraphFolderPath('g1', storage)).toBeNull()
        writeGraphFolderPath('g1', '  /home/you/notes ', storage)
        expect(readGraphFolderPath('g1', storage)).toBe('/home/you/notes')
        expect(storage.getItem(`${FOLDER_PATH_KEY_PREFIX}g1`)).toBe('/home/you/notes')
    })

    it('is per graph', () => {
        const storage = memoryStorage()
        writeGraphFolderPath('g1', '/a', storage)
        expect(readGraphFolderPath('g2', storage)).toBeNull()
    })

    it('is forgotten when written blank', () => {
        const storage = memoryStorage()
        writeGraphFolderPath('g1', '/a', storage)
        writeGraphFolderPath('g1', '   ', storage)
        expect(readGraphFolderPath('g1', storage)).toBeNull()
    })

    it('reads as absent without storage', () => {
        expect(readGraphFolderPath('g1', undefined)).toBeNull()
        expect(() => writeGraphFolderPath('g1', '/a', undefined)).not.toThrow()
    })
})
