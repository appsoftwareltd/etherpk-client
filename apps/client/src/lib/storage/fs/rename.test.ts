/**
 * Rename against the real FilesystemDocumentStore (ADR 0037). The two arms differ in what
 * they touch, and the refusals are the part that must not regress.
 */
import { describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { createFilesystemDocumentStore } from './filesystem-store'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import type { DirectoryAdapter } from './directory-adapter'

async function graph(files: { subdir: 'pages' | 'journals'; name: string; text: string }[]) {
    const adapter: DirectoryAdapter = createMemoryDirectoryAdapter({ now: () => 0 })
    await adapter.ensureSkeleton()
    for (const file of files) await adapter.write(file.subdir, file.name, file.text)
    const store = createFilesystemDocumentStore(adapter)
    await store.scan()
    return { adapter, store }
}

// The block EtherPK itself writes: a scoped title such as `[[Physics]] Quantum` is quoted, since
// an unquoted `[[` starts a YAML list and the block would not parse.
const page = (title: string, body = '') => ({
    subdir: 'pages' as const,
    name: `${title}.md`,
    text: `---\n${stringifyYaml({ title })}---\n${body}`,
})

describe('renamePage — alias strategy', () => {
    it('renames the page and keeps the old name as an alias', async () => {
        const { adapter, store } = await graph([page('Physics', '- content')])

        const result = await store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        expect(result).toEqual({ concept: 'Physical Science', rewritten: 0, rewrittenDocuments: [], cascaded: 0, merged: 0 })
        const { text } = await adapter.read('pages', 'Physical Science.md')
        expect(text).toContain('title: Physical Science')
        // Every existing [[Physics]] keeps resolving, because that is what an Alias is for.
        expect(text).toContain('Physics')
        expect(text).toContain('- content')
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
    })

    it('leaves inbound links exactly as authored', async () => {
        // "The source is always canonical and is never hidden behind a rendered label."
        const { adapter, store } = await graph([page('Physics'), page('Notes', '- see [[Physics]]')])

        await store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        expect((await adapter.read('pages', 'Notes.md')).text).toContain('[[Physics]]')
    })

    it('does not add the alias twice on a repeat rename back', async () => {
        const { adapter, store } = await graph([page('Physics')])
        await store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })
        await store.renamePage('Physical Science', 'Physics', { strategy: 'alias' })
        const { text } = await adapter.read('pages', 'Physics.md')
        expect(text.match(/Physics/g)?.length).toBeLessThan(4)
    })
})

describe('renamePage — rewrite strategy', () => {
    it('rewrites inbound links and reports how many documents moved', async () => {
        const { adapter, store } = await graph([
            page('Physics'),
            page('Notes', '- see [[Physics]]'),
            page('Diary', '- also [[Physics]] twice [[Physics]]'),
            page('Unrelated', '- nothing here'),
        ])

        const result = await store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        // Documents, not occurrences: the dialog promises to update documents.
        expect(result.rewritten).toBe(2)
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('[[Physical Science]]')
        expect((await adapter.read('pages', 'Diary.md')).text).not.toContain('[[Physics]]')
        expect((await adapter.read('pages', 'Unrelated.md')).text).toContain('- nothing here')
    })

    it('does not rewrite the frontmatter of other documents', async () => {
        // Only the body is rewritten; a title that happens to contain the name is identity,
        // not a reference.
        const { adapter, store } = await graph([page('Physics'), page('Physics Notes', '- see [[Physics]]')])

        await store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        const { text } = await adapter.read('pages', 'Physics Notes.md')
        expect(text).toContain('title: Physics Notes')
        expect(text).toContain('[[Physical Science]]')
    })
})

