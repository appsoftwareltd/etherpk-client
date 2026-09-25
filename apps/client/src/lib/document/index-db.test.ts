import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    beginIndexRebuild,
    backlinksFor,
    commitIndexRebuild,
    conceptCandidates,
    conceptCandidatesForKeys,
    conceptExists,
    createSchema,
    existingConceptKeys,
    type IndexDoc,
    indexDocumentFactKeys,
    indexedDocumentFacts,
    ingest,
    ingestOne,
    ingestIndexRebuildChunk,
    referencedInBody,
    type SqlDb,
} from './index-db'
import { wrapOo1Db } from './index-db-sqlite'

// The SQLite query layer, exercised against a real in-memory sqlite-wasm DB in node
// (ADR 0015 — OPFS/worker persistence is browser-only, covered by Playwright).

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule()
})

function freshDb(): SqlDb {
    const db = wrapOo1Db(new sqlite3.oo1.DB(':memory:'))
    createSchema(db)
    return db
}

function countDeleteStatements(delegate: SqlDb): { db: SqlDb; count: () => number } {
    let deleteStatements = 0
    const record = (sql: string) => {
        deleteStatements += sql.match(/\bDELETE\b/giu)?.length ?? 0
    }

    return {
        db: {
            exec(sql) {
                record(sql)
                delegate.exec(sql)
            },
            run(sql, params) {
                record(sql)
                delegate.run(sql, params)
            },
            all<T>(sql: string, params?: unknown[]) {
                return delegate.all<T>(sql, params)
            },
            close() {
                delegate.close()
            },
        },
        count: () => deleteStatements,
    }
}

const docs: IndexDoc[] = [
    { concept: 'Project', kind: 'page', aliases: ['Proj'], text: '# Project\nthe project page' },
    {
        concept: '2026-06-25',
        kind: 'journal',
        aliases: [],
        text: '## Tasks\n- work on [[Project]]\n  - a sub note about [[Detail]]',
    },
    { concept: '2026-06-24', kind: 'journal', aliases: [], text: '- mentioned [[Proj]] by alias' },
]

describe('SQLite adapter', () => {
    it('closes its underlying oo1 handle at most once', () => {
        let closes = 0
        const db = wrapOo1Db({
            exec() {},
            close() {
                closes++
            },
        })

        db.close()
        db.close()

        expect(closes).toBe(1)
    })
})

