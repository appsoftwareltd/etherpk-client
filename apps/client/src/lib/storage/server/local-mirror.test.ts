import { describe, expect, it, vi } from 'vitest'
import { parseGraphThemeFile } from '$lib/storage/fs/theme-files'
import type { ProtectionRecord } from '$lib/crypto'

import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { assetIdFromRef } from './server-asset-store'
import {
    type MirrorAssetResult,
    type MirrorSource,
    type MirrorStatus,
    type MirrorText,
    assetFileFates,
    createLocalMirror,
} from './local-mirror'

interface FakeDocument {
    docId: string
    kind: 'journal' | 'page'
    concept: string
    aliases?: string[]
    text: string
    /** Whether the store could confirm this text; false is a document still catching up. */
    settled?: boolean
}

interface FakeSource extends MirrorSource {
    /** Announce a change the way the store does: named for content, unnamed for the registry. */
    fire(concept?: string): void
    readCalls: string[][]
}

function source(docs: FakeDocument[], overrides: Partial<MirrorSource> = {}): FakeSource {
    const listeners = new Set<(change?: { concept: string }) => void>()
    const readCalls: string[][] = []
    return {
        readCalls,
        listDocuments: () => docs.map(({ docId, kind, concept, aliases }) => ({ docId, kind, concept, aliases })),
        async readTexts(docIds, onProgress) {
            readCalls.push([...docIds])
            const out = new Map<string, MirrorText>()
            for (const docId of docIds) {
                const doc = docs.find((entry) => entry.docId === docId)
                if (doc) out.set(docId, { text: doc.text, settled: doc.settled ?? true })
                onProgress?.(out.size, docIds.length)
            }
            return out
        },
        confirmRegistry: async () => true,
        onChange(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        fire(concept) {
            for (const listener of listeners) listener(concept ? { concept } : undefined)
        },
        ...overrides,
    }
}

/** A clock that only moves when a write asks it to, so an untouched file keeps its mtime. */
function tickingAdapter(): DirectoryAdapter {
    let clock = 0
    return createMemoryDirectoryAdapter({ now: () => ++clock })
}

async function textOf(adapter: DirectoryAdapter, subdir: 'journals' | 'pages', name: string): Promise<string> {
    return (await adapter.read(subdir, name)).text
}

async function namesIn(adapter: DirectoryAdapter, subdir: 'journals' | 'pages' | 'assets'): Promise<string[]> {
    return (await adapter.list(subdir)).map((entry) => entry.name).sort()
}

describe('local mirror', () => {
    it('writes materialized documents as plain markdown (journals + titled pages)', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source([
                { docId: 'j1', kind: 'journal', concept: '2026-07-14', text: '- did a thing\n' },
                { docId: 'p1', kind: 'page', concept: 'Quantum Mechanics', text: 'The theory of the very small.\n' },
            ]),
            adapter,
        )
        await mirror.sync()

        expect(await textOf(adapter, 'journals', '2026-07-14.md')).toBe('- did a thing\n')
        expect(await textOf(adapter, 'pages', 'Quantum Mechanics.md')).toBe(
            '---\ntitle: Quantum Mechanics\n---\nThe theory of the very small.\n',
        )
        mirror.dispose()
    })

    it('merges the registry identity into a block the text already carries (ADR 0061)', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source([
                {
                    docId: 'p1',
                    kind: 'page',
                    concept: 'Quantum Mechanics',
                    aliases: ['QM'],
                    text: '---\npublic: true\n---\nbody\n',
                },
                { docId: 'p2', kind: 'page', concept: 'Plain', text: 'no block here\n' },
                { docId: 'j1', kind: 'journal', concept: '2026-07-14', aliases: ['Launch day'], text: '- did a thing\n' },
                { docId: 'j2', kind: 'journal', concept: '2026-07-15', text: '- quiet\n' },
            ]),
            adapter,
        )
        await mirror.sync()

        expect(await textOf(adapter, 'pages', 'Quantum Mechanics.md')).toBe(
            '---\ntitle: Quantum Mechanics\npublic: true\naliases:\n  - QM\n---\nbody\n',
        )
        expect(await textOf(adapter, 'pages', 'Plain.md')).toBe('---\ntitle: Plain\n---\nno block here\n')
        expect(await textOf(adapter, 'journals', '2026-07-14.md')).toBe(
            '---\naliases:\n  - Launch day\n---\n- did a thing\n',
        )
        expect(await textOf(adapter, 'journals', '2026-07-15.md')).toBe('- quiet\n')
        mirror.dispose()
    })

    it('re-syncs when the source changes, and names only the document that changed', async () => {
        const adapter = tickingAdapter()
        const docs: FakeDocument[] = [
            { docId: 'p1', kind: 'page', concept: 'Doc', text: 'first' },
            { docId: 'p2', kind: 'page', concept: 'Other', text: 'untouched' },
        ]
        const feed = source(docs)
        const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
        await mirror.sync()
        expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('first')
        const untouchedAt = (await adapter.list('pages')).find((entry) => entry.name === 'Other.md')!.lastModified

        docs[0].text = 'second version'
        feed.fire('Doc')
        await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second version'))

        // The other document was neither re-read nor rewritten: a keystroke is one file.
        expect(feed.readCalls.at(-1)).toEqual(['p1'])
        expect((await adapter.list('pages')).find((entry) => entry.name === 'Other.md')!.lastModified).toBe(untouchedAt)
        mirror.dispose()
    })

    it('leaves a file alone when its bytes would not change', async () => {
        const adapter = tickingAdapter()
        const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'same' }]
        const feed = source(docs)
        const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
        await mirror.sync()
        const writtenAt = (await adapter.list('pages'))[0].lastModified

        // A change fires but the materialized text is identical - a git working tree must not
        // see every file's mtime move on every edit elsewhere in the graph.
        feed.fire('Doc')
        await mirror.sync()
        expect((await adapter.list('pages'))[0].lastModified).toBe(writtenAt)
        mirror.dispose()
    })

    it('is faithful: a document removed from the graph is deleted from the mirror', async () => {
        const adapter = tickingAdapter()
        const both = source([
            { docId: 'p1', kind: 'page', concept: 'Alpha', text: 'a' },
            { docId: 'p2', kind: 'page', concept: 'Beta', text: 'b' },
        ])
        const first = createLocalMirror(both, adapter)
        await first.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['Alpha.md', 'Beta.md'])
        first.dispose()

        const second = createLocalMirror(source([{ docId: 'p1', kind: 'page', concept: 'Alpha', text: 'a' }]), adapter)
        await second.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['Alpha.md'])
        second.dispose()
    })

    it('deletes nothing while the registry is unconfirmed', async () => {
        const adapter = tickingAdapter()
        const seeded = createLocalMirror(
            source([
                { docId: 'p1', kind: 'page', concept: 'Alpha', text: 'a' },
                { docId: 'p2', kind: 'page', concept: 'Beta', text: 'b' },
            ]),
            adapter,
        )
        await seeded.sync()
        seeded.dispose()

        // Offline, "not in the registry" does not mean "deleted from the graph": the cached
        // registry can be a partial one, and a delete here is not recoverable from the folder.
        const offline = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Alpha', text: 'a' }], {
                confirmRegistry: async () => false,
            }),
            adapter,
        )
        await offline.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['Alpha.md', 'Beta.md'])
        offline.dispose()
    })

    it('skips a document whose content could not be confirmed, rather than emptying its file', async () => {
        const adapter = tickingAdapter()
        const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Alpha', text: 'real content' }]
        const good = createLocalMirror(source(docs), adapter)
        await good.sync()
        good.dispose()

        // A second session on a warm cache used to read this document as empty and write that
        // over the real body. An unsettled read is now a skip, and the tab is told which.
        const cold = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Alpha', text: '', settled: false }]),
            adapter,
        )
        await cold.sync()
        expect(await textOf(adapter, 'pages', 'Alpha.md')).toContain('real content')
        expect(cold.status().skipped).toEqual(['Alpha'])
        cold.dispose()
    })

    it('writes both documents of a duplicated concept, and reports the collision', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source([
                { docId: 'b', kind: 'page', concept: 'Foo', text: 'second body' },
                { docId: 'a', kind: 'page', concept: 'Foo', text: 'first body' },
            ]),
            adapter,
        )
        await mirror.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['Foo (2).md', 'Foo.md'])
        expect(await textOf(adapter, 'pages', 'Foo.md')).toContain('first body')
        expect(await textOf(adapter, 'pages', 'Foo (2).md')).toContain('second body')
        expect(mirror.status().collisions).toEqual([{ concept: 'Foo', fileName: 'Foo (2).md' }])
        mirror.dispose()
    })

    it('names a journal moved off its date, so the file still says which day it is', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source([
                { docId: 'b', kind: 'journal', concept: '2026-09-09', text: '- second' },
                { docId: 'a', kind: 'journal', concept: '2026-09-09', text: '- first' },
            ]),
            adapter,
        )
        await mirror.sync()
        expect(await textOf(adapter, 'journals', '2026-09-09.md')).toBe('- first')
        expect(await textOf(adapter, 'journals', '2026-09-09 (2).md')).toBe('---\ntitle: 2026-09-09\n---\n- second')
        mirror.dispose()
    })

    it('follows a renamed document to its new file and takes the old one away', async () => {
        const adapter = tickingAdapter()
        const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Old', text: 'body' }]
        const feed = source(docs)
        const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
        await mirror.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['Old.md'])

        docs[0].concept = 'New'
        feed.fire()
        await mirror.sync()
        expect(await namesIn(adapter, 'pages')).toEqual(['New.md'])
        expect(await textOf(adapter, 'pages', 'New.md')).toBe('---\ntitle: New\n---\nbody')
        mirror.dispose()
    })

    it('rewrites a file that was edited or deleted behind its back', async () => {
        const adapter = tickingAdapter()
        const feed = source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }])
        const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
        await mirror.sync()

        // Editing a mirrored file is pointless by design (ADR 0008): the server is master.
        await adapter.write('pages', 'Doc.md', 'hand edited\n')
        await mirror.sync()
        expect(await textOf(adapter, 'pages', 'Doc.md')).toBe('---\ntitle: Doc\n---\nbody')

        await adapter.remove('pages', 'Doc.md')
        await mirror.sync()
        expect(await textOf(adapter, 'pages', 'Doc.md')).toBe('---\ntitle: Doc\n---\nbody')
        mirror.dispose()
    })

    describe('renaming', () => {
        /** A folder as the old mirror left it: lower-cased, hyphenated, each file claiming its title. */
        async function oldStyleFolder(entries: Array<[name: string, title: string, body: string]>) {
            const adapter = tickingAdapter()
            for (const [name, title, body] of entries) {
                await adapter.write('pages', name, `---\ntitle: ${title}\n---\n${body}`)
            }
            return adapter
        }

        it('renames a file the old rule wrote, keeping its content and leaving no stray', async () => {
            const adapter = await oldStyleFolder([['submeta-kimura.md', 'Submeta Kimura', 'body']])
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Submeta Kimura', text: 'body' }]),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'pages')).toEqual(['Submeta Kimura.md'])
            expect(await textOf(adapter, 'pages', 'Submeta Kimura.md')).toBe('---\ntitle: Submeta Kimura\n---\nbody')
            mirror.dispose()
        })

        it('renames a file whose name differs only in case, removing the old one first', async () => {
            // On a case-insensitive filesystem `accessibility.md` and `Accessibility.md` are the
            // same file: writing the new name lands in the old file, and removing the old name
            // afterwards would destroy the result. The old file goes first, so the order the
            // adapter sees is remove then write.
            const adapter = await oldStyleFolder([['accessibility.md', 'Accessibility', 'body']])
            const order: string[] = []
            const watched: DirectoryAdapter = {
                ...adapter,
                remove: async (subdir, name) => {
                    order.push(`remove ${name}`)
                    return adapter.remove(subdir, name)
                },
                write: async (subdir, name, text) => {
                    order.push(`write ${name}`)
                    return adapter.write(subdir, name, text)
                },
            }
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Accessibility', text: 'body' }]),
                watched,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'pages')).toEqual(['Accessibility.md'])
            expect(order).toEqual(['remove accessibility.md', 'write Accessibility.md'])
            mirror.dispose()
        })

        it('removes the old file after the new one is written, so a failure leaves a copy', async () => {
            const adapter = await oldStyleFolder([['old-name.md', 'Old Name', 'body']])
            const order: string[] = []
            const watched: DirectoryAdapter = {
                ...adapter,
                remove: async (subdir, name) => {
                    order.push(`remove ${name}`)
                    return adapter.remove(subdir, name)
                },
                write: async (subdir, name, text) => {
                    order.push(`write ${name}`)
                    return adapter.write(subdir, name, text)
                },
            }
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Old Name', text: 'body' }]),
                watched,
            )
            await mirror.sync()
            expect(order).toEqual(['write Old Name.md', 'remove old-name.md'])
            mirror.dispose()
        })

        it('renames even while the registry is unconfirmed: the old file is this document\'s own', async () => {
            const adapter = await oldStyleFolder([['submeta-kimura.md', 'Submeta Kimura', 'body']])
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Submeta Kimura', text: 'body' }], {
                    confirmRegistry: async () => false,
                }),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'pages')).toEqual(['Submeta Kimura.md'])
            mirror.dispose()
        })

        it('leaves an unconfirmed document on its old file, and lets nothing else take that name', async () => {
            // `foo-bar.md` is the only copy of "Foo Bar", whose content cannot be confirmed this
            // pass. "foo-bar" wants exactly that name. Writing it there would destroy the copy.
            const adapter = await oldStyleFolder([['foo-bar.md', 'Foo Bar', 'the only copy']])
            const mirror = createLocalMirror(
                source([
                    { docId: 'p1', kind: 'page', concept: 'Foo Bar', text: '', settled: false },
                    { docId: 'p2', kind: 'page', concept: 'foo-bar', text: 'newcomer' },
                ]),
                adapter,
            )
            await mirror.sync()
            expect(await textOf(adapter, 'pages', 'foo-bar.md')).toContain('the only copy')
            expect(mirror.status().skipped.sort()).toEqual(['Foo Bar', 'foo-bar'])
            mirror.dispose()
        })

        it('reports the migration as writes, not as collisions', async () => {
            const adapter = await oldStyleFolder([
                ['accessibility.md', 'Accessibility', 'a'],
                ['7-zip.md', '7-Zip', 'z'],
            ])
            const mirror = createLocalMirror(
                source([
                    { docId: 'p1', kind: 'page', concept: 'Accessibility', text: 'a' },
                    { docId: 'p2', kind: 'page', concept: '7-Zip', text: 'z' },
                ]),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'pages')).toEqual(['7-Zip.md', 'Accessibility.md'])
            expect(mirror.status().collisions).toEqual([])
            mirror.dispose()
        })
    })


    describe('assets', () => {
        const ID = '11111111-1111-4111-8111-111111111111'
        const OTHER = '99999999-9999-4999-8999-999999999999'
        const NAME = `diagram.${ID}.png`
        const REF = `../assets/${NAME}`
        const BYTES = new Uint8Array([1, 2, 3])

        /** An asset source over a graph that holds `ids`, naming each one after its own id. */
        function assetsOf(ids: string[], fetched: (id: string) => MirrorAssetResult = () => ({ bytes: BYTES, fileName: `asset.${ids[0]}.png` })) {
            const fetches: string[] = []
            return {
                fetches,
                listGraphAssets: async () => ids,
                assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                fetchAsset: async (assetId: string) => {
                    fetches.push(assetId)
                    return fetched(assetId)
                },
            }
        }

        it('downloads an asset the documents reference, under the name they use', async () => {
            const adapter = tickingAdapter()
            const graph = assetsOf([ID])
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: `![d](${REF})\n` }], graph),
                adapter,
            )
            await mirror.sync()
            expect(graph.fetches).toEqual([ID])
            expect((await adapter.readBinary('assets', NAME)).bytes).toEqual(BYTES)
            mirror.dispose()
        })

        it('backs up an asset no document references, under the name its own metadata carries', async () => {
            // An [[Orphaned Asset]] is part of the graph and counts against the account's
            // storage, so the copy the user owns has to hold it. Reference scanning could never
            // see one, and could never see an attachment used only inside a protected document.
            const adapter = tickingAdapter()
            const graph = assetsOf([ID], () => ({ bytes: BYTES, fileName: `orphan.${ID}.png` }))
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'no links here\n' }], graph),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'assets')).toEqual([`orphan.${ID}.png`])
            mirror.dispose()
        })

        it('does not download one it already holds', async () => {
            const adapter = tickingAdapter()
            await adapter.writeBinary('assets', NAME, BYTES)
            const graph = assetsOf([ID])
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: `![d](${REF})\n` }], graph),
                adapter,
            )
            await mirror.sync()
            expect(graph.fetches).toEqual([])
            mirror.dispose()
        })

        it('copies from the folder when a reference changes its name, rather than downloading again', async () => {
            const adapter = tickingAdapter()
            await adapter.writeBinary('assets', NAME, BYTES)
            const graph = assetsOf([ID])
            const renamed = `sketch.${ID}.png`
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: `![d](../assets/${renamed})\n` }], graph),
                adapter,
            )
            await mirror.sync()
            expect(graph.fetches).toEqual([])
            expect((await adapter.readBinary('assets', renamed)).bytes).toEqual(BYTES)
            // The name nothing points at any more goes, but never the last copy of a live asset.
            expect(await namesIn(adapter, 'assets')).toEqual([renamed])
            mirror.dispose()
        })

        it('reports one it could not fetch, and leaves the documents alone', async () => {
            const adapter = tickingAdapter()
            const mirror = createLocalMirror(
                source(
                    [{ docId: 'p1', kind: 'page', concept: 'Doc', text: `![d](${REF})\n` }],
                    assetsOf([ID], () => 'unavailable'),
                ),
                adapter,
            )
            await mirror.sync()
            expect(mirror.status().missingAssets).toEqual([NAME])
            expect(await textOf(adapter, 'pages', 'Doc.md')).toContain(REF)
            mirror.dispose()
        })

        it('names a link the graph cannot resolve, and the document holding it', async () => {
            // "Retried on the next full pass" was said of these too, so a graph whose documents
            // point at files an Import could not carry across reported 195 attachments as pending
            // for ever, and Mirror now changed nothing (2026-09-09).
            const adapter = tickingAdapter()
            const mirror = createLocalMirror(
                source(
                    [{ docId: 'p1', kind: 'page', concept: 'Doc', text: '![o](../assets/old-import.png)\n' }],
                    assetsOf([ID]),
                ),
                adapter,
            )
            await mirror.sync()
            expect(mirror.status().danglingLinks).toEqual([{ name: 'old-import.png', concept: 'Doc' }])
            expect(mirror.status().missingAssets).toEqual([])
            mirror.dispose()
        })

        it('removes a file once the graph no longer holds its asset', async () => {
            // Which is what cleaning up orphans from Settings does: the asset leaves the server's
            // list, so the next pass takes the folder's copy with it.
            const adapter = tickingAdapter()
            const held = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body\n' }], assetsOf([ID])),
                adapter,
            )
            await held.sync()
            expect(await namesIn(adapter, 'assets')).toHaveLength(1)
            held.dispose()

            const cleaned = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body\n' }], assetsOf([])),
                adapter,
            )
            await cleaned.sync()
            expect(await namesIn(adapter, 'assets')).toEqual([])
            cleaned.dispose()
        })

        it('leaves alone a file whose name is not one the mirror writes', async () => {
            // A folder picked by mistake - a website project, a Markdown vault - keeps its images
            // in assets/ too. The mirror only ever writes `<stem>.<uuid>.<ext>`, so a name without
            // that shape cannot be a copy it made, and deleting it would destroy the user's own
            // files.
            const adapter = tickingAdapter()
            await adapter.writeBinary('assets', 'photo.jpg', BYTES)
            await adapter.writeBinary('assets', 'logo.svg', BYTES)
            // A bare id carries no stem, so the mirror never wrote it either.
            await adapter.writeBinary('assets', `${OTHER}.png`, BYTES)
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body\n' }], assetsOf([])),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'assets')).toEqual([`${OTHER}.png`, 'logo.svg', 'photo.jpg'])
            // And they are not counted as the graph's attachments.
            expect(mirror.status().assets).toBe(0)
            mirror.dispose()
        })

        it('decides every file in assets/ with one rule, which the takeover dialog shares', () => {
            const idOf = (name: string) => assetIdFromRef(`../assets/${name}`)
            const names = [
                'photo.jpg',
                `${OTHER}.png`,
                `old.${OTHER}.png`,
                `diagram.${ID}.png`,
                `sketch.${ID}.png`,
            ]
            const wanted = new Map([[ID, new Set([`sketch.${ID}.png`])]])
            expect(Object.fromEntries(assetFileFates(names, idOf, new Set([ID]), wanted))).toEqual({
                // Not a name the mirror writes: never touched.
                'photo.jpg': 'foreign',
                [`${OTHER}.png`]: 'foreign',
                // The mirror's shape, for an asset the graph does not hold.
                [`old.${OTHER}.png`]: 'not-held',
                // A second copy of a held asset under a name no document uses, now that the
                // name the documents use is present.
                [`diagram.${ID}.png`]: 'stale-name',
                [`sketch.${ID}.png`]: 'held',
            })
            // Without the documents' references (the takeover dialog), a held file is only "held".
            expect(assetFileFates([`diagram.${ID}.png`], idOf, new Set([ID]), null).get(`diagram.${ID}.png`)).toBe('held')
        })

        it('still removes a file in its own name shape whose asset the graph does not hold', async () => {
            const adapter = tickingAdapter()
            await adapter.writeBinary('assets', `left-over.${OTHER}.png`, BYTES)
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body\n' }], assetsOf([])),
                adapter,
            )
            await mirror.sync()
            expect(await namesIn(adapter, 'assets')).toEqual([])
            mirror.dispose()
        })

        it('touches nothing when the graph is offline and its assets cannot be listed', async () => {
            const adapter = tickingAdapter()
            await adapter.writeBinary('assets', NAME, BYTES)
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body\n' }], {
                    listGraphAssets: async () => null,
                    assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                    fetchAsset: async () => 'unavailable' as const,
                }),
                adapter,
            )
            await mirror.sync()
            // Reconciling against a list that could not be fetched is the one unrecoverable move.
            expect(await namesIn(adapter, 'assets')).toEqual([NAME])
            mirror.dispose()
        })
    })


    it('carries Graph Settings and the graph name, so the folder is a complete export', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }], {
                metadata: () => ({ name: 'My Graph', settings: { defaultMaxImageDisplaySize: '300' } }),
            }),
            adapter,
        )
        await mirror.sync()
        expect(JSON.parse((await adapter.read('etherpk', 'settings.json')).text)).toEqual({
            defaultMaxImageDisplaySize: '300',
        })
        expect(JSON.parse((await adapter.read('etherpk', 'graph.json')).text)).toEqual({ name: 'My Graph' })
        mirror.dispose()
    })

    it('carries Quick Notes as etherpk/quick-notes.json, and rewrites it only when they change', async () => {
        const adapter = tickingAdapter()
        let notes = [{ id: 'a', text: 'Ring the dentist', createdAt: 100 }]
        const mirror = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }], {
                metadata: () => ({ name: 'My Graph', quickNotes: notes }),
            }),
            adapter,
        )
        await mirror.sync()
        expect(JSON.parse((await adapter.read('etherpk', 'quick-notes.json')).text)).toEqual(notes)
        const written = (await adapter.read('etherpk', 'quick-notes.json')).lastModified
        await mirror.sync()
        expect((await adapter.read('etherpk', 'quick-notes.json')).lastModified).toBe(written)
        notes = []
        await mirror.sync()
        expect(JSON.parse((await adapter.read('etherpk', 'quick-notes.json')).text)).toEqual([])
        mirror.dispose()
    })

    it('carries the Graph Dictionary as etherpk/dictionary.txt, and writes no file for a graph without words', async () => {
        const adapter = tickingAdapter()
        let words: string[] = []
        const mirror = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }], {
                metadata: () => ({ name: 'My Graph', spellingDictionary: words }),
            }),
            adapter,
        )
        await mirror.sync()
        expect((await adapter.list('etherpk')).map((e) => e.name)).not.toContain('dictionary.txt')
        words = ['zebra', 'Kubernetes']
        await mirror.sync()
        expect((await adapter.read('etherpk', 'dictionary.txt')).text).toBe('Kubernetes\nzebra\n')
        words = []
        await mirror.sync()
        expect((await adapter.read('etherpk', 'dictionary.txt')).text).toBe('')
        mirror.dispose()
    })

    it('carries themes as etherpk/theme-<id>.jsonc and removes the file of a theme the graph no longer has', async () => {
        const adapter = tickingAdapter()
        let themes: GraphTheme[] = [{ id: 'mine', name: 'Mine', files: { 'theme.json': '{"name":"mine","contract":1}' } }]
        const mirror = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }], {
                metadata: () => ({ name: 'My Graph', themes }),
            }),
            adapter,
        )
        await mirror.sync()
        expect(parseGraphThemeFile((await adapter.read('etherpk', 'theme-mine.jsonc')).text, 'mine')).toEqual(themes[0])
        const written = (await adapter.read('etherpk', 'theme-mine.jsonc')).lastModified
        await mirror.sync()
        expect((await adapter.read('etherpk', 'theme-mine.jsonc')).lastModified).toBe(written)
        themes = [{ id: 'other', name: 'Other', files: {} }]
        await mirror.sync()
        expect((await adapter.list('etherpk')).map((e) => e.name).filter((n) => n.startsWith('theme-'))).toEqual(['theme-other.jsonc'])
        mirror.dispose()
    })

    it('carries the copier’s protection record as etherpk/protection.json, and removes it only when the graph has none (ADR 0093)', async () => {
        const RECORD: ProtectionRecord = {
            v: 1,
            fingerprint: 'ZmluZ2VycHJpbnQ',
            kdf: { m: 8192, t: 1, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
            wrapped: 'd3JhcHBlZA',
        }
        const adapter = tickingAdapter()
        let protection: ProtectionRecord | null | undefined = RECORD
        const mirror = createLocalMirror(
            source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }], {
                metadata: () => ({ name: 'My Graph', protection }),
            }),
            adapter,
        )
        await mirror.sync()
        expect(JSON.parse((await adapter.read('etherpk', 'protection.json')).text)).toEqual(RECORD)
        const written = (await adapter.read('etherpk', 'protection.json')).lastModified
        await mirror.sync()
        expect((await adapter.read('etherpk', 'protection.json')).lastModified).toBe(written)
        // Not knowable right now (a vault that could not be read) is not the same as none.
        protection = undefined
        await mirror.sync()
        expect(await adapter.exists('etherpk', 'protection.json')).toBe(true)
        protection = null
        await mirror.sync()
        expect(await adapter.exists('etherpk', 'protection.json')).toBe(false)
        mirror.dispose()
    })

    describe('failure', () => {
        function failingAdapter(error: Error): DirectoryAdapter {
            const inner = tickingAdapter()
            return { ...inner, write: async () => { throw error } }
        }

        it('pauses and says so when the folder permission is gone', async () => {
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }]),
                failingAdapter(new DOMException('denied', 'NotAllowedError')),
            )
            await mirror.sync()
            expect(mirror.status().paused).toEqual({
                kind: 'permission',
                message: 'EtherPK no longer has permission to write to this folder.',
            })
            expect(mirror.status().running).toBe(false)
            mirror.dispose()
        })

        it('pauses when the folder itself has gone', async () => {
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }]),
                failingAdapter(new DOMException('missing', 'NotFoundError')),
            )
            await mirror.sync()
            expect(mirror.status().paused?.kind).toBe('folder')
            mirror.dispose()
        })

        it('retries an ordinary failure before giving up, and resumes on request', async () => {
            const adapter = tickingAdapter()
            let failures = 1
            const flaky: DirectoryAdapter = {
                ...adapter,
                write: async (subdir, name, text) => {
                    if (failures-- > 0) throw new Error('disk was busy')
                    return adapter.write(subdir, name, text)
                },
            }
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }]),
                flaky,
                { retryDelaysMs: [0] },
            )
            await mirror.sync()
            await vi.waitFor(async () => expect(await namesIn(adapter, 'pages')).toEqual(['Doc.md']))
            expect(mirror.status().paused).toBeUndefined()
            mirror.dispose()
        })

        it('gives up after its retries, then writes everything once resumed', async () => {
            const adapter = tickingAdapter()
            let failing = true
            const flaky: DirectoryAdapter = {
                ...adapter,
                write: async (subdir, name, text) => {
                    if (failing) throw new Error('disk was busy')
                    return adapter.write(subdir, name, text)
                },
            }
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }]),
                flaky,
                { retryDelaysMs: [] },
            )
            await mirror.sync()
            expect(mirror.status().paused?.kind).toBe('error')

            failing = false
            mirror.resume()
            await vi.waitFor(async () => expect(await namesIn(adapter, 'pages')).toEqual(['Doc.md']))
            expect(mirror.status().paused).toBeUndefined()
            mirror.dispose()
        })
    })

    describe('progress', () => {
        it('reports each phase of a full pass, so a long one can be shown', async () => {
            const adapter = tickingAdapter()
            const mirror = createLocalMirror(
                source(
                    [
                        {
                            docId: 'p1',
                            kind: 'page',
                            concept: 'One',
                            text: '![d](../assets/a.22222222-2222-4222-8222-222222222222.png)',
                        },
                        { docId: 'p2', kind: 'page', concept: 'Two', text: 'body' },
                    ],
                    {
                        listGraphAssets: async () => ['22222222-2222-4222-8222-222222222222'],
                        assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                        fetchAsset: async () => ({ bytes: new Uint8Array([1]), fileName: 'a.png' }),
                    },
                ),
                adapter,
            )
            const seen: Array<{ kind: string; phase: string; done: number; total: number }> = []
            mirror.onStatus((status: MirrorStatus) => {
                if (status.pass) {
                    seen.push({ kind: status.pass.kind, ...status.pass.progress })
                }
            })
            await mirror.sync()

            // The four phases a pass does, in the order it does them.
            expect([...new Set(seen.map((entry) => entry.phase))]).toEqual(['scanning', 'reading', 'writing', 'assets'])
            expect(seen.every((entry) => entry.kind === 'full')).toBe(true)
            expect(seen.some((entry) => entry.phase === 'writing' && entry.done === 2 && entry.total === 2)).toBe(true)
            expect(seen.some((entry) => entry.phase === 'assets' && entry.done === 1 && entry.total === 1)).toBe(true)
            // Nothing claims to be running once the pass is over.
            expect(mirror.status().pass).toBeUndefined()
            mirror.dispose()
        })

        it('marks a one-document rewrite as targeted, so nothing announces it', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first' }]
            const feed = source(docs)
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
            await mirror.sync()

            const kinds: string[] = []
            mirror.onStatus((status) => {
                if (status.pass) kinds.push(status.pass.kind)
            })
            docs[0].text = 'second'
            feed.fire('Doc')
            await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second'))
            expect(kinds.length).toBeGreaterThan(0)
            expect(kinds.every((kind) => kind === 'targeted')).toBe(true)
            mirror.dispose()
        })
    })

    describe('lifecycle', () => {
        /** A source whose text reads can be held open, so a pass can be caught mid-flight. */
        function slowSource(docs: FakeDocument[]) {
            let release: () => void = () => {}
            const gate = new Promise<void>((resolve) => (release = resolve))
            const feed = source(docs)
            const readTexts = feed.readTexts
            feed.readTexts = async (docIds, onProgress) => {
                await gate
                return readTexts(docIds, onProgress)
            }
            return { feed, release: () => release() }
        }

        it('resolves Mirror now only once a full pass has actually ended', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first' }]
            const { feed, release } = slowSource(docs)
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
            mirror.start() // a pass is now in flight, held at its read

            let settled = false
            const now = mirror.sync().then(() => (settled = true))
            await new Promise((resolve) => setTimeout(resolve, 20))
            // Still waiting: the pass under way has not ended, so neither has "Mirror now".
            expect(settled).toBe(false)
            release()
            await now
            expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('first')
            expect(mirror.status().lastSyncAt).toBeDefined()
            mirror.dispose()
        })

        it('stops where it is when stopped mid-pass, and finishes the job when started again', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = [
                { docId: 'p1', kind: 'page', concept: 'One', text: 'one' },
                { docId: 'p2', kind: 'page', concept: 'Two', text: 'two' },
            ]
            const { feed, release } = slowSource(docs)
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
            const first = mirror.sync()
            mirror.stop()
            release()
            await first
            // Nothing was written after the stop, and the pass does not count as a sync.
            expect(await namesIn(adapter, 'pages')).toEqual([])
            expect(mirror.status().lastSyncAt).toBeUndefined()

            await mirror.sync()
            expect(await namesIn(adapter, 'pages')).toEqual(['One.md', 'Two.md'])
            mirror.dispose()
        })

        it('writes nothing once disposed, even with a read still in flight', async () => {
            const adapter = tickingAdapter()
            const { feed, release } = slowSource([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }])
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
            const pass = mirror.sync()
            mirror.dispose()
            release()
            await pass
            expect(await namesIn(adapter, 'pages')).toEqual([])
        })

        it('does not start over the top of a pause; resume is the way back', async () => {
            const mirror = createLocalMirror(
                source([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'body' }]),
                { ...tickingAdapter(), write: async () => { throw new DOMException('denied', 'NotAllowedError') } },
            )
            await mirror.sync()
            expect(mirror.status().paused?.kind).toBe('permission')
            mirror.start()
            expect(mirror.status().running).toBe(false)
            expect(mirror.status().paused?.kind).toBe('permission')
            mirror.dispose()
        })

        it('folds a pass waiting on the debounce into Mirror now', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first' }]
            const feed = source(docs)
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 60_000 })
            await mirror.sync()
            docs[0].text = 'second'
            feed.fire('Doc') // scheduled a minute out
            await mirror.sync() // ...but "now" means now
            expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second')
            mirror.dispose()
        })
    })

    describe('cost', () => {
        const ID = '44444444-4444-4444-8444-444444444444'
        function countingAssets() {
            let listings = 0
            return {
                listings: () => listings,
                listGraphAssets: async () => {
                    listings += 1
                    return [ID]
                },
                assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                fetchAsset: async () => ({ bytes: new Uint8Array([1]), fileName: `a.${ID}.png` }),
            }
        }

        it('asks the server for its assets on a full pass, but not for a keystroke', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first' }]
            const graph = countingAssets()
            const feed = source(docs, graph)
            const mirror = createLocalMirror(feed, adapter, { debounceMs: 0 })
            await mirror.sync()
            expect(graph.listings()).toBe(1)

            // A content change that references nothing new costs no server call and no listing.
            docs[0].text = 'second'
            feed.fire('Doc')
            await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second'))
            expect(graph.listings()).toBe(1)

            // The full pass already backed the asset up under its own name, unreferenced.
            expect(await namesIn(adapter, 'assets')).toEqual([`a.${ID}.png`])

            // A change that pastes it in under a new name does cost the pass, because the folder
            // has to hold the name the document now uses.
            docs[0].text = `second ![a](../assets/pasted.${ID}.png)`
            feed.fire('Doc')
            await vi.waitFor(async () => expect(await namesIn(adapter, 'assets')).toContain(`pasted.${ID}.png`))
            expect(graph.listings()).toBe(2)
            mirror.dispose()
        })

        it('announces progress in steps, not once per file', async () => {
            const adapter = tickingAdapter()
            const docs: FakeDocument[] = Array.from({ length: 120 }, (_, n) => ({
                docId: `p${n}`,
                kind: 'page' as const,
                concept: `Page ${n}`,
                text: `body ${n}`,
            }))
            const mirror = createLocalMirror(source(docs), adapter)
            let announcements = 0
            mirror.onStatus(() => (announcements += 1))
            await mirror.sync()
            // Four phases over 120 documents: well under one announcement per document.
            expect(announcements).toBeLessThan(40)
            expect(await namesIn(adapter, 'pages')).toHaveLength(120)
            mirror.dispose()
        })
    })


    describe('edits made elsewhere', () => {
        /**
         * A graph edited on another device. A browser tab hears live updates only for the
         * documents it shows, so an edit elsewhere to any other document fires no change here;
         * the only way to learn of it is to ask the server, which `docsBehind` stands in for.
         * Reading a document catches it up, as the store's `readTexts` does.
         */
        function editedElsewhere(docs: FakeDocument[]) {
            const behind = new Set<string>()
            const asked: string[][] = []
            let reachable = true
            const base = source(docs)
            const src: FakeSource = {
                ...base,
                async readTexts(docIds, onProgress) {
                    const out = await base.readTexts(docIds, onProgress)
                    for (const docId of docIds) behind.delete(docId)
                    return out
                },
                async docsBehind(docIds) {
                    asked.push([...docIds])
                    return reachable ? docIds.filter((docId) => behind.has(docId)) : null
                },
            }
            return {
                src,
                asked,
                edit(docId: string, text: string) {
                    docs.find((doc) => doc.docId === docId)!.text = text
                    behind.add(docId)
                },
                setReachable(value: boolean) {
                    reachable = value
                },
            }
        }

        it('Mirror now writes a document edited on another device that this tab never opened', async () => {
            const adapter = tickingAdapter()
            const graph = editedElsewhere([
                { docId: 'p1', kind: 'page', concept: 'Guest Notes', text: 'first\n' },
                { docId: 'p2', kind: 'page', concept: 'Other', text: 'other\n' },
            ])
            const mirror = createLocalMirror(graph.src, adapter)
            await mirror.sync()
            expect(await textOf(adapter, 'pages', 'Guest Notes.md')).toContain('first')

            // No change event: this tab is not subscribed to a document it is not showing.
            graph.edit('p1', 'first\nremote edit\n')
            await mirror.sync()

            expect(await textOf(adapter, 'pages', 'Guest Notes.md')).toContain('remote edit')
            // A full pass asks about every document, not only the ones it is about to write.
            expect(graph.asked.at(-1)?.sort()).toEqual(['p1', 'p2'])
            expect(mirror.status().changesElsewhereUnchecked).toBe(false)
            mirror.dispose()
        })

        it('asks on a timer while it runs, so the folder catches up without Mirror now', async () => {
            const adapter = tickingAdapter()
            const graph = editedElsewhere([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }])
            const mirror = createLocalMirror(graph.src, adapter, { debounceMs: 0, catchUpIntervalMs: 20 })
            mirror.start()
            await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('first'))

            graph.edit('p1', 'second\n')
            await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second'), {
                timeout: 2000,
            })
            mirror.dispose()
        })

        it('does not announce a write for a timed check that finds nothing', async () => {
            // The toolbar dot turns amber for every pass it hears about. A check every couple of
            // minutes that changes nothing must not blink it.
            const adapter = tickingAdapter()
            const graph = editedElsewhere([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }])
            let now = 1
            const mirror = createLocalMirror(graph.src, adapter, {
                debounceMs: 0,
                catchUpIntervalMs: 10,
                now: () => now,
            })
            mirror.start()
            await vi.waitFor(() => expect(mirror.status().lastSyncAt).toBe(1))
            const syncing: boolean[] = []
            mirror.onStatus((status) => syncing.push(status.syncing))
            now = 2
            const checks = graph.asked.length
            await vi.waitFor(() => expect(graph.asked.length).toBeGreaterThan(checks + 1))
            // A check that answered moves "last checked" on, and never says it is writing.
            await vi.waitFor(() => expect(mirror.status().lastSyncAt).toBe(2))
            expect(syncing).not.toContain(true)
            mirror.dispose()
        })

        it('does not call the folder checked while the server cannot be asked', async () => {
            const adapter = tickingAdapter()
            const graph = editedElsewhere([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }])
            graph.setReachable(false)
            const mirror = createLocalMirror(graph.src, adapter)
            await mirror.sync()
            // Offline, a document edited elsewhere may be missing, so the status must not say
            // the folder matches the graph.
            expect(mirror.status().changesElsewhereUnchecked).toBe(true)

            graph.setReachable(true)
            await mirror.sync()
            expect(mirror.status().changesElsewhereUnchecked).toBe(false)
            mirror.dispose()
        })

        it('asks again sooner after a check the server could not answer', async () => {
            const adapter = tickingAdapter()
            const graph = editedElsewhere([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }])
            graph.setReachable(false)
            const mirror = createLocalMirror(graph.src, adapter, {
                debounceMs: 0,
                catchUpIntervalMs: 60_000,
                catchUpRetryMs: 10,
            })
            mirror.start()
            await vi.waitFor(() => expect(mirror.status().changesElsewhereUnchecked).toBe(true))
            graph.setReachable(true)
            await vi.waitFor(() => expect(mirror.status().changesElsewhereUnchecked).toBe(false), { timeout: 2000 })
            mirror.dispose()
        })

        it('does not run its timed check in the middle of a retry backoff', async () => {
            // A failed pass waits out a backoff before its retry. A timed check armed before the
            // failure must not start a pass inside that wait.
            const adapter = tickingAdapter()
            let failNext = false
            let failed = false
            const failing: DirectoryAdapter = {
                ...adapter,
                async write(subdir, name, text) {
                    if (failNext) {
                        failNext = false
                        failed = true
                        throw new Error('disk hiccup')
                    }
                    return adapter.write(subdir, name, text)
                },
            }
            const docs: FakeDocument[] = [{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }]
            const graph = editedElsewhere(docs)
            const mirror = createLocalMirror(graph.src, failing, {
                debounceMs: 0,
                catchUpIntervalMs: 150,
                retryDelaysMs: [700],
            })
            mirror.start()
            await vi.waitFor(() => expect(mirror.status().lastSyncAt).toBeDefined(), { interval: 5 })

            // A keystroke's targeted pass, while the timed check is armed, fails to write.
            docs[0].text = 'second\n'
            failNext = true
            graph.src.fire('Doc')
            await vi.waitFor(() => expect(failed).toBe(true), { interval: 5 })
            await vi.waitFor(() => expect(mirror.status().syncing).toBe(false), { interval: 5 })
            const asked = graph.asked.length
            await new Promise((resolve) => setTimeout(resolve, 350))
            expect(graph.asked.length).toBe(asked)

            // The retry itself still runs, and writes the change.
            await vi.waitFor(async () => expect(await textOf(adapter, 'pages', 'Doc.md')).toContain('second'), {
                timeout: 2000,
            })
            mirror.dispose()
        })

        it('stops asking once stopped', async () => {
            const adapter = tickingAdapter()
            const graph = editedElsewhere([{ docId: 'p1', kind: 'page', concept: 'Doc', text: 'first\n' }])
            const mirror = createLocalMirror(graph.src, adapter, { debounceMs: 0, catchUpIntervalMs: 10 })
            mirror.start()
            await vi.waitFor(() => expect(graph.asked.length).toBeGreaterThan(1))
            mirror.stop()
            const asked = graph.asked.length
            await new Promise((resolve) => setTimeout(resolve, 60))
            expect(graph.asked.length).toBe(asked)
            mirror.dispose()
        })
    })

    it('reports what it holds, for the Mirror tab to show', async () => {
        const adapter = tickingAdapter()
        const mirror = createLocalMirror(
            source(
                [
                    {
                        docId: 'p1',
                        kind: 'page',
                        concept: 'Doc',
                        text: '![d](../assets/a.33333333-3333-4333-8333-333333333333.png)',
                    },
                ],
                {
                    listGraphAssets: async () => ['33333333-3333-4333-8333-333333333333'],
                    assetIdOf: (name: string) => assetIdFromRef(`../assets/${name}`),
                    fetchAsset: async () => ({ bytes: new Uint8Array([1]), fileName: 'a.png' }),
                },
            ),
            adapter,
            { folder: 'my-notes', now: () => 1234 },
        )
        const seen: number[] = []
        mirror.onStatus((status) => seen.push(status.documents))
        await mirror.sync()
        const status = mirror.status()
        expect(status).toMatchObject({ folder: 'my-notes', documents: 1, assets: 1, lastSyncAt: 1234, running: true })
        expect(seen.length).toBeGreaterThan(0)
        mirror.dispose()
    })
})