describe('renamePage — refusals', () => {
    it('refuses to rename a journal entry', async () => {
        const { store } = await graph([
            { subdir: 'journals', name: '2026-07-16.md', text: '- today' },
        ])
        await expect(store.renamePage('2026-07-16', 'Something', { strategy: 'alias' })).rejects.toThrow(
            /journal entry cannot be renamed/i,
        )
    })

    it('refuses to rename a page to a day, leaving the page where it was', async () => {
        const { adapter, store } = await graph([page('Meeting', '- notes')])
        expect((await store.planRename('Meeting', '2026-09-01')).refusal).toContain('“2026-09-01” is a date')
        await expect(store.renamePage('Meeting', '2026-09-01', { strategy: 'rewrite' })).rejects.toThrow('“2026-09-01” is a date')
        expect((await adapter.list('pages')).map((e) => e.name)).toEqual(['Meeting.md'])
        expect(await adapter.list('journals')).toEqual([])
    })

    it('refuses to merge a page into a day\'s journal entry, which keeps its bare body', async () => {
        // The merge wrote the page's `title` block into the journal file, whose identity is its
        // file name and which carries no frontmatter (ADR 0056).
        const { adapter, store } = await graph([
            page('Meeting', '- notes'),
            { subdir: 'journals', name: '2026-09-01.md', text: '- day' },
        ])
        await expect(store.renamePage('Meeting', '2026-09-01', { strategy: 'alias' })).rejects.toThrow('“2026-09-01” is a date')
        expect((await adapter.read('journals', '2026-09-01.md')).text).toBe('- day')
        expect(await adapter.exists('pages', 'Meeting.md')).toBe(true)
    })

    it('renames a page an older version named after a day to an ordinary name', async () => {
        const { adapter, store } = await graph([page('2026-09-01', '- misfiled')])
        await store.renamePage('2026-09-01', 'Launch Day', { strategy: 'alias' })
        expect((await adapter.list('pages')).map((e) => e.name)).toEqual(['Launch Day.md'])
    })

    // A collision is NO LONGER a refusal — ADR 0038 §4 made it a Merge. See the Merge
    // describe below.

    it('allows a pure re-casing, which is not a collision', async () => {
        const { store } = await graph([page('physics')])
        const result = await store.renamePage('physics', 'Physics', { strategy: 'alias' })
        expect(result.concept).toBe('Physics')
    })

    it('keeps the file it has on a pure re-casing', async () => {
        // On NTFS and APFS `physics.md` and `Physics.md` are one file, so writing the new casing
        // and then removing the old one deletes the document. The memory adapter cannot show
        // that; it can show that the file is left alone, which is what makes it safe there.
        const { adapter, store } = await graph([page('physics', '- body')])

        await store.renamePage('physics', 'Physics', { strategy: 'alias' })

        expect(await adapter.exists('pages', 'physics.md')).toBe(true)
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
        const { text } = await adapter.read('pages', 'physics.md')
        expect(text).toContain('title: Physics')
        expect(text).toContain('- body')
        expect(store.listDocuments()[0]).toMatchObject({ concept: 'Physics', fileName: 'physics.md' })
    })

    it('renames onto a name whose portable file is another document’s without touching that file', async () => {
        // `A/B` is not a concept collision with `A_B` (no merge), but the two share one stem:
        // the rename used to write `A_B.md` over the other document.
        const { adapter, store } = await graph([page('A_B', '- underscore'), page('Foo', '- foo')])

        await store.renamePage('Foo', 'A/B', { strategy: 'alias' })

        expect((await adapter.read('pages', 'A_B.md')).text).toContain('- underscore')
        const renamed = (await adapter.read('pages', 'A_B (2).md')).text
        expect(renamed).toContain('title: A/B')
        expect(renamed).toContain('- foo')
        expect(await adapter.exists('pages', 'Foo.md')).toBe(false)
        expect(store.listDocuments().map((d) => d.concept).sort()).toEqual(['A/B', 'A_B'])
    })

    it('refuses an empty name', async () => {
        const { store } = await graph([page('Physics')])
        await expect(store.renamePage('Physics', '   ', { strategy: 'alias' })).rejects.toThrow(/non-empty/i)
    })

    it('does not refuse an unknown concept - it is pageless, and renames by rewriting (ADR 0064)', async () => {
        const { store } = await graph([page('Physics')])
        await expect(store.renamePage('Nope', 'X', { strategy: 'alias' })).resolves.toMatchObject({ concept: 'X' })
    })
})

