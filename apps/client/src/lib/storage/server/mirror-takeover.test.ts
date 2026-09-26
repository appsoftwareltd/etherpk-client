import { describe, expect, it } from 'vitest'

import type { Subdir } from '$lib/storage/fs/directory-adapter'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import type { MirrorDocument } from './mirror-names'
import {
    type FolderReader,
    type KnownFolder,
    checkMirrorTakeover,
    findFolderOwner,
    knownFolders,
    openAsLocalGraphRefusal,
} from './mirror-takeover'

/**
 * What choosing a folder for the [[Local Mirror]] does before it touches anything.
 *
 * The mirror deletes: every Markdown file under journals/ and pages/ that is not a document of
 * the graph, and its own attachment files the graph no longer holds. Choosing the wrong folder
 * is an easy slip in a native picker, so the check has to see every folder the mirror manages,
 * name what will go, and refuse outright the two folders this device knows belong to something
 * else: a local graph's own folder, and another graph's mirror.
 */
const ASSET = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'

/**
 * A stand-in for a `FileSystemDirectoryHandle`, by path: two handles are the same entry when their
 * paths match, and `resolve` gives the path down to a descendant, as the real one does.
 */
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

/** A folder over the memory adapter, read the way the check reads one: never creating anything. */
async function folder(files: Partial<Record<Subdir, Record<string, string>>>): Promise<FolderReader> {
    let clock = 0
    const adapter = createMemoryDirectoryAdapter({ now: () => ++clock })
    for (const [subdir, entries] of Object.entries(files) as [Subdir, Record<string, string>][]) {
        for (const [name, text] of Object.entries(entries)) await adapter.write(subdir, name, text)
    }
    return {
        list: async (subdir) => (await adapter.list(subdir).catch(() => [])).map((entry) => entry.name),
        read: async (subdir, name) => (await adapter.read(subdir, name)).text,
    }
}

const docs: MirrorDocument[] = [
    { docId: 'd1', kind: 'page', concept: 'Report: Draft' },
    { docId: 'd2', kind: 'journal', concept: '2026-09-24' },
]

function check(reader: FolderReader, options: { owner?: KnownFolder[]; held?: string[] | null } = {}) {
    return checkMirrorTakeover({
        handle: handle('/chosen'),
        folder: 'chosen',
        known: options.owner ?? [],
        reader,
        docs,
        heldAssetIds: async () => (options.held === undefined ? [ASSET] : options.held),
    })
}

describe('knownFolders', () => {
    it('lists every local graph folder and every other graph’s mirror, by name', () => {
        const local = handle('/notes')
        const mirror = handle('/backup')
        const known = knownFolders(
            [
                { id: 'fs1', name: 'My Notes', backend: 'filesystem', handle: local },
                { id: 'sv1', name: 'Team Archive', backend: 'server', handle: null },
                { id: 'sv2', name: 'Side Graph', backend: 'server', handle: null },
            ],
            [
                { graphId: 'sv1', handle: mirror, folder: 'backup' },
                // This graph's own mirror is not a reason to refuse its own folder.
                { graphId: 'sv2', handle: handle('/own'), folder: 'own' },
                // A graph this device no longer holds mirrors nothing: its record is left over.
                { graphId: 'gone', handle: handle('/old'), folder: 'old' },
            ],
            'sv2',
        )
        expect(known).toEqual([
            { handle: local, owner: { kind: 'local-graph', graphId: 'fs1', name: 'My Notes' } },
            { handle: mirror, owner: { kind: 'mirror', graphId: 'sv1', name: 'Team Archive' } },
        ])
    })
})

