import { describe, expect, it } from 'vitest'

import { logseqDateToIso, parseLogseqConfig } from './logseq-dates'
import { convertLogseq } from './logseq'
import type { ConvertedGraph, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

function doc(graph: ConvertedGraph, concept: string) {
    const found = graph.documents.find((d) => d.concept === concept)
    if (!found) throw new Error(`no document with concept "${concept}"`)
    return found
}

describe('logseqDateToIso', () => {
    it('parses the default file-name format', () => {
        expect(logseqDateToIso('2026_07_16', 'yyyy_MM_dd')).toBe('2026-07-16')
    })

    it('parses the default page-title format, ordinals included', () => {
        expect(logseqDateToIso('Jul 16th, 2026', 'MMM do, yyyy')).toBe('2026-07-16')
        expect(logseqDateToIso('Mar 1st, 2026', 'MMM do, yyyy')).toBe('2026-03-01')
        expect(logseqDateToIso('December 22nd, 2025', 'MMMM do, yyyy')).toBe('2025-12-22')
    })

    it('rejects non-dates and unknown format tokens', () => {
        expect(logseqDateToIso('Quantum Mechanics', 'MMM do, yyyy')).toBeNull()
        expect(logseqDateToIso('2026_07_16', 'QQ_ww_dd')).toBeNull()
    })

    it('reads formats from config.edn and defaults when absent', () => {
        const config = parseLogseqConfig(':journal/file-name-format "yyyy-MM-dd"\n:journal/page-title-format "EEE, MMM do, yyyy"')
        expect(config.journalFileFormat).toBe('yyyy-MM-dd')
        expect(config.journalTitleFormat).toBe('EEE, MMM do, yyyy')
        expect(parseLogseqConfig(null)).toEqual({
            journalFileFormat: 'yyyy_MM_dd',
            journalTitleFormat: 'MMM do, yyyy',
        })
    })
})

describe('convertLogseq', () => {
    it('renames journals to ISO and rewrites date-page links', async () => {
        const graph = await convertLogseq([
            src('journals/2026_07_16.md', '- met [[Jul 15th, 2026]] notes'),
            src('journals/2026_07_15.md', '- earlier'),
        ])
        const journal = doc(graph, '2026-07-16')
        expect(journal.kind).toBe('journal')
        expect(journal.fileName).toBe('2026-07-16.md')
        expect(journal.text).toContain('[[2026-07-15]]')
        expect(graph.report.some((r) => r.category === 'rename' && r.detail.includes('2026-07-16.md'))).toBe(true)
    })

    it('converts namespace pages and links to scoped concepts', async () => {
        const graph = await convertLogseq([
            src('pages/physics%2Fquantum mechanics.md', '- content'),
            src('pages/other.md', '- see [[physics/quantum mechanics]] and [[a/b/c]]'),
        ])
        const scoped = doc(graph, '[[physics]] quantum mechanics')
        expect(scoped.text).toContain('title: "[[physics]] quantum mechanics"')
        const other = doc(graph, 'other')
        expect(other.text).toContain('[[[[physics]] quantum mechanics]]')
        expect(other.text).toContain('[[[[[[a]] b]] c]]')
    })

    it('moves page properties into frontmatter, aliases included', async () => {
        const graph = await convertLogseq([
            src('pages/foo.md', 'alias:: [[Bar]], Baz\nauthor:: someone\n- first block'),
        ])
        const page = doc(graph, 'foo')
        expect(page.text).toContain('title: foo')
        expect(page.text).toContain('- Bar')
        expect(page.text).toContain('- Baz')
        expect(page.text).toContain('author: someone')
        expect(page.text).toContain('- first block')
        expect(page.text).not.toContain('alias::')
    })

    it('converts task markers, priorities, and continuation dates per ADR 0032', async () => {
        const graph = await convertLogseq([
            src(
                'pages/tasks.md',
                [
                    '- TODO [#A] fix the bug',
                    '  DEADLINE: <2026-03-20 Fri>',
                    '- LATER read the paper',
                    '- NOW [#B] writing it up',
                    '- WAITING on review',
                    '- DONE shipped it',
                    '  :LOGBOOK:',
                    '  * State "DONE" from "TODO" [2026-03-15 Sun 10:23]',
                    '  :END:',
                    '- CANCELLED not doing this',
                    '- TODO plan trip',
                    '  SCHEDULED: <2026-04-01 Wed .+1w>',
                ].join('\n'),
            ),
        ])
        const text = doc(graph, 'tasks').text
        expect(text).toContain('- [ ] #P1 #D-2026-03-20 fix the bug')
        expect(text).toContain('- [ ] read the paper')
        expect(text).toContain('- [ ] #P2 #D writing it up')
        expect(text).toContain('- [ ] #W on review')
        expect(text).toContain('- [x] #C-2026-03-15 shipped it')
        expect(text).toContain('- [x] #C not doing this')
        expect(text).toContain('- [ ] #S-2026-04-01 plan trip')
        expect(text).not.toContain('LOGBOOK')
        expect(text).not.toContain('DEADLINE')
        expect(graph.report.some((r) => r.category === 'drop' && r.detail.includes('LOGBOOK'))).toBe(true)
    })

    it('drops machine-noise properties and normalises tab indentation', async () => {
        const graph = await convertLogseq([
            src(
                'pages/nested.md',
                '- parent\n  id:: 66f1a2b3-c4d5-e6f7-a8b9-c0d1e2f3a4b5\n  collapsed:: true\n\t- child\n\t\t- grandchild',
            ),
        ])
        const text = doc(graph, 'nested').text
        expect(text).not.toContain('id::')
        expect(text).not.toContain('collapsed::')
        expect(text).toContain('\n  - child')
        expect(text).toContain('\n    - grandchild')
    })

    it('inlines block refs with a source link and leaves unresolved ones reported', async () => {
        const uuid = '66f1a2b3-c4d5-e6f7-a8b9-c0d1e2f3a4b5'
        const graph = await convertLogseq([
            src('pages/source.md', `- TODO the canonical statement\n  id:: ${uuid}`),
            src('pages/user.md', `- see ((${uuid})) here\n- dangling ((00000000-0000-0000-0000-000000000000))`),
        ])
        const text = doc(graph, 'user').text
        expect(text).toContain('- see the canonical statement ([[source]]) here')
        expect(text).toContain('((00000000-0000-0000-0000-000000000000))')
        expect(graph.report.some((r) => r.category === 'unresolved')).toBe(true)
    })

    it('degrades embeds, leaves macros as-is, and converts tags to wikilinks', async () => {
        const graph = await convertLogseq([
            src('pages/misc.md', '- {{embed [[Other Page]]}}\n- {{query (todo TODO)}}\n- tagged #physics and #[[quantum things]]'),
        ])
        const text = doc(graph, 'misc').text
        expect(text).toContain('- [[Other Page]]')
        expect(text).toContain('{{query (todo TODO)}}')
        expect(text).toContain('[[physics]] and [[quantum things]]')
        expect(graph.report.some((r) => r.category === 'unsupported' && r.detail.includes('query'))).toBe(true)
    })

    it('rewrites the older ^^highlight^^ spelling to ==, outside code', async () => {
        const graph = await convertLogseq([
            src('pages/marks.md', '- a ^^marked^^ word and `^^literal^^` code\n- already ==done=='),
        ])
        const text = doc(graph, 'marks').text
        expect(text).toContain('- a ==marked== word and `^^literal^^` code')
        expect(text).toContain('- already ==done==')
    })

    it('leaves fence interiors verbatim', async () => {
        const graph = await convertLogseq([
            src('pages/code.md', '- ```js\n  const tag = "#not-a-tag"\n  ```\n- after #real'),
        ])
        const text = doc(graph, 'code').text
        expect(text).toContain('"#not-a-tag"')
        expect(text).toContain('[[real]]')
    })

    it('rewrites asset references to content-hashed names and flags unreferenced assets', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4])
        const graph = await convertLogseq([
            src('assets/my pic.png', bytes),
            src('assets/stray.bin', new Uint8Array([9])),
            src('pages/gallery.md', '- ![shot](../assets/my%20pic.png)'),
        ])
        expect(graph.assets).toHaveLength(2)
        const pic = graph.assets.find((a) => a.fileName.startsWith('my-pic.'))
        expect(pic).toBeDefined()
        expect(pic?.fileName).toMatch(/^my-pic\.[0-9a-f]{8}\.png$/)
        expect(pic?.unreferenced).toBe(false)
        expect(doc(graph, 'gallery').text).toContain(`](../assets/${pic?.fileName})`)
        const stray = graph.assets.find((a) => a.fileName.includes('stray'))
        expect(stray?.unreferenced).toBe(true)
        expect(graph.report.some((r) => r.category === 'unreferenced')).toBe(true)
    })

    it('disambiguates colliding concepts', async () => {
        const graph = await convertLogseq([
            src('journals/2026_07_16.md', '- the journal'),
            src('pages/2026-07-16.md', '- a page named like a date'),
        ])
        expect(doc(graph, '2026-07-16').kind).toBe('journal')
        expect(doc(graph, '2026-07-16 (2)').kind).toBe('page')
        expect(graph.report.some((r) => r.category === 'collision')).toBe(true)
    })
})