/**
 * A rename rewrites each document's block from its parsed YAML. A block that does not parse reads
 * as empty, so the rewrite would replace it with a bare title and drop every key it held - from
 * the file, which on a local graph is the only copy. The rename is refused instead, before any
 * step writes, and every file stays exactly as it was.
 */
describe('renamePage — a block whose YAML does not parse', () => {
    const broken = '---\ntags: [a]\nstatus: draft\ntags: [b]\n---\n- body\n'
    const refusal = /frontmatter is not valid YAML/

    async function files(adapter: DirectoryAdapter): Promise<Record<string, string>> {
        const out: Record<string, string> = {}
        for (const entry of await adapter.list('pages')) out[entry.name] = (await adapter.read('pages', entry.name)).text
        return out
    }

    it('refuses to rename the page, under either link strategy, and writes nothing', async () => {
        const { adapter, store } = await graph([{ subdir: 'pages', name: 'Draft.md', text: broken }])
        const before = await files(adapter)
        // The dialog's preview says so before Confirm, and the Headless Client refuses on it.
        expect((await store.planRename('Draft', 'Final')).refusal).toMatch(/^“Draft” cannot be renamed while its frontmatter is not valid YAML/)
        for (const strategy of ['alias', 'rewrite'] as const) {
            await expect(store.renamePage('Draft', 'Final', { strategy })).rejects.toThrow(refusal)
        }
        expect(await files(adapter)).toEqual(before)
    })

    it('refuses a cascade when a cascaded page’s block does not parse, before the first step writes', async () => {
        const { adapter, store } = await graph([
            page('Physics', '- p'),
            { subdir: 'pages', name: '[[Physics]] Quantum.md', text: broken },
        ])
        const before = await files(adapter)
        await expect(store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })).rejects.toThrow(
            '“Physics” cannot be renamed while the frontmatter of “[[Physics]] Quantum”, which the rename rewrites, is not valid YAML',
        )
        expect(await files(adapter)).toEqual(before)
    })

    // The check reads what the rename rewrites: the file, not an open buffer still inside its
    // autosave. A block fixed in the editor but not yet saved is still broken on disk.
    it('judges the file the rename rewrites, not an open buffer that has not been saved', async () => {
        const { store } = await graph([{ subdir: 'pages', name: 'Draft.md', text: broken }])
        await store.whenReady('Draft')
        const handle = store.open('Draft')
        const fixed = '---\ntags: [a, b]\nstatus: draft\n---\n'
        handle.applyChange({ from: 0, to: handle.getText().indexOf('- body'), insert: fixed })
        expect((await store.planRename('Draft', 'Final')).refusal).toMatch(refusal)
        await store.flushDocument('Draft')
        expect((await store.planRename('Draft', 'Final')).refusal).toBeNull()
    })

    it('refuses to merge into a page whose block does not parse', async () => {
        const { adapter, store } = await graph([page('Physics', '- p'), { subdir: 'pages', name: 'Recipes.md', text: broken }])
        const before = await files(adapter)
        await expect(store.renamePage('Physics', 'Recipes', { strategy: 'alias' })).rejects.toThrow('the frontmatter of “Recipes”, which the rename rewrites')
        expect(await files(adapter)).toEqual(before)
    })
})