describe('index-db', () => {
    let db: SqlDb
    beforeEach(() => {
        db = freshDb()
        ingest(db, docs)
    })

    it('records existence (case-insensitive, incl. aliases)', () => {
        expect(conceptExists(db, 'Project')).toBe(true)
        expect(conceptExists(db, 'project')).toBe(true)
        expect(conceptExists(db, 'Proj')).toBe(true)
        expect(conceptExists(db, 'Nope')).toBe(false)
        expect(existingConceptKeys(db)).toEqual(expect.arrayContaining(['project', 'proj']))
    })

    it('pools backlinks across the concept and its aliases', () => {
        const groups = backlinksFor(db, 'Project')
        const sources = groups.map((g) => g.sourceConcept).sort()
        expect(sources).toEqual(['2026-06-24', '2026-06-25'])
    })

    it('orders journals newest-first', () => {
        const groups = backlinksFor(db, 'Project')
        expect(groups.map((g) => g.sourceConcept)).toEqual(['2026-06-25', '2026-06-24'])
    })

    it('renders a block reference as a subtree with an ancestor breadcrumb', () => {
        const groups = backlinksFor(db, 'Project')
        const ref = groups.find((g) => g.sourceConcept === '2026-06-25')!.refs[0]
        expect(ref.kind).toBe('block')
        expect(ref.breadcrumb).toEqual(['Tasks']) // ancestors only (the heading)
        // The matched block plus its descendant ("a sub note about [[Detail]]").
        expect(ref.subtree).toEqual([
            { text: 'work on [[Project]]', depth: 0, isMatch: true },
            { text: 'a sub note about [[Detail]]', depth: 1, isMatch: false },
        ])
    })

    it('says which nodes of a quoted subtree are tasks, and whether each is done', () => {
        ingest(db, [
            { concept: 'Chores', kind: 'page', aliases: [], text: '' },
            { concept: 'Todo', kind: 'page', aliases: [], text: ['- [ ] #P1 tidy [[Chores]]', '  - [x] bins', '  - note'].join('\n') },
        ])
        const ref = backlinksFor(db, 'Chores').find((g) => g.sourceConcept === 'Todo')!.refs[0]
        expect(ref.subtree).toEqual([
            { text: '#P1 tidy [[Chores]]', depth: 0, isMatch: true, done: false },
            { text: 'bins', depth: 1, isMatch: false, done: true },
            { text: 'note', depth: 1, isMatch: false },
        ])
    })

    it('quotes a block whole: its continuation lines and fenced code, the code’s indentation kept', () => {
        ingest(db, [
            { concept: 'Code', kind: 'page', aliases: [], text: '' },
            {
                concept: 'Snippets',
                kind: 'page',
                aliases: [],
                text: ['- see [[Code]]', '  like this:', '  ```ts', '  if (a) {', '', '      b()', '  }', '  ```', '  - ```sh', '    # a comment', '    ```'].join('\n'),
            },
        ])
        const ref = backlinksFor(db, 'Code').find((g) => g.sourceConcept === 'Snippets')!.refs[0]
        expect(ref.subtree).toEqual([
            { text: 'see [[Code]]\nlike this:\n```ts\nif (a) {\n\n    b()\n}\n```', depth: 0, isMatch: true },
            { text: '```sh\n# a comment\n```', depth: 1, isMatch: false },
        ])
    })

    it('renders a prose reference with the heading tree + surrounding text', () => {
        ingest(db, [
            { concept: 'Topic', kind: 'page', aliases: [], text: '' },
            { concept: 'P', kind: 'page', aliases: [], text: '# [[Head]]\n\nsee [[Topic]] in context' },
        ])
        const ref = backlinksFor(db, 'Topic').find((g) => g.sourceConcept === 'P')!.refs[0]
        expect(ref.kind).toBe('prose')
        expect(ref.breadcrumb).toEqual(['[[Head]]']) // the heading tree
        expect(ref.context?.text).toBe('see [[Topic]] in context')
        expect(ref.context?.text.slice(ref.context.matchStart, ref.context.matchEnd)).toBe('[[Topic]]')
    })

    it('truncates a long prose paragraph to ~1000 chars centred on the match', () => {
        const filler = 'x'.repeat(2000)
        ingest(db, [
            { concept: 'Mid', kind: 'page', aliases: [], text: '' },
            { concept: 'Long', kind: 'page', aliases: [], text: `${filler} [[Mid]] ${filler}` },
        ])
        const ctx = backlinksFor(db, 'Mid').find((g) => g.sourceConcept === 'Long')!.refs[0].context!
        expect(ctx.truncated).toBe(true)
        expect(ctx.text.length).toBeLessThanOrEqual(1002) // 1000 + two ellipses
        expect(ctx.text.slice(ctx.matchStart, ctx.matchEnd)).toBe('[[Mid]]')
    })

    it('starts a long prose excerpt at a fence rather than inside it, the ellipsis on a line of its own', () => {
        const code = Array.from({ length: 80 }, (_, n) => `const line${n} = ${n}`).join('\n')
        ingest(db, [
            { concept: 'After', kind: 'page', aliases: [], text: '' },
            { concept: 'Tail', kind: 'page', aliases: [], text: `intro\n\`\`\`ts\n${code}\n\`\`\`\nsee [[After]]` },
        ])
        const ctx = backlinksFor(db, 'After').find((g) => g.sourceConcept === 'Tail')!.refs[0].context!
        // The window would start inside the code; it starts at the opener instead, below an ellipsis.
        expect(ctx.text.startsWith('…\n```ts\nconst line0 = 0\n')).toBe(true)
        expect(ctx.text.endsWith('```\nsee [[After]]')).toBe(true)
        expect(ctx.truncated).toBe(true)
        expect(ctx.text.slice(ctx.matchStart, ctx.matchEnd)).toBe('[[After]]')
    })

    it('never cuts a long prose paragraph inside a fenced code block', () => {
        const code = Array.from({ length: 80 }, (_, n) => `const line${n} = ${n}`).join('\n')
        const filler = 'x'.repeat(2000)
        ingest(db, [
            { concept: 'Fenced', kind: 'page', aliases: [], text: '' },
            { concept: 'Guide', kind: 'page', aliases: [], text: `see [[Fenced]]:\n\`\`\`ts\n${code}\n\`\`\`\n${filler}` },
        ])
        const ctx = backlinksFor(db, 'Fenced').find((g) => g.sourceConcept === 'Guide')!.refs[0].context!
        // The window would end inside the code; it is widened to the closing fence instead.
        expect(ctx.text.startsWith('see [[Fenced]]:\n```ts\n')).toBe(true)
        expect(ctx.text).toContain(`${code}\n\`\`\``)
        expect(ctx.truncated).toBe(true)
        expect(ctx.text.endsWith('…')).toBe(true)
        expect(ctx.text.slice(ctx.matchStart, ctx.matchEnd)).toBe('[[Fenced]]')
    })

    it('reconstructs full chains through SQLite for the user test case', () => {
        const md = [
            '# [[Header 1]]',
            '',
            'Test',
            '',
            '## [[Header 2]]',
            '',
            '### [[Header 3]]',
            '',
            '[[Concern 2]]',
            '',
            '- Test',
            '  - Test yjis **out**',
            '    - [[Concern 1]]',
            '      - [[Concern 2]]',
        ].join('\n')
        const d = freshDb()
        ingest(d, [
            { concept: 'Concern 2', kind: 'page', aliases: [], text: '' },
            { concept: '2026-06-20', kind: 'journal', aliases: [], text: md },
        ])
        const groups = backlinksFor(d, 'Concern 2')
        const refs = groups.find((g) => g.sourceConcept === '2026-06-20')!.refs
        expect(refs).toHaveLength(2)
        // The standalone [[Concern 2]] is prose under three headings.
        expect(refs[0].kind).toBe('prose')
        expect(refs[0].breadcrumb).toEqual(['[[Header 1]]', '[[Header 2]]', '[[Header 3]]'])
        // The deeply-nested [[Concern 2]] is a block; its breadcrumb is the full ancestry.
        expect(refs[1].kind).toBe('block')
        expect(refs[1].breadcrumb).toEqual([
            '[[Header 1]]',
            '[[Header 2]]',
            '[[Header 3]]',
            'Test',
            'Test yjis **out**',
            '[[Concern 1]]',
        ])
        expect(refs[1].subtree).toEqual([{ text: '[[Concern 2]]', depth: 0, isMatch: true }])
    })

    it('is rebuildable — re-ingesting replaces the contents', () => {
        ingest(db, [{ concept: 'Solo', kind: 'page', aliases: [], text: 'nothing links here' }])
        expect(conceptExists(db, 'Project')).toBe(false)
        expect(conceptExists(db, 'Solo')).toBe(true)
        expect(backlinksFor(db, 'Project')).toEqual([])
    })

    it('reclaims an obsolete generation with a bounded number of set-based deletes', () => {
        const obsolete = Array.from({ length: 250 }, (_, index): IndexDoc => ({
            concept: `Obsolete ${index}`,
            kind: 'page',
            aliases: [`Old ${index}`],
            text: `- TODO retire [[Target ${index}]]`,
        }))
        ingest(db, obsolete)

        const generation = beginIndexRebuild(db)
        ingestIndexRebuildChunk(db, generation, [
            { concept: 'Current', kind: 'page', aliases: [], text: '- retained' },
        ])

        const measured = countDeleteStatements(db)
        commitIndexRebuild(measured.db, generation)

        // Generation cleanup has one relation-sized job per derived table — eight of them
        // (aliases, publication_includes, blocks, links, tasks, task_concepts, passages,
        // block_fts) plus pages. Its SQL work must not grow into a DELETE per page in a large graph.
        expect(measured.count()).toBeLessThanOrEqual(9)
        expect(
            db.all<{ count: number }>(
                'SELECT COUNT(*) AS count FROM pages WHERE generation <> ?',
                [generation],
            )[0]?.count,
        ).toBe(0)
        expect(
            db.all<{ count: number }>(
                `SELECT COUNT(*) AS count
                 FROM aliases
                 LEFT JOIN pages ON pages.id = aliases.page_id
                 WHERE pages.id IS NULL`,
            )[0]?.count,
        ).toBe(0)
    })

    describe('title references (ADR 0083)', () => {
        // A [[Scoped Concept]]'s name contains its [[Scope]]'s name, so the page named
        // `[[Dev Doc]] file name` references Dev Doc by existing - a file copied into `pages/`
        // with that name must surface Dev Doc without any body mentioning it.
        const scoped: IndexDoc = { concept: '[[Dev Doc]] file name', kind: 'page', aliases: [], text: 'Just prose.' }

        it('makes the scope a pageless concept, counted as one reference', () => {
            ingest(db, [scoped])
            expect(conceptCandidates(db).find((c) => c.key === 'dev doc')).toEqual({
                display: 'Dev Doc',
                key: 'dev doc',
                kind: 'pageless',
                references: 1,
            })
        })

        it('lists the scoped page among the scope\'s backlinks, as a title reference', () => {
            ingest(db, [scoped])
            const groups = backlinksFor(db, 'Dev Doc')
            expect(groups.map((g) => g.sourceConcept)).toEqual(['[[Dev Doc]] file name'])
            expect(groups[0].refs).toEqual([
                {
                    sourceConcept: '[[Dev Doc]] file name',
                    sourceKind: 'page',
                    line: 0,
                    kind: 'title',
                    breadcrumb: [],
                    subtree: [],
                    context: { text: '[[Dev Doc]] file name', matchStart: 0, matchEnd: 11, truncated: false },
                },
            ])
        })

        it('references every nesting level of the title', () => {
            ingest(db, [{ concept: '[[[[Physics]] Quantum]] Field Theory', kind: 'page', aliases: [], text: '' }])
            expect(backlinksFor(db, 'Physics').map((g) => g.sourceConcept)).toEqual(['[[[[Physics]] Quantum]] Field Theory'])
            expect(backlinksFor(db, '[[Physics]] Quantum').map((g) => g.sourceConcept)).toEqual(['[[[[Physics]] Quantum]] Field Theory'])
            const pageless = conceptCandidates(db).filter((c) => c.kind === 'pageless').map((c) => c.display)
            expect(pageless.sort()).toEqual(['Physics', '[[Physics]] Quantum'].sort())
        })

        it('pools a title reference through the scope\'s aliases and casing, like any link', () => {
            ingest(db, [
                { concept: 'Physics', kind: 'page', aliases: ['Phys'], text: '' },
                { concept: '[[phys]] Quantum', kind: 'page', aliases: [], text: '' },
            ])
            expect(backlinksFor(db, 'Physics').map((g) => g.sourceConcept)).toEqual(['[[phys]] Quantum'])
            // Physics has a page, so it is not offered as pageless however many titles name it.
            expect(conceptCandidates(db).find((c) => c.key === 'physics')?.kind).toBe('page')
        })

        it('puts the title reference before the body\'s references in its group', () => {
            ingest(db, [{ ...scoped, text: 'see [[Dev Doc]] again\n- and [[Dev Doc]] here' }])
            const [group] = backlinksFor(db, 'Dev Doc')
            expect(group.refs.map((r) => r.kind)).toEqual(['title', 'prose', 'block'])
            expect(conceptCandidates(db).find((c) => c.key === 'dev doc')?.references).toBe(3)
        })

        it('does not double the reference when the document is re-ingested', () => {
            ingest(db, [scoped])
            ingestOne(db, scoped)
            ingestOne(db, { ...scoped, text: 'edited' })
            expect(conceptCandidates(db).find((c) => c.key === 'dev doc')?.references).toBe(1)
            expect(backlinksFor(db, 'Dev Doc')[0].refs).toHaveLength(1)
        })

        it('counts the scope among the keys an ingest of the page affects, before and after', () => {
            // The worker diffs these two to decide which candidates a one-document ingest can
            // have changed; without the scope on both sides Quick Find would not learn of it.
            expect(indexDocumentFactKeys(scoped).linkTargets).toEqual(['dev doc'])
            ingest(db, [scoped])
            expect(indexedDocumentFacts(db, 'dev doc').linkTargets).toEqual([])
            expect(indexedDocumentFacts(db, '[[dev doc]] file name').linkTargets).toEqual(['dev doc'])
        })

        it('tells a group that links in its body from one that only names the scope', () => {
            ingest(db, [scoped, { concept: 'Other', kind: 'page', aliases: [], text: '[[Dev Doc]]' }])
            const groups = backlinksFor(db, 'Dev Doc')
            expect(new Map(groups.map((g) => [g.sourceConcept, referencedInBody(g)]))).toEqual(
                new Map([
                    ['Other', true],
                    ['[[Dev Doc]] file name', false],
                ]),
            )
        })
    })

    describe('conceptCandidates', () => {
        it('lists pages, journals, aliases (with canonical), and pageless concepts', () => {
            const byKey = new Map(conceptCandidates(db).map((c) => [c.key, c]))
            expect(byKey.get('project')).toMatchObject({ display: 'Project', kind: 'page' })
            expect(byKey.get('2026-06-25')).toMatchObject({ display: '2026-06-25', kind: 'journal' })
            expect(byKey.get('proj')).toMatchObject({ display: 'Proj', kind: 'alias', canonical: 'Project' })
            // [[Detail]] is referenced by 2026-06-25 but has no page → "Not yet created".
            expect(byKey.get('detail')).toMatchObject({ display: 'Detail', kind: 'pageless' })
        })

        it('flags a page whose stored text holds a cipher fence, and its aliases with it', () => {
            // A Protected Document is frontmatter followed by one fence (ADR 0059). The flag is what
            // lets Search's Names and the Sidebar's rows wear a padlock without opening the document.
            ingest(db, [
                {
                    concept: 'Bank',
                    kind: 'page',
                    aliases: ['Savings'],
                    text: '---\ntitle: Bank\n---\n```etherpk-cipher\nAQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0\n```',
                },
                { concept: 'Open', kind: 'page', aliases: ['Public'], text: 'nothing to hide' },
            ])
            const byKey = new Map(conceptCandidates(db).map((c) => [c.key, c]))
            expect(byKey.get('bank')).toMatchObject({ kind: 'page', protected: true })
            expect(byKey.get('savings')).toMatchObject({ kind: 'alias', canonical: 'Bank', protected: true })
            // Absent, not false: an unprotected candidate's shape is unchanged.
            expect(byKey.get('open')).not.toHaveProperty('protected')
            expect(byKey.get('public')).not.toHaveProperty('protected')

            // A per-document re-ingest follows the text both ways - the same rows the delta reads.
            ingestOne(db, { concept: 'Bank', kind: 'page', aliases: ['Savings'], text: 'unprotected again' })
            expect(conceptCandidatesForKeys(db, ['bank', 'savings']).get('bank')).not.toHaveProperty('protected')
            expect(conceptCandidatesForKeys(db, ['bank', 'savings']).get('savings')).not.toHaveProperty('protected')
            ingestOne(db, { concept: 'Open', kind: 'page', aliases: [], text: '```etherpk-cipher\nAQ==\n```' })
            expect(conceptCandidatesForKeys(db, ['open']).get('open')).toMatchObject({ protected: true })
        })

        it('flags a page a publication names as an include, and its aliases with it', () => {
            // A publication page's `includes:` names snippets (ADR 0082). The flag is what lets a tab
            // wear the "used in a publication" mark without opening anything, exactly as the padlock.
            ingest(db, [
                {
                    concept: 'Docs',
                    kind: 'page',
                    aliases: [],
                    text: 'the publication page',
                    includes: [
                        { publication: 'docs', slot: 'footer', concept: 'Site Footer' },
                        { publication: 'docs', slot: 'head', concept: 'Analytics' },
                    ],
                },
                { concept: 'Site Footer', kind: 'page', aliases: ['Footer'], text: 'the footer' },
                { concept: 'Analytics', kind: 'page', aliases: [], text: 'a script tag' },
                { concept: 'Blog', kind: 'page', aliases: [], text: 'another', includes: [{ publication: 'blog', slot: 'footer', concept: 'footer' }] },
            ])
            const byKey = new Map(conceptCandidates(db).map((c) => [c.key, c]))
            // Named by both publications: once as itself, once through its alias, case-insensitively.
            expect(byKey.get('site footer')).toMatchObject({ kind: 'page', includeOf: ['blog', 'docs'] })
            expect(byKey.get('footer')).toMatchObject({ kind: 'alias', canonical: 'Site Footer', includeOf: ['blog', 'docs'] })
            expect(byKey.get('analytics')).toMatchObject({ includeOf: ['docs'] })
            // Absent, not empty: an ordinary candidate's shape is unchanged.
            expect(byKey.get('docs')).not.toHaveProperty('includeOf')
            expect(byKey.get('analytics')).not.toHaveProperty('protected')

            // The publication page drops a slot: the per-key path the delta reads follows it.
            ingestOne(db, { concept: 'Docs', kind: 'page', aliases: [], text: 'the publication page', includes: [{ publication: 'docs', slot: 'head', concept: 'Analytics' }] })
            expect(conceptCandidatesForKeys(db, ['site footer', 'footer']).get('site footer')).toMatchObject({ includeOf: ['blog'] })
            expect(conceptCandidatesForKeys(db, ['site footer', 'footer']).get('footer')).toMatchObject({ includeOf: ['blog'] })
            ingestOne(db, { concept: 'Blog', kind: 'page', aliases: [], text: 'another' })
            expect(conceptCandidatesForKeys(db, ['site footer']).get('site footer')).not.toHaveProperty('includeOf')
            expect(conceptCandidatesForKeys(db, ['analytics']).get('analytics')).toMatchObject({ includeOf: ['docs'] })
        })

        it('reports include targets among a document\'s facts, so a delta can reach them', () => {
            const doc: IndexDoc = { concept: 'Docs', kind: 'page', aliases: [], text: 'x', includes: [{ publication: 'docs', slot: 'footer', concept: 'Site Footer' }] }
            expect(indexDocumentFactKeys(doc).includeTargets).toEqual(['site footer'])
            ingest(db, [doc])
            expect(indexedDocumentFacts(db, 'docs').includeTargets).toEqual(['site footer'])
        })

        it('omits a concept from the pageless tier once its page (or alias) exists', () => {
            // Project has a page and Proj is its alias — neither should appear as pageless.
            const kinds = new Map(conceptCandidates(db).map((c) => [c.key, c.kind]))
            expect(kinds.get('project')).toBe('page')
            expect(kinds.get('proj')).toBe('alias')
        })

        it('uses case-preserved display but a lowercased key', () => {
            ingest(db, [{ concept: 'Quantum Mechanics', kind: 'page', aliases: [], text: '' }])
            const c = conceptCandidates(db).find((x) => x.key === 'quantum mechanics')!
            expect(c.display).toBe('Quantum Mechanics')
        })

        it('gives a pageless concept the MAJORITY casing of its wikilink instances', () => {
            // A Draft shows this name from the moment it opens and promotes with it, so it
            // decides the page's canonical name (ADR 0050) — an arbitrary pick would leave a
            // page whose title disagrees with most of its own backlinks.
            ingest(db, [
                { concept: 'A', kind: 'page', aliases: [], text: '[[Kanban]]' },
                { concept: 'B', kind: 'page', aliases: [], text: '[[Kanban]]' },
                { concept: 'C', kind: 'page', aliases: [], text: '[[kanban]]' },
            ])
            const c = conceptCandidates(db).find((x) => x.key === 'kanban')!
            expect(c).toMatchObject({ display: 'Kanban', kind: 'pageless', references: 3 })
        })

        it('breaks a casing tie toward the Title-Cased variant', () => {
            ingest(db, [
                { concept: 'D', kind: 'page', aliases: [], text: '[[Zeta]]' },
                { concept: 'E', kind: 'page', aliases: [], text: '[[zeta]]' },
            ])
            expect(conceptCandidates(db).find((x) => x.key === 'zeta')?.display).toBe('Zeta')
        })

        it('counts every occurrence, including repeats within one document', () => {
            ingest(db, [
                { concept: 'F', kind: 'page', aliases: [], text: '[[Widget]] and [[Widget]]' },
                { concept: 'G', kind: 'page', aliases: [], text: '[[Widget]]' },
            ])
            expect(conceptCandidates(db).find((x) => x.key === 'widget')?.references).toBe(3)
        })

        it('carries no reference count once the concept has a page', () => {
            ingest(db, [
                { concept: 'H', kind: 'page', aliases: [], text: '[[Gadget]]' },
                { concept: 'Gadget', kind: 'page', aliases: [], text: '' },
            ])
            const c = conceptCandidates(db).find((x) => x.key === 'gadget')!
            expect(c.kind).toBe('page')
            expect(c.references).toBeUndefined()
        })

        it('includes a real page whose name nests a wikilink (a scoped concept)', () => {
            // Regression: a page named with an inner [[…]] must still be linkable; the
            // "flat names only" restriction applies at render time (nested context), not here.
            ingest(db, [{ concept: 'This is a [[Mini Inside]] new page tab', kind: 'page', aliases: [], text: '' }])
            const c = conceptCandidates(db).find((x) => x.display === 'This is a [[Mini Inside]] new page tab')
            expect(c).toMatchObject({ kind: 'page' })
        })
    })
})
