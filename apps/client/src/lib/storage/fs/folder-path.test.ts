import { describe, expect, it, vi } from 'vitest'

import { FOLDER_PATH_KEY_PREFIX, FOLDER_PATH_SKIPPED_KEY_PREFIX, folderPathOrAskOnce, joinGraphPath, readGraphFolderPath, writeGraphFolderPath } from './folder-path'

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

describe('asking for the folder path for an agent instruction', () => {
    const asked = (answer: string | null) => {
        const ask = vi.fn(async () => answer)
        return ask
    }

    it('uses a remembered path without asking', async () => {
        const storage = memoryStorage()
        writeGraphFolderPath('g1', '/home/you/notes', storage)
        const ask = asked('/elsewhere')
        expect(await folderPathOrAskOnce('g1', ask, storage)).toBe('/home/you/notes')
        expect(ask).not.toHaveBeenCalled()
    })

    it('remembers a path given in answer, and does not ask again', async () => {
        const storage = memoryStorage()
        expect(await folderPathOrAskOnce('g1', asked('  /home/you/notes '), storage)).toBe('/home/you/notes')
        const ask = asked('/elsewhere')
        expect(await folderPathOrAskOnce('g1', ask, storage)).toBe('/home/you/notes')
        expect(ask).not.toHaveBeenCalled()
    })

    it('has no path when the person skips, and does not ask them again on this graph', async () => {
        const storage = memoryStorage()
        expect(await folderPathOrAskOnce('g1', asked(null), storage)).toBeNull()
        expect(storage.getItem(`${FOLDER_PATH_SKIPPED_KEY_PREFIX}g1`)).toBe('1')
        const ask = asked('/elsewhere')
        expect(await folderPathOrAskOnce('g1', ask, storage)).toBeNull()
        expect(ask).not.toHaveBeenCalled()
        expect(await folderPathOrAskOnce('g2', asked('/other'), storage)).toBe('/other')
    })

    it('uses a path set after skipping', async () => {
        const storage = memoryStorage()
        await folderPathOrAskOnce('g1', asked(null), storage)
        writeGraphFolderPath('g1', '/home/you/notes', storage)
        expect(await folderPathOrAskOnce('g1', asked(null), storage)).toBe('/home/you/notes')
    })

    it('still uses the answer when storage is blocked', async () => {
        const blocked = {
            getItem: () => {
                throw new Error('blocked')
            },
            setItem: () => {
                throw new Error('blocked')
            },
            removeItem: () => {},
        } as unknown as Storage
        expect(await folderPathOrAskOnce('g1', asked('/home/you/notes'), blocked)).toBe('/home/you/notes')
        expect(await folderPathOrAskOnce('g1', asked(null), blocked)).toBeNull()
    })
})