describe('planRename', () => {
    it('counts referencing documents, not occurrences, ignoring scoped and code links', async () => {
        const { store } = await graph([
            page('Physics'),
            page('A', '- [[Physics]] and [[Physics]]'),
            page('B', '- [[[[Physics]] Quantum]] only'),
            page('C', '- `[[Physics]]` only'),
        ])
        const plan = await store.planRename('Physics', 'Physical Science')
        expect(plan.referencingDocuments).toBe(1)
    })

    it('reports the cascade without writing anything', async () => {
        const { adapter, store } = await graph([
            page('Physics'),
            page('[[Physics]] Quantum'),
            page('[[[[Physics]] Quantum]] Fields'),
            page('Unrelated'),
        ])

        const plan = await store.planRename('Physics', 'Physical Science')

        expect(plan.refusal).toBeNull()
        expect(plan.direct).toMatchObject({ from: 'Physics', to: 'Physical Science', merges: false })
        expect(plan.cascade.map((s) => s.to)).toEqual(
            expect.arrayContaining(['[[Physical Science]] Quantum', '[[[[Physical Science]] Quantum]] Fields']),
        )
        // Deepest first, so a shallower step never lands on a name a deeper one still holds.
        expect(plan.cascade[0].from).toBe('[[[[Physics]] Quantum]] Fields')
        // A plan writes nothing.
        expect(await adapter.exists('pages', 'Physics.md')).toBe(true)
        expect(await adapter.exists('pages', 'Physical Science.md')).toBe(false)
    })

    it('flags a cascaded collision as a merge rather than refusing', async () => {
        const { store } = await graph([
            page('Physics'),
            page('[[Physics]] Quantum'),
            page('[[Chemistry]] Quantum'), // the name the cascade will land on
        ])
        const plan = await store.planRename('Physics', 'Chemistry')
        expect(plan.refusal).toBeNull()
        expect(plan.cascade.find((s) => s.from === '[[Physics]] Quantum')?.merges).toBe(true)
    })
})

/**
 * The cascade (ADR 0038): a Scoped Concept's name CONTAINS its Scope's name, so renaming
 * "Physics" has to rename every concept beneath it, at any depth.
 */
describe('renamePage — the cascade', () => {
    it('renames scoped concepts at every depth', async () => {
        const { adapter, store } = await graph([
            page('Physics'),
            page('[[Physics]] Quantum', '- q'),
            page('[[[[Physics]] Quantum]] Fields', '- f'),
            page('Unrelated', '- u'),
        ])

        const result = await store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        expect(result.cascaded).toBe(2)
        expect(await adapter.exists('pages', '[[Physical Science]] Quantum.md')).toBe(true)
        expect(await adapter.exists('pages', '[[[[Physical Science]] Quantum]] Fields.md')).toBe(true)
        expect(await adapter.exists('pages', '[[Physics]] Quantum.md')).toBe(false)
        // Content travels with the rename.
        expect((await adapter.read('pages', '[[Physical Science]] Quantum.md')).text).toContain('- q')
        expect((await adapter.read('pages', 'Unrelated.md')).text).toContain('- u')
    })

    it('gives every cascaded document its old name as an alias', async () => {
        // ADR 0038 §3: otherwise the alias promise holds for one document and breaks for the
        // dozen the cascade just renamed.
        const { adapter, store } = await graph([page('Physics'), page('[[Physics]] Quantum')])

        await store.renamePage('Physics', 'Physical Science', { strategy: 'alias' })

        const { text } = await adapter.read('pages', '[[Physical Science]] Quantum.md')
        expect(text).toContain('[[Physics]] Quantum')
    })

    it('rewrites SCOPED references in bodies under the rewrite arm', async () => {
        // The one textual rule: rewriting the inner [[Physics]] fixes the scoped link too.
        const { adapter, store } = await graph([
            page('Physics'),
            page('[[Physics]] Quantum'),
            page('Notes', '- see [[[[Physics]] Quantum]] and [[Physics]]'),
        ])

        await store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        const { text } = await adapter.read('pages', 'Notes.md')
        expect(text).toContain('[[[[Physical Science]] Quantum]]')
        expect(text).toContain('[[Physical Science]]')
        expect(text).not.toContain('[[Physics]]')
    })

    it('renames a scope that has no page of its own', async () => {
        // "Physics" exists only as a scope; the scoped documents still have to move.
        const { adapter, store } = await graph([page('[[Physics]] Quantum'), page('Notes', '- [[Physics]]')])
        await store.renamePage('[[Physics]] Quantum', '[[Physical Science]] Quantum', { strategy: 'alias' })
        expect(await adapter.exists('pages', '[[Physical Science]] Quantum.md')).toBe(true)
    })
})