describe('findFolderOwner', () => {
    it('recognises the same folder by handle, not by name', async () => {
        const known: KnownFolder[] = [
            { handle: handle('/a/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'Notes' } },
        ]
        expect(await findFolderOwner(handle('/a/notes'), known)).toEqual({
            kind: 'local-graph',
            graphId: 'fs1',
            name: 'Notes',
            relation: 'same',
        })
        // Another folder that happens to share the name is not the local graph's.
        expect(await findFolderOwner(handle('/b/notes'), known)).toBeNull()
    })

    it('finds a folder inside a known one, and one that holds a known one as a managed subfolder', async () => {
        const known: KnownFolder[] = [
            { handle: handle('/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'Notes' } },
            { handle: handle('/parent/pages'), owner: { kind: 'mirror', graphId: 'sv1', name: 'Team' } },
        ]
        expect(await findFolderOwner(handle('/notes/assets/img'), known)).toMatchObject({
            graphId: 'fs1',
            relation: 'inside',
        })
        // The mirror would write into `/parent/pages` - that graph's own folder.
        expect(await findFolderOwner(handle('/parent'), known)).toMatchObject({
            graphId: 'sv1',
            relation: 'holds',
            subfolder: 'pages',
        })
        // A folder that merely contains a graph folder elsewhere is not touched by a mirror.
        expect(await findFolderOwner(handle('/'), known)).toBeNull()
    })

    it('skips a remembered handle that can no longer be compared', async () => {
        const known: KnownFolder[] = [
            { handle: handle('/x'), owner: { kind: 'mirror', graphId: 'g', name: 'G' } },
        ]
        expect(await findFolderOwner(handle('/x', { throws: true }), known)).toBeNull()
    })
})

describe('checkMirrorTakeover', () => {
    it('starts at once in an empty folder', async () => {
        expect(await check(await folder({}))).toEqual({ kind: 'start' })
    })

    it('asks first when only assets/ holds files, and says they are left alone', async () => {
        const decision = await check(await folder({ assets: { 'photo.jpg': 'x', 'logo.svg': 'y' } }))
        expect(decision.kind).toBe('confirm')
        if (decision.kind !== 'confirm') return
        expect(decision.message).toContain('“chosen”')
        expect(decision.message).toContain('2 files')
        expect(decision.message).toContain('deletes and replaces none of them')
        expect(decision.message).toContain('2 other files are left alone')
        // Nothing would be lost, so the button is not dressed as a destructive one.
        expect(decision.destructive).toBe(false)
    })

    it('counts what the first pass would delete and replace, per kind of file', async () => {
        const decision = await check(
            await folder({
                pages: {
                    // Claims a document of this graph through its title: replaced.
                    'Report_ Draft.md': '---\ntitle: Report: Draft\n---\nold body',
                    // Not a document of this graph: deleted.
                    'Keep Me.md': 'mine',
                    // Not Markdown: the mirror never looks at it.
                    'notes.txt': 'plain',
                },
                journals: { '2020-01-01.md': 'old day' },
                assets: {
                    [`chart.${ASSET}.png`]: 'held by the graph',
                    [`old.${GONE}.png`]: 'not held',
                    'photo.jpg': 'the user’s own',
                },
                etherpk: { 'settings.json': '{"mine": true}', 'readme.txt': 'kept' },
            }),
        )
        expect(decision.kind).toBe('confirm')
        if (decision.kind !== 'confirm') return
        expect(decision.message).toBe(
            '“chosen” already has 9 files in journals/, pages/, assets/ or etherpk/. Mirroring here deletes ' +
                '2 Markdown files that are not documents of this graph, deletes 1 attachment file this graph ' +
                'does not hold, replaces 1 Markdown file with this graph’s version and overwrites or removes up ' +
                'to 1 EtherPK file in etherpk/. 1 attachment file this graph holds is kept, under the names its ' +
                'documents use. 3 other files are left alone, as is everything outside those four folders. This ' +
                'cannot be undone.',
        )
        expect(decision.destructive).toBe(true)
        expect(decision.confirmLabel).toBe('Mirror and replace contents')
    })

    it('never says a second copy of a held attachment is left alone', async () => {
        // The asset pass removes a copy under a name no document uses once the documents' name is
        // present. Which name the documents use is only known after reading every document, so
        // the dialog puts these files in their own category rather than among the untouched.
        const decision = await check(
            await folder({ assets: { [`old.${ASSET}.png`]: 'x', [`new.${ASSET}.png`]: 'x', 'photo.jpg': 'y' } }),
        )
        expect(decision.kind === 'confirm' && decision.message).toContain(
            '2 attachment files this graph holds are kept, under the names its documents use. 1 other file is left alone',
        )
    })

    it('says "up to" for attachments when the graph’s list could not be fetched', async () => {
        const decision = await check(await folder({ assets: { [`chart.${ASSET}.png`]: 'x' } }), { held: null })
        expect(decision.kind === 'confirm' && decision.message).toContain(
            'can delete up to 1 attachment file this graph does not hold',
        )
    })

    it('tells a re-chosen mirror of this graph apart from a folder of someone else’s notes', async () => {
        // Re-choosing your own old mirror deletes nothing, and says so: the same dialog for both
        // would teach people to click through it.
        const decision = await check(
            await folder({
                pages: { 'Report_ Draft.md': '---\ntitle: Report: Draft\n---\nbody' },
                journals: { '2026-09-24.md': 'today' },
            }),
        )
        expect(decision.kind === 'confirm' && decision.message).toContain(
            'Mirroring here replaces 2 Markdown files with this graph’s version.',
        )
        expect(decision.kind === 'confirm' && decision.message).not.toContain('deletes')
    })

    it('refuses a local graph’s folder, naming the graph, without reading it', async () => {
        let read = false
        const reader: FolderReader = {
            list: async () => {
                read = true
                return []
            },
            read: async () => '',
        }
        const decision = await checkMirrorTakeover({
            handle: handle('/notes'),
            folder: 'notes',
            known: [{ handle: handle('/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'My Notes' } }],
            reader,
            docs,
            heldAssetIds: async () => [],
        })
        expect(decision).toEqual({
            kind: 'refuse',
            title: 'This is a local graph’s folder',
            message:
                '“notes” is the folder of your local graph “My Notes”. Mirroring a synced graph into it would ' +
                'delete and overwrite that graph’s pages. Choose another folder, ideally an empty one.',
        })
        expect(read).toBe(false)
    })

    it('refuses a folder inside a local graph’s folder, or one holding it as pages/', async () => {
        const known: KnownFolder[] = [
            { handle: handle('/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'My Notes' } },
        ]
        const inside = await checkMirrorTakeover({
            handle: handle('/notes/assets'),
            folder: 'assets',
            known,
            reader: await folder({}),
            docs,
            heldAssetIds: async () => [],
        })
        expect(inside).toEqual({
            kind: 'refuse',
            title: 'This folder is inside a local graph’s folder',
            message:
                '“assets” is inside the folder of your local graph “My Notes”. Mirroring a synced graph there ' +
                'would write its files into that graph’s folder. Choose another folder, ideally an empty one.',
        })
        const holds = await checkMirrorTakeover({
            handle: handle('/work'),
            folder: 'work',
            known: [{ handle: handle('/work/pages'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'My Notes' } }],
            reader: await folder({}),
            docs,
            heldAssetIds: async () => [],
        })
        expect(holds.kind === 'refuse' && holds.message).toBe(
            '“work/pages” is the folder of your local graph “My Notes”. Mirroring a synced graph into “work” ' +
                'would write into that graph’s folder and delete files in it. Choose another folder, ideally an ' +
                'empty one.',
        )
    })

    it('refuses a folder inside another graph’s mirror, such as its assets/', async () => {
        const decision = await checkMirrorTakeover({
            handle: handle('/backup/assets'),
            folder: 'assets',
            known: [{ handle: handle('/backup'), owner: { kind: 'mirror', graphId: 'sv1', name: 'Team Archive' } }],
            reader: await folder({}),
            docs,
            heldAssetIds: async () => [],
        })
        expect(decision).toEqual({
            kind: 'refuse',
            title: 'This folder is inside another graph’s mirror',
            message:
                '“assets” is inside the folder where “Team Archive” is mirrored on this device. A mirror there ' +
                'would mix this graph’s files into that one’s. Choose another folder, or first stop mirroring ' +
                '“Team Archive” under its Settings > Mirror and Export.',
        })
    })

    it('allows a folder that only contains a graph’s folder somewhere below it', async () => {
        const decision = await checkMirrorTakeover({
            handle: handle('/home'),
            folder: 'home',
            known: [{ handle: handle('/home/notes'), owner: { kind: 'local-graph', graphId: 'fs1', name: 'My Notes' } }],
            reader: await folder({}),
            docs,
            heldAssetIds: async () => [],
        })
        // The mirror writes only into home/journals, pages, assets and etherpk.
        expect(decision).toEqual({ kind: 'start' })
    })

    it('refuses another graph’s mirror, naming that graph and the way out', async () => {
        const decision = await checkMirrorTakeover({
            handle: handle('/backup'),
            folder: 'backup',
            known: [{ handle: handle('/backup'), owner: { kind: 'mirror', graphId: 'sv1', name: 'Team Archive' } }],
            reader: await folder({ pages: { 'A.md': 'a' } }),
            docs,
            heldAssetIds: async () => [],
        })
        expect(decision).toEqual({
            kind: 'refuse',
            title: 'This folder is another graph’s mirror',
            message:
                '“backup” is where “Team Archive” is mirrored on this device. Two graphs mirrored to one ' +
                'folder delete each other’s files. Choose another folder, or first stop mirroring “Team Archive” ' +
                'under its Settings > Mirror and Export.',
        })
    })
})

describe('openAsLocalGraphRefusal', () => {
    it('says why a mirror folder is not opened as a local graph', () => {
        const mirror = { kind: 'mirror', graphId: 'sv1', name: 'Team Archive' } as const
        expect(openAsLocalGraphRefusal('backup', { ...mirror, relation: 'same' })).toBe(
            '“backup” is where “Team Archive” is mirrored on this device, so changes made to it as a local ' +
                'graph would be undone the next time that mirror runs. Choose another folder, or first stop ' +
                'mirroring “Team Archive” under its Settings > Mirror and Export.',
        )
        expect(openAsLocalGraphRefusal('assets', { ...mirror, relation: 'inside' })).toBe(
            '“assets” overlaps the folder where “Team Archive” is mirrored on this device, and a local graph ' +
                'there would mix its files with the mirror’s. Choose another folder, or first stop mirroring ' +
                '“Team Archive” under its Settings > Mirror and Export.',
        )
    })
})
