import { describe, expect, it } from 'vitest'

import {
    exportLockName,
    graphIdOfScratchFile,
    leftoverExportFor,
    scratchFileName,
    sweepExportScratch,
    type ScratchFile,
    type ScratchStore,
} from './export-scratch'

function memoryStore(files: ScratchFile[]): ScratchStore & { files: ScratchFile[] } {
    return {
        files,
        async list() {
            return [...files]
        },
        async remove(name) {
            const at = files.findIndex((f) => f.name === name)
            if (at >= 0) files.splice(at, 1)
        },
    }
}

const HOUR = 60 * 60 * 1000

describe('export scratch files', () => {
    it('names one file per graph and reads the graph back out of the name', () => {
        expect(scratchFileName('g1')).toBe('g1.zip')
        expect(graphIdOfScratchFile('g1.zip')).toBe('g1')
        expect(graphIdOfScratchFile('notes.txt')).toBeNull()
        expect(graphIdOfScratchFile('.zip')).toBeNull()
        expect(exportLockName('g1')).toBe('etherpk-export:g1')
    })

    it('sweeps a file past the grace whose lock is free, and leaves the young and the in-use', async () => {
        const store = memoryStore([
            { name: 'old.zip', size: 10, lastModified: 0 },
            { name: 'young.zip', size: 10, lastModified: 2 * HOUR - 1000 },
            { name: 'busy.zip', size: 10, lastModified: 0 },
        ])
        const removed = await sweepExportScratch({
            store,
            now: () => 2 * HOUR,
            inUse: async (name) => name === 'busy.zip',
        })
        expect(removed).toEqual(['old.zip'])
        expect(store.files.map((f) => f.name)).toEqual(['young.zip', 'busy.zip'])
    })

    it('sweeps exactly at the grace, not before', async () => {
        const store = memoryStore([{ name: 'a.zip', size: 1, lastModified: 1000 }])
        expect(await sweepExportScratch({ store, now: () => 1000 + HOUR - 1, inUse: async () => false })).toEqual([])
        expect(await sweepExportScratch({ store, now: () => 1000 + HOUR, inUse: async () => false })).toEqual(['a.zip'])
    })

    it('names the graph’s leftover file only when it is there and nobody is using it', async () => {
        const store = memoryStore([{ name: 'g1.zip', size: 42, lastModified: 5 }])
        expect(await leftoverExportFor('g1', store, async () => false)).toEqual({ name: 'g1.zip', size: 42, lastModified: 5 })
        expect(await leftoverExportFor('g1', store, async () => true)).toBeNull()
        expect(await leftoverExportFor('g2', store, async () => false)).toBeNull()
    })
})
