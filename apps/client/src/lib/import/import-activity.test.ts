/**
 * The phase vocabulary is a string contract between the converters/materialisers and the
 * Activity's declared phase list. These pin that the two agree, and specifically that the
 * step counter only ever moves FORWARD.
 *
 * The regression: a single shared phase list assumed every converter reads markdown before
 * planning assets. They do not — Logseq and Obsidian plan assets first, EtherPK converts
 * first — so on the live drive "Step 2 of 6" was followed by "Step 1 of 6".
 */
import { describe, expect, it } from 'vitest'

import { convertSource } from './convert'
import { importMarkerFields, phasesFor, serverImportOutcome, type ServerImportRequest } from './import-activity'
import { materializeToFilesystem } from './materialize-filesystem'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import type { ImportFormat, ImportProgress, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

/** A source exercising every phase: markdown in both trees, plus an asset to plan. */
function source(): SourceFile[] {
    return [
        src('logseq/config.edn', ':journal/file-name-format "yyyy_MM_dd"'),
        src('journals/2026_07_16.md', '- today\n- id:: 11111111-2222-3333-4444-555555555555'),
        src('pages/Foo.md', '- see ![x](../assets/pic.png)'),
        src('assets/pic.png', new Uint8Array([1, 2, 3])),
    ]
}

const FORMATS: ImportFormat[] = ['logseq', 'obsidian', 'markdown', 'etherpk']

describe.each(FORMATS)('phase contract: %s', (format) => {
    it('emits only declared labels, in declared order, never moving backwards', async () => {
        const declared = phasesFor(format, 'filesystem')
        const indexOf = new Map(declared.map((p, i) => [p.label, i]))
        const labels: string[] = []
        const onProgress = (p: ImportProgress) => labels.push(p.label)

        const graph = await convertSource(source(), format, { onProgress })
        await materializeToFilesystem(graph, createMemoryDirectoryAdapter({ now: () => 0 }), {
            format,
            reportDate: '2026-07-16',
            control: { onProgress },
        })

        // Every label the pipeline emits must be one the toast declared, or its bar and its
        // step counter describe a phase that does not exist.
        for (const label of labels) expect(indexOf.get(label), `undeclared phase "${label}"`).toBeDefined()

        // And the sequence must be monotonic: a step counter that goes 2 -> 1 -> 3 is worse
        // than no step counter.
        let furthest = -1
        for (const label of labels) {
            const index = indexOf.get(label)!
            expect(index, `phase "${label}" went backwards`).toBeGreaterThanOrEqual(furthest)
            furthest = index
        }
        expect(furthest).toBeGreaterThan(0) // it actually progressed
    })

    it('declares a bytes unit for every asset phase', async () => {
        // Measured on a real graph: 4 of 6168 assets carried 14% of all bytes, so a file
        // counter freezes on each of them.
        for (const phase of phasesFor(format, 'server')) {
            if (/assets/i.test(phase.label)) expect(phase.unit).toBe('bytes')
        }
    })
})

describe('phasesFor', () => {
    it('gives each destination its own tail', () => {
        const local = phasesFor('logseq', 'filesystem').map((p) => p.label)
        const synced = phasesFor('logseq', 'server').map((p) => p.label)

        expect(local).toEqual([
            'Preparing assets',
            'Reading files',
            'Indexing references',
            'Converting documents',
            'Writing documents',
            'Writing assets',
        ])
        expect(synced).toEqual([
            'Preparing assets',
            'Reading files',
            'Indexing references',
            'Converting documents',
            'Uploading assets',
            'Preparing documents',
            'Sending changes',
            'Syncing changes',
        ])
    })

    it('puts EtherPK\'s conversion before its asset planning', () => {
        // The odd one out: it converts markdown first and plans assets afterwards.
        expect(phasesFor('etherpk', 'filesystem').slice(0, 2).map((p) => p.label)).toEqual([
            'Converting documents',
            'Preparing assets',
        ])
    })
})

describe('serverImportOutcome', () => {
    const acked = { fullyAcked: true, ackedDocuments: 10, totalDocuments: 10 }
    const syncing = { fullyAcked: false, ackedDocuments: 3, totalDocuments: 10 }

    it('says the graph is here only once the server has confirmed it', () => {
        expect(serverImportOutcome({ ...acked, missing: 0 }, 9, 2)).toEqual({ state: 'done', detail: '9 documents, 2 assets' })
        expect(serverImportOutcome({ ...acked, missing: 2 }, 9, 2)).toEqual({
            state: 'partial',
            detail: '2 files could not be uploaded and are listed in the import report - the rest of the graph is here.',
        })
    })

    it('leads with the unconfirmed documents, whatever else went wrong', () => {
        expect(serverImportOutcome({ ...syncing, missing: 0 }, 9, 2)).toEqual({
            state: 'partial',
            detail: 'Still syncing to the server - 3 of 10 confirmed. It will finish in the background.',
        })
        expect(serverImportOutcome({ ...syncing, missing: 1 }, 9, 2)).toEqual({
            state: 'partial',
            detail: 'Still syncing to the server - 3 of 10 confirmed. It will finish in the background. 1 file could not be uploaded and is listed in the import report.',
        })
    })
})

describe("an import's marker", () => {
    // A device can hold several Sync Servers (ADR 0111): a cut-off synced import is cleared up on the
    // server it was writing to, so the marker says which.
    it('names the Sync Server a synced import writes to', () => {
        const destination = {
            kind: 'server',
            deps: { serverScope: { serverOrigin: 'https://team.example.org', principalId: 'p1' } },
        } as unknown as ServerImportRequest
        expect(importMarkerFields('Notes', destination)).toEqual({
            name: 'Notes',
            destination: 'server',
            serverOrigin: 'https://team.example.org',
        })
    })

    it('names the folder a folder import writes into', () => {
        const handle = { name: 'Imported' } as FileSystemDirectoryHandle
        expect(importMarkerFields('Notes', { kind: 'filesystem', handle, registry: {} as never })).toEqual({
            name: 'Notes',
            destination: 'filesystem',
            folderName: 'Imported',
        })
    })
})