describe('renamePage — Merge on collision', () => {
    it('joins the bodies and unions the aliases instead of refusing', async () => {
        const { adapter, store } = await graph([
            page('Physics', '- from physics'),
            page('Recipes', '- from recipes'),
        ])

        const result = await store.renamePage('Physics', 'Recipes', { strategy: 'alias' })

        expect(result.merged).toBe(1)
        const { text } = await adapter.read('pages', 'Recipes.md')
        // Nothing is discarded; the survivor's content comes first.
        expect(text).toContain('- from recipes')
        expect(text).toContain('- from physics')
        // The absorbed name still resolves.
        expect(text).toContain('Physics')
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
    })

    it('merges into the survivor’s real file, even a suffixed one', async () => {
        // An importer legitimately stores a document as `X (2).md`. The merged text used to go
        // to the derived name instead, leaving the survivor's own file untouched beside it.
        const { adapter, store } = await graph([
            { subdir: 'pages', name: 'Recipes (2).md', text: '---\ntitle: Recipes\n---\n- from recipes' },
            page('Physics', '- from physics'),
        ])

        const result = await store.renamePage('Physics', 'Recipes', { strategy: 'alias' })

        expect(result.merged).toBe(1)
        const { text } = await adapter.read('pages', 'Recipes (2).md')
        expect(text).toContain('- from recipes')
        expect(text).toContain('- from physics')
        expect(await adapter.exists('pages', 'Recipes.md')).toBe(false)
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
        expect(store.listDocuments().map((d) => [d.concept, d.fileName])).toEqual([['Recipes', 'Recipes (2).md']])
    })

    it('merges a cascaded collision too', async () => {
        const { adapter, store } = await graph([
            page('Physics'),
            page('[[Physics]] Quantum', '- physics quantum'),
            page('[[Chemistry]] Quantum', '- chemistry quantum'),
        ])

        const result = await store.renamePage('Physics', 'Chemistry', { strategy: 'alias' })

        expect(result.merged).toBeGreaterThan(0)
        const { text } = await adapter.read('pages', '[[Chemistry]] Quantum.md')
        expect(text).toContain('- chemistry quantum')
        expect(text).toContain('- physics quantum')
    })
})

describe('deleteDocument', () => {
    it('removes the file and the registry entry', async () => {
        const { adapter, store } = await graph([page('Physics'), page('Recipes')])

        await store.deleteDocument('Physics')

        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
        expect(store.listDocuments().map((d) => d.concept)).toEqual(['Recipes'])
    })

    it('notifies that the document was removed, so an open tab can close', async () => {
        const { store } = await graph([page('Physics')])
        const removed: string[] = []
        store.onDocumentRemoved((target) => removed.push(target))
        await store.deleteDocument('Physics')
        // The CONCEPT, not a lower-cased key: a View is keyed by the concept.
        expect(removed).toEqual(['Physics'])
    })

    it('leaves inbound links alone — they become pageless, not broken', async () => {
        const { adapter, store } = await graph([page('Physics'), page('Notes', '- see [[Physics]]')])
        await store.deleteDocument('Physics')
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('[[Physics]]')
    })

    it('never cascades: scoped children survive', async () => {
        // ADR 0039 §6 — "Physics" simply becomes pageless again.
        const { adapter, store } = await graph([page('Physics'), page('[[Physics]] Quantum')])
        await store.deleteDocument('Physics')
        expect(await adapter.exists('pages', '[[Physics]] Quantum.md')).toBe(true)
    })

    it('deletes a journal entry', async () => {
        const { adapter, store } = await graph([{ subdir: 'journals', name: '2026-07-16.md', text: '- old' }])
        await store.deleteDocument('2026-07-16')
        expect(await adapter.exists('journals', '2026-07-16.md')).toBe(false)
    })

    it('is idempotent', async () => {
        const { store } = await graph([page('Physics')])
        await store.deleteDocument('Physics')
        await expect(store.deleteDocument('Physics')).resolves.toBeUndefined()
    })
})