/**
 * Logseq image dimensions → the [[Display Size]] hint, the same alt-text form the Obsidian
 * importer already produces. Left unconverted these both showed as literal junk AND stopped
 * the image rendering, because the trailing `{...}` means the image is no longer a bullet's
 * sole content (found on the live drive against a graph carrying 2097 of them).
 */
describe('convertLogseq image dimensions', () => {
    it('converts {:height H, :width W} to a WIDTHxHEIGHT hint - not transposed', async () => {
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot](../assets/pic.png){:height 609, :width 463}'),
        ])
        const text = doc(graph, 'Note').text
        // Logseq writes HEIGHT first; the hint is WIDTHxHEIGHT. Getting this backwards would
        // silently distort every image in the graph.
        expect(text).toContain('|463x609](')
        expect(text).not.toContain('{:')
        expect(text).not.toContain(':height')
    })

    it('accepts the keys in either order and ignores unrelated ones', async () => {
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot](../assets/pic.png){:width 300, :height 200, :class "big"}'),
        ])
        expect(doc(graph, 'Note').text).toContain('|300x200](')
    })

    it('emits a width-only hint when Logseq gave only a width', async () => {
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot](../assets/pic.png){:width 300}'),
        ])
        expect(doc(graph, 'Note').text).toContain('|300](')
    })

    it('drops a height-only attribute, which has no equivalent, and reports it', async () => {
        // The hint form is `|W` or `|WxH`; there is no height-only spelling, and leaving the
        // attribute in place would keep the image from rendering.
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot](../assets/pic.png){:height 609}'),
        ])
        const text = doc(graph, 'Note').text
        expect(text).toContain('![shot](')
        expect(text).not.toContain('{:')
        expect(text).not.toContain('|')
        expect(graph.report.some((r) => r.detail.includes('needs a width'))).toBe(true)
    })

    it('leaves the image as a bullet\'s sole content, so it still renders', async () => {
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot](../assets/pic.png){:height 609, :width 463}'),
        ])
        const line = doc(graph, 'Note')
            .text.split('\n')
            .find((l) => l.includes('!['))!
        // `- ![alt|463x609](ref)` and nothing after it: what imageEmbedAugmentation requires.
        expect(line.trim()).toMatch(/^- !\[[^\]]*\]\([^)]*\)$/)
    })

    it('reports once per document, not once per image', async () => {
        // The source graph had 2097 of these; per-image entries would bury the report.
        const many = Array.from(
            { length: 5 },
            (_, n) => `- ![s${n}](../assets/pic.png){:height 10, :width 20}`,
        ).join('\n')
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', many),
        ])
        const entries = graph.report.filter((r) => r.detail.includes('display-size'))
        expect(entries).toHaveLength(1)
        expect(entries[0].concept).toBe('Note')
        // All five still converted.
        expect(doc(graph, 'Note').text.match(/\|20x10\]\(/g)).toHaveLength(5)
    })

    it('does not stack hints when the alt already carries one', async () => {
        const graph = await convertLogseq([
            src('assets/pic.png', new Uint8Array([1, 2, 3])),
            src('pages/Note.md', '- ![shot|100](../assets/pic.png){:height 609, :width 463}'),
        ])
        const text = doc(graph, 'Note').text
        expect(text).toContain('|463x609](')
        expect(text).not.toContain('|100|')
    })

    it('leaves images inside a fence alone', async () => {
        const graph = await convertLogseq([
            src('pages/Note.md', '- ```\n  ![x](y.png){:height 1, :width 2}\n  ```'),
        ])
        expect(doc(graph, 'Note').text).toContain('{:height 1, :width 2}')
    })
})
