import { describe, expect, it } from 'vitest'

import { convertSource } from './convert'
import { convertEtherpk } from './etherpk'
import { buildReportPage } from './report'
import type { SourceFile } from './types'
import { graphThemeFileText } from '$lib/storage/fs/theme-files'
import type { ProtectionRecord } from '$lib/crypto'

const RECORD: ProtectionRecord = {
    v: 1,
    fingerprint: 'ZmluZ2VycHJpbnQ',
    kdf: { m: 8192, t: 1, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA' },
    wrapped: 'd3JhcHBlZA',
}

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

describe('convertEtherpk', () => {
    it('copies journals, pages, and assets verbatim, carrying Graph Settings', async () => {
        const pageText = '---\ntitle: My Page\n---\nsee ![shot](../assets/shot.a1b2c3d4.png)'
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('pages/My Page.md', pageText),
            src('assets/shot.a1b2c3d4.png', new Uint8Array([1, 2])),
            src('etherpk/settings.json', '{"defaultCodeLanguage": "ts"}'),
        ])
        expect(graph.documents).toHaveLength(2)
        const journal = graph.documents.find((d) => d.kind === 'journal')
        expect(journal).toMatchObject({ concept: '2026-07-16', fileName: '2026-07-16.md', text: '- today' })
        const page = graph.documents.find((d) => d.kind === 'page')
        expect(page).toMatchObject({ concept: 'My Page', fileName: 'My Page.md', text: pageText })
        expect(graph.assets).toHaveLength(1)
        expect(graph.assets[0].fileName).toBe('shot.a1b2c3d4.png')
        expect(graph.assets[0].unreferenced).toBe(false)
        expect(graph.settings).toEqual({ defaultCodeLanguage: 'ts' })
        expect(graph.report).toHaveLength(0)
    })

    it('carries Quick Notes from etherpk/quick-notes.json, sanitised, and reports a malformed file', async () => {
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('etherpk/quick-notes.json', '[{"id":"a","text":" keep ","createdAt":1},{"id":"b"}]'),
        ])
        expect(graph.quickNotes).toEqual([{ id: 'a', text: 'keep', createdAt: 1 }])
        expect(graph.report).toHaveLength(0)

        const bad = await convertEtherpk([src('journals/2026-07-16.md', '- today'), src('etherpk/quick-notes.json', '{oops')])
        expect(bad.quickNotes).toBeUndefined()
        expect(bad.report.map((r) => r.detail)).toContainEqual(expect.stringContaining('quick-notes.json is malformed'))
    })

    it('carries the Graph Dictionary from etherpk/dictionary.txt, skipping lines that are not one word', async () => {
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('etherpk/dictionary.txt', 'Kubernetes\nsidney\ntwo words\n\n'),
        ])
        expect(graph.spellingDictionary).toEqual(['Kubernetes', 'sidney'])
        expect(graph.report).toHaveLength(0)

        const none = await convertEtherpk([src('journals/2026-07-16.md', '- today')])
        expect(none.spellingDictionary).toBeUndefined()
    })

    it('carries themes from etherpk/theme-<id>.jsonc, comment header and all, and reports a broken one', async () => {
        const theme = { id: 'mine', name: 'Mine', files: { 'theme.json': '{"name":"mine","contract":1}', 'assets/theme.css': 'a { color: red } /* keep */' } }
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('etherpk/theme-mine.jsonc', graphThemeFileText(theme)),
            src('etherpk/theme-broken.jsonc', '// header\n{'),
            src('etherpk/theme-old.json', JSON.stringify({ ...theme, id: 'old' })),
        ])
        expect(graph.themes).toEqual([theme])
        expect(graph.report.map((r) => r.detail)).toContainEqual(expect.stringContaining('theme-broken.jsonc is malformed'))
        // The pre-.jsonc spelling is not read: no compatibility alias before production.
        expect(graph.report.map((r) => r.detail)).not.toContainEqual(expect.stringContaining('theme-old'))
    })

    it('reports stray markdown and unreferenced assets', async () => {
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('pages/Foo.md', 'body'),
            src('README.md', 'stray'),
            src('assets/orphan.bin', new Uint8Array([9])),
        ])
        expect(graph.documents.find((d) => d.concept === 'README')?.kind).toBe('page')
        expect(graph.report.some((r) => r.category === 'rename' && r.detail.includes('README'))).toBe(true)
        expect(graph.report.some((r) => r.category === 'unreferenced')).toBe(true)
    })

    it('skips the root AGENTS.md and CLAUDE.md rather than importing them as pages', async () => {
        // The Filesystem Backend writes both into every graph folder it opens (fs/agents-md.ts);
        // the destination graph gets its own on its first open, so importing these would only
        // plant pages called "AGENTS" and "CLAUDE" carrying a stale copy of the app's instructions.
        const graph = await convertEtherpk([
            src('journals/2026-07-16.md', '- today'),
            src('AGENTS.md', '# House rules\n\n<!-- BEGIN ETHERPK -->\nmanaged\n<!-- END ETHERPK -->\n'),
            src('CLAUDE.md', '<!-- BEGIN ETHERPK -->\n@AGENTS.md\n<!-- END ETHERPK -->\n'),
            src('pages/AGENTS.md', '---\ntitle: AGENTS\n---\nan actual page with that name'),
        ])
        expect(graph.documents.map((d) => d.concept).sort()).toEqual(['2026-07-16', 'AGENTS'])
        expect(graph.documents.find((d) => d.concept === 'AGENTS')?.text).toContain('an actual page')
        expect(graph.report).toHaveLength(0)
    })

    // A [[Local Mirror]] writes a suffixed file when the graph holds two documents with one
    // identity, so a folder can arrive here with both. Losing one silently is what this stops.
    describe('collisions', () => {
        it('keeps both documents when two files claim one title', async () => {
            const graph = await convertEtherpk([
                src('pages/Foo.md', '---\ntitle: Foo\n---\nfirst'),
                src('pages/Foo (2).md', '---\ntitle: Foo\n---\nsecond'),
            ])
            expect(graph.documents.map((d) => d.concept).sort()).toEqual(['Foo', 'Foo (2)'])
            // The rename is real, so the renamed file says so. A Filesystem Backend reads
            // identity out of the text and nowhere else, and would otherwise put both documents
            // back under one concept and shadow one of them.
            expect(graph.documents.map((d) => d.text).sort()).toEqual(
                ['---\ntitle: Foo\n---\nfirst', '---\ntitle: Foo (2)\n---\nsecond'].sort(),
            )
            expect(graph.report.some((r) => r.category === 'collision' && r.detail.includes('already exists'))).toBe(true)
        })

        it('imports a journals/ file not named after a calendar day as a page', async () => {
            const graph = await convertEtherpk([
                src('journals/2026-09-09.md', '- first'),
                src('journals/2026-09-09 (2).md', '---\ntitle: 2026-09-09\n---\n- second'),
            ])
            const journal = graph.documents.find((d) => d.kind === 'journal')
            expect(journal).toMatchObject({ concept: '2026-09-09', text: '- first' })
            // The day is a Journal Entry's whole identity, so the second cannot also be one.
            const page = graph.documents.find((d) => d.kind === 'page')
            expect(page).toMatchObject({ concept: '2026-09-09 (2)', fileName: '2026-09-09 (2).md' })
            expect(graph.report.some((r) => r.detail.includes('not named after a calendar day'))).toBe(true)
        })

        it('gives a page its own file name when another document already took it', async () => {
            // Two different concepts whose on-disk names are the same: the second keeps its
            // title and only its file name moves.
            const graph = await convertEtherpk([
                src('pages/A_B.md', '---\ntitle: A/B\n---\nslashed'),
                src('pages/A_B (2).md', '---\ntitle: A_B\n---\nunderscored'),
            ])
            expect(graph.documents.map((d) => d.concept).sort()).toEqual(['A/B', 'A_B'])
            expect(graph.documents.map((d) => d.fileName).sort()).toEqual(['A_B (2).md', 'A_B.md'])
            expect(graph.report).toHaveLength(0)
        })

        it('leaves a folder with no collisions completely unreported', async () => {
            const graph = await convertEtherpk([
                src('journals/2026-09-09.md', '- today'),
                src('pages/Alpha.md', '---\ntitle: Alpha\n---\nbody'),
            ])
            expect(graph.report).toEqual([])
        })
    })
})