describe('resurrection', () => {
    it('an edit brings back a deleted document, and says so', async () => {
        // ADR 0039 §4. Before this, a vanished file cancelled autosave and the unsaved edits
        // were silently discarded — a bug that predates delete.
        const resurrected: string[] = []
        const adapter: DirectoryAdapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await adapter.ensureSkeleton()
        await adapter.write('pages', 'Physics.md', '---\ntitle: Physics\n---\n- original')
        const store = createFilesystemDocumentStore(adapter, {
            autosaveMs: 1,
            onResurrected: (c) => resurrected.push(c),
        })
        await store.scan()

        const doc = store.open('Physics')
        await new Promise((r) => setTimeout(r, 20)) // let the buffer hydrate
        await store.deleteDocument('Physics')
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)

        doc.applyChange({ from: 0, to: 0, insert: 'still writing ' })
        await new Promise((r) => setTimeout(r, 60)) // autosave

        expect(resurrected).toEqual(['Physics'])
        expect(await adapter.exists('pages', 'Physics.md')).toBe(true)
        expect((await adapter.read('pages', 'Physics.md')).text).toContain('still writing')
        // And the graph lists it again.
        expect(store.listDocuments().map((d) => d.concept)).toContain('Physics')
    })
})

describe('renamePage — a Protected Document never merges (ADR 0062)', () => {
    const FENCE = '```etherpk-cipher\nAQQAAAGZaLmAAGZha2UtZW52ZWxvcGU\n```'
    const protectedPage = (title: string) => page(title, FENCE)

    it('refuses a rename onto a protected page and leaves both files untouched', async () => {
        const { adapter, store } = await graph([page('Notes', '- notes'), protectedPage('Vault')])

        const plan = await store.planRename('Notes', 'Vault', 0)
        expect(plan.refusal).toContain('“Vault” is a protected document')
        await expect(store.renamePage('Notes', 'Vault', { strategy: 'alias' })).rejects.toThrow(/protected document/)

        expect((await adapter.read('pages', 'Vault.md')).text).toBe(`---\ntitle: Vault\n---\n${FENCE}`)
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('- notes')
    })

    it('refuses a protected page being renamed onto a taken name', async () => {
        const { adapter, store } = await graph([page('Notes', '- notes'), protectedPage('Vault')])

        await expect(store.renamePage('Vault', 'Notes', { strategy: 'alias' })).rejects.toThrow(/“Vault” is a protected document/)

        expect((await adapter.read('pages', 'Vault.md')).text).toContain('etherpk-cipher')
        expect((await adapter.read('pages', 'Notes.md')).text).not.toContain('etherpk-cipher')
    })

    it('refuses a cascade whose collision would merge a protected page', async () => {
        const { store } = await graph([
            page('Physics'),
            protectedPage('[[Physics]] Quantum'),
            page('[[Chemistry]] Quantum', '- chemistry quantum'),
        ])

        await expect(store.renamePage('Physics', 'Chemistry', { strategy: 'alias' })).rejects.toThrow(/protected document/)
        expect(store.listDocuments().map((d) => d.concept)).toContain('[[Physics]] Quantum')
    })

    it('still renames a protected page onto a free name', async () => {
        const { adapter, store } = await graph([protectedPage('Vault')])

        const result = await store.renamePage('Vault', 'Safe', { strategy: 'alias' })

        expect(result.merged).toBe(0)
        expect((await adapter.read('pages', 'Safe.md')).text).toContain(FENCE)
    })
})

