import { afterEach, describe, expect, it } from 'vitest'
import { createImportMarkers } from './import-marker'

/** An in-memory stand-in for localStorage, shared by the "tabs" of one test. */
function memoryStorage() {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
    }
}

const opened: Array<{ close(): void }> = []
afterEach(() => {
    for (const markers of opened.splice(0)) markers.close()
})

/** One tab's view of the markers: its own storage handle and channel, sharing the browser's. */
function tab(storage: ReturnType<typeof memoryStorage>, channelName: string) {
    const markers = createImportMarkers({ storage, channelName, answerWithinMs: 50 })
    opened.push(markers)
    return markers
}

describe('import markers', () => {
    it('reports an import whose tab is gone as interrupted, with what it had created', async () => {
        const storage = memoryStorage()
        const importing = tab(storage, 'imports-gone')
        const started = importing.start({ name: 'Notes', destination: 'server' })
        started.setGraphId('018f47a0-7b5d-7cc5-b5c1-f0fbcde10005')
        // The tab closes mid-import: nothing clears the mark, and nothing answers for it.
        importing.close()

        const found = await tab(storage, 'imports-gone').findInterrupted()
        expect(found).toEqual([
            expect.objectContaining({ name: 'Notes', destination: 'server', graphId: '018f47a0-7b5d-7cc5-b5c1-f0fbcde10005' }),
        ])
    })

    it('does not report an import still running in another tab', async () => {
        const storage = memoryStorage()
        tab(storage, 'imports-alive').start({ name: 'Vault', destination: 'filesystem', folderName: 'Vault copy' })

        expect(await tab(storage, 'imports-alive').findInterrupted()).toEqual([])
    })

    it('forgets an import once it settles, and one the person has dealt with', async () => {
        const storage = memoryStorage()
        const importing = tab(storage, 'imports-forget')
        importing.start({ name: 'Done', destination: 'server' }).clear()
        const dropped = importing.start({ name: 'Dropped', destination: 'filesystem', folderName: 'Somewhere' })
        importing.close()

        const other = tab(storage, 'imports-forget')
        const [interrupted] = await other.findInterrupted()
        expect(interrupted).toMatchObject({ name: 'Dropped' })
        other.forget(interrupted.id)
        expect(await other.findInterrupted()).toEqual([])
        void dropped
    })
})
