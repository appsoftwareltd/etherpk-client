import { describe, expect, it } from 'vitest'

import type { KnownFolder } from '$lib/storage/server/mirror-takeover'

import { findPublishFolderOverlap, publishFolderOverlapMessage } from './publish-folder-check'

/**
 * Choosing a [[Publish Folder]] in the Publish tab. A publish deletes, from the folder it writes
 * into, the files under assets/ and theme/ and the top-level pages it did not produce, so a folder
 * that is a graph's folder, sits inside one or holds one would lose that graph's files. The
 * folders this device knows belong to a graph are its local graphs and the Local Mirrors.
 */

/** A stand-in for a `FileSystemDirectoryHandle`, by path, as the Mirror's own check is tested. */
function handle(path: string, options: { throws?: boolean } = {}) {
    return {
        path,
        async isSameEntry(other: unknown): Promise<boolean> {
            if (options.throws) throw new DOMException('gone', 'NotFoundError')
            return (other as { path?: string } | null)?.path === path
        },
        async resolve(other: unknown): Promise<string[] | null> {
            if (options.throws) throw new DOMException('gone', 'NotFoundError')
            const target = (other as { path?: string } | null)?.path
            if (target === path) return []
            return target?.startsWith(`${path}/`) ? target.slice(path.length + 1).split('/') : null
        },
    }
}

const known: KnownFolder[] = [
    { handle: handle('/home/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'Notes' } },
    { handle: handle('/home/team-mirror'), owner: { kind: 'mirror', graphId: 'sv1', name: 'Team' } },
]

describe('findPublishFolderOverlap', () => {
    it('refuses a graph folder itself, recognised by handle rather than by name', async () => {
        expect(await findPublishFolderOverlap(handle('/home/notes'), known)).toEqual({
            kind: 'local-graph',
            graphId: 'fs1',
            name: 'Notes',
            relation: 'same',
        })
        expect(await findPublishFolderOverlap(handle('/elsewhere/notes'), known)).toBeNull()
    })

    it('refuses a folder inside a graph folder, at any depth', async () => {
        expect(await findPublishFolderOverlap(handle('/home/notes/site'), known)).toMatchObject({ graphId: 'fs1', relation: 'inside' })
        expect(await findPublishFolderOverlap(handle('/home/team-mirror/assets/site'), known)).toMatchObject({
            kind: 'mirror',
            graphId: 'sv1',
            relation: 'inside',
        })
    })

    it('refuses a folder that holds a graph folder, at any depth', async () => {
        expect(await findPublishFolderOverlap(handle('/home'), known)).toMatchObject({ graphId: 'fs1', relation: 'contains' })
    })

    it('accepts a folder beside the graphs, and skips a remembered handle that has gone', async () => {
        expect(await findPublishFolderOverlap(handle('/home/site'), known)).toBeNull()
        const gone: KnownFolder[] = [{ handle: handle('/x', { throws: true }), owner: { kind: 'mirror', graphId: 'g', name: 'G' } }]
        expect(await findPublishFolderOverlap(handle('/x', { throws: true }), gone)).toBeNull()
    })
})

describe('publishFolderOverlapMessage', () => {
    it('says what the folder is, why that is refused, and what to do', () => {
        expect(publishFolderOverlapMessage('notes', { kind: 'local-graph', graphId: 'fs1', name: 'Notes', relation: 'same' })).toBe(
            '“notes” is the folder of your local graph “Notes”. A publish deletes the files it did not write from the folder it publishes into, so a site needs a folder of its own, outside any graph. Choose another folder.',
        )
        expect(publishFolderOverlapMessage('site', { kind: 'mirror', graphId: 'sv1', name: 'Team', relation: 'inside' })).toContain(
            '“site” is inside the folder where “Team” is mirrored on this device.',
        )
        expect(publishFolderOverlapMessage('home', { kind: 'local-graph', graphId: 'fs1', name: 'Notes', relation: 'contains' })).toContain(
            '“home” holds the folder of your local graph “Notes”.',
        )
    })
})