/**
 * A [[Pageless Concept]] renames by rewriting its links (ADR 0064). There is no file to move,
 * no alias to add, and no document to merge - only the body pass.
 */
describe('renamePage — a pageless concept', () => {
    it('plans without refusing when no document exists', async () => {
        const { store } = await graph([page('Notes', '- see [[Physcis]]')])
        const plan = await store.planRename('Physcis', 'Physics')
        expect(plan.refusal).toBeNull()
        expect(plan.direct).toMatchObject({ hasDocument: false, merges: false, redirects: false })
        expect(plan.referencingDocuments).toBe(1)
    })

    it('rewrites every link, at any depth, and creates no file', async () => {
        const { adapter, store } = await graph([
            page('Notes', '- see [[Physcis]]'),
            page('Diary', '- and [[[[Physcis]] Quantum]]'),
            page('Unrelated', '- nothing'),
        ])

        const result = await store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result).toEqual({ concept: 'Physics', rewritten: 2, rewrittenDocuments: expect.arrayContaining(['Notes', 'Diary']), cascaded: 0, merged: 0 })
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('[[Physics]]')
        expect((await adapter.read('pages', 'Diary.md')).text).toContain('[[[[Physics]] Quantum]]')
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
        expect(await adapter.exists('pages', 'Physcis.md')).toBe(false)
        expect(store.listDocuments().map((d) => d.concept)).not.toContain('Physics')
    })

    it('redirects its links onto a page that already has the new name, joining nothing', async () => {
        const { adapter, store } = await graph([page('Physics', '- real'), page('Notes', '- see [[Physcis]]')])

        const plan = await store.planRename('Physcis', 'Physics')
        expect(plan.direct).toMatchObject({ merges: false, redirects: true })

        const result = await store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result.merged).toBe(0)
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('[[Physics]]')
        // The page that had the name is untouched.
        expect((await adapter.read('pages', 'Physics.md')).text).toContain('- real')
    })

    it('carries documented scoped concepts beneath it through the cascade', async () => {
        const { adapter, store } = await graph([
            page('[[Physcis]] Quantum', '- q'),
            page('Notes', '- see [[Physcis]] and [[[[Physcis]] Quantum]]'),
        ])

        const result = await store.renamePage('Physcis', 'Physics', { strategy: 'rewrite' })

        expect(result.cascaded).toBe(1)
        expect(store.listDocuments().map((d) => d.concept)).toContain('[[Physics]] Quantum')
        expect(await adapter.exists('pages', 'Physics.md')).toBe(false)
        expect((await adapter.read('pages', 'Notes.md')).text).toBe(
            '---\ntitle: Notes\n---\n- see [[Physics]] and [[[[Physics]] Quantum]]',
        )
    })

    it('does nothing at all when nothing links to it', async () => {
        const { adapter, store } = await graph([page('Notes', '- nothing')])
        const result = await store.renamePage('Nobody', 'Somebody', { strategy: 'rewrite' })
        expect(result).toEqual({ concept: 'Somebody', rewritten: 0, rewrittenDocuments: [], cascaded: 0, merged: 0 })
        expect((await adapter.read('pages', 'Notes.md')).text).toContain('- nothing')
        expect(store.listDocuments()).toHaveLength(1)
    })

    it('refuses a journal-shaped concept that has no entry', async () => {
        const { store } = await graph([page('Notes', '- see [[2026-09-13]]')])
        const plan = await store.planRename('2026-09-13', 'Launch Day')
        expect(plan.refusal).toContain('journal entry')
        await expect(store.renamePage('2026-09-13', 'Launch Day', { strategy: 'rewrite' })).rejects.toThrow('journal')
    })
})