describe('convertSource + buildReportPage', () => {
    it('builds an Import Report page with sections and document wikilinks', async () => {
        const graph = await convertSource(
            [
                src('pages/a.md', '- {{query x}}'),
                src('journals/2026_07_16.md', '- hi'),
                src('logseq/config.edn', ''),
            ],
            'logseq',
        )
        const reportPage = buildReportPage(graph, 'logseq', '2026-07-16')
        expect(reportPage.concept).toBe('Import Report 2026-07-16')
        expect(reportPage.kind).toBe('page')
        expect(reportPage.text).toContain('from a Logseq source on 2026-07-16')
        expect(reportPage.text).toContain('## Unsupported constructs')
        expect(reportPage.text).toContain('- [[a]]:')
    })

    it('reports a clean import as clean', async () => {
        const graph = await convertSource([src('pages/a.md', 'plain')], 'etherpk')
        const reportPage = buildReportPage(graph, 'etherpk', '2026-07-16')
        expect(reportPage.text).toContain('converted cleanly')
    })
})

describe('protected content', () => {
    it('passes a protected document through byte-for-byte', async () => {
        const text = ['---', 'title: Router', '---', '```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')

        const graph = await convertEtherpk([src('pages/Router.md', text)])

        expect(graph.documents.find((d) => d.concept === 'Router')?.text).toBe(text)
    })

    // The incoming graph's Protection Key is not this graph's, so the content arrives permanently
    // unreadable. Saying nothing would leave the user to discover it against a page that just
    // looks broken.
    it('reports it as unreadable rather than importing it silently', async () => {
        const text = ['```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')

        const graph = await convertEtherpk([src('pages/Router.md', text)])

        const entry = graph.report.find((r) => r.concept === 'Router')
        expect(entry?.category).toBe('unsupported')
        expect(entry?.detail).toContain('passphrase')
    })

    it('carries the protection record, and says the passphrase it had opens the documents (ADR 0093)', async () => {
        const text = ['```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')

        const graph = await convertEtherpk([src('pages/Router.md', text), src('etherpk/protection.json', JSON.stringify(RECORD))])

        expect(graph.protection).toEqual(RECORD)
        const entry = graph.report.find((r) => r.concept === 'Router')
        expect(entry?.detail).toContain('protection record')
        expect(entry?.detail).not.toContain('will not open it')
    })

    it('reports a record it cannot read and leaves the documents unreadable rather than inventing a key', async () => {
        const text = ['```etherpk-cipher', 'AQQAAAGZaLmAAGZha2U', '```'].join('\n')

        const graph = await convertEtherpk([src('pages/Router.md', text), src('etherpk/protection.json', '{"v":1}')])

        expect(graph.protection).toBeUndefined()
        expect(graph.report.map((r) => r.detail)).toContainEqual(expect.stringContaining('protection.json is malformed'))
        expect(graph.report.find((r) => r.concept === 'Router')?.detail).toContain('will not open it')
    })

    it('says nothing about a document with no protected content', async () => {
        const graph = await convertEtherpk([src('pages/Notes.md', '# Notes\n\nnothing secret here')])

        expect(graph.report).toEqual([])
    })
})