/**
 * A rewrite reaches an OPEN document through its buffer, as per-occurrence external changes
 * (ADR 0066) - never by writing the file underneath a buffer that will autosave over it.
 */
describe('renamePage — rewrite through an open buffer', () => {
    it('rewrites the open buffer, tells its editor, and keeps the user\'s unsaved edit', async () => {
        const { adapter, store } = await graph([page('Physics'), page('Notes', '- see [[Physics]] here')])
        const notes = store.open('Notes')
        await (store as { flushDocument?: (t: string) => Promise<void> }).flushDocument?.('Notes')
        // The user has typed, and the autosave has not fired: the buffer is ahead of the file.
        notes.applyChange({ from: notes.getText().length, to: notes.getText().length, insert: '\n- typed' })
        const seen: string[] = []
        notes.subscribe((text) => seen.push(text))

        const result = await store.renamePage('Physics', 'Physical Science', { strategy: 'rewrite' })

        expect(result.rewritten).toBe(1)
        const expected = '---\ntitle: Notes\n---\n- see [[Physical Science]] here\n- typed'
        expect(notes.getText()).toBe(expected)
        // The editor showing the buffer was told, with the rewritten text.
        expect(seen.at(-1)).toBe(expected)
        // And what lands on disk is the rewrite AND the edit - neither clobbers the other.
        await (store as { flushDocument?: (t: string) => Promise<void> }).flushDocument?.('Notes')
        expect((await adapter.read('pages', 'Notes.md')).text).toBe(expected)
    })
})

/**
 * Renaming onto a name another page answers to by ALIAS merges into that page under its own
 * title (ADR 0038 §4). Before this, a second file titled with the alias was written and
 * orphaned: links kept resolving to the alias holder, and the new content was unreachable.
 */
describe('renamePage — onto another page\'s alias', () => {
    const aliased = {
        subdir: 'pages' as const,
        name: 'Agentic Software Development.md',
        text: '---\ntitle: Agentic Software Development\naliases:\n  - Agent Accelerated Development\n---\n- agentic',
    }

    it('merges into the alias holder, which keeps its title and gains the old name as an alias', async () => {
        const { adapter, store } = await graph([aliased, page('Vibe Coding', '- vibe')])

        const plan = await store.planRename('Vibe Coding', 'Agent Accelerated Development')
        expect(plan.direct).toMatchObject({ merges: true, into: 'Agentic Software Development' })

        const result = await store.renamePage('Vibe Coding', 'Agent Accelerated Development', { strategy: 'alias' })

        expect(result.concept).toBe('Agentic Software Development')
        expect(result.merged).toBe(1)
        const concepts = store.listDocuments().map((d) => d.concept)
        expect(concepts).toEqual(['Agentic Software Development'])
        const { text } = await adapter.read('pages', 'Agentic Software Development.md')
        expect(text).toContain('title: Agentic Software Development')
        expect(text).toContain('- agentic')
        expect(text).toContain('- vibe')
        expect(text).toContain('Agent Accelerated Development')
        expect(text).toContain('Vibe Coding')
        expect(await adapter.exists('pages', 'Vibe Coding.md')).toBe(false)
        expect(await adapter.exists('pages', 'Agent Accelerated Development.md')).toBe(false)
    })

    it('renaming a page onto one of its own aliases retitles it and drops the alias', async () => {
        const { adapter, store } = await graph([aliased])
        const result = await store.renamePage('Agentic Software Development', 'Agent Accelerated Development', { strategy: 'alias' })
        expect(result).toMatchObject({ concept: 'Agent Accelerated Development', merged: 0 })
        const { text } = await adapter.read('pages', 'Agent Accelerated Development.md')
        expect(text).toContain('title: Agent Accelerated Development')
        // The old title is now the alias; the new title is no longer listed as one.
        expect(text.match(/Agent Accelerated Development/g)?.length).toBe(1)
        expect(text).toContain('- Agentic Software Development')
    })
})
