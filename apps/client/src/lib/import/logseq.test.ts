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

    it('folds a date only into the task directly above it, not across a blank line or into a plain bullet', async () => {
        const graph = await convertLogseq([
            src(
                'pages/garden.md',
                [
                    '- TODO water the beans',
                    '',
                    '  DEADLINE: <2026-03-20 Fri>',
                    '- pick the peas',
                    '  SCHEDULED: <2026-04-01 Wed>',
                    '- DONE sow the seeds',
                    '  :LOGBOOK:',
                    '  :END:',
                ].join('\n'),
            ),
        ])
        const text = doc(graph, 'garden').text
        expect(text).toContain('- [ ] water the beans\n')
        expect(text).toContain('DEADLINE: <2026-03-20 Fri>')
        expect(text).toContain('- pick the peas\n  SCHEDULED: <2026-04-01 Wed>')
        // A drawer with no DONE state gives the task no completion date.
        expect(text).toContain('- [x] sow the seeds')
        expect(text).not.toContain('#C-')
    })

    it('converts a tag at the start of a line, and leaves a # inside a word alone', async () => {
        const graph = await convertLogseq([src('pages/tags.md', '#garden first\n- #[[green beans]] and see#kitchen')])
        const text = doc(graph, 'tags').text
        expect(text).toContain('[[garden]] first')
        expect(text).toContain('- [[green beans]] and see#kitchen')
    })

    it('reports a namespace link once per target, and leaves a web address with slashes alone', async () => {
        const graph = await convertLogseq([
            src('pages/links.md', '- [[garden/beds]] and [[garden/beds]] again\n- [[https://example.com/garden]]'),
        ])
        expect(doc(graph, 'links').text).toContain('[[https://example.com/garden]]')
        const namespaced = graph.report.filter((r) => r.concept === 'links' && r.detail.includes('garden/beds'))
        expect(namespaced).toHaveLength(1)
    })

    it('stores pages whose file names would match under numbered names, and says so', async () => {
        const graph = await convertLogseq([src('pages/Garden?.md', '- a'), src('pages/Garden_.md', '- b'), src('pages/Garden*.md', '- c')])
        expect(graph.documents.map((d) => [d.concept, d.fileName])).toEqual([
            ['Garden?', 'Garden_.md'],
            ['Garden_', 'Garden_ (2).md'],
            ['Garden*', 'Garden_ (3).md'],
        ])
        expect(graph.report.filter((r) => r.category === 'collision').map((r) => r.detail)).toEqual([
            'File name "Garden_.md" already taken - stored as "Garden_ (2).md" (frontmatter title keeps the concept)',
            'File name "Garden_.md" already taken - stored as "Garden_ (3).md" (frontmatter title keeps the concept)',
        ])
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

/**
 * Logseq marks a template with a block property (`template:: Name`) on any block. EtherPK's
 * Template is a page (ADR 0144), so each such block becomes the page `[[Templates]] Name`, and
 * leaves the page it sat on, so its tasks are not in two places.
 */
describe('convertLogseq templates', () => {
    const report = (graph: ConvertedGraph, category: string) => graph.report.filter((r) => r.category === category)

    it('moves a template block, children and all, to a Template page of its own', async () => {
        const graph = await convertLogseq([
            src(
                'pages/Garden.md',
                [
                    '- Plans',
                    '- Weekly Review',
                    '  template:: Weekly Review',
                    '  id:: 66f1a2b3-c4d5-e6f7-a8b9-c0d1e2f3a4b5',
                    '\t- TODO water the beans',
                    '\t- check the fence',
                    '- Harvest',
                ].join('\n'),
            ),
        ])
        expect(doc(graph, '[[Templates]] Weekly Review').text).toBe(
            '---\ntitle: "[[Templates]] Weekly Review"\ntemplate: true\n---\n- Weekly Review\n  - [ ] water the beans\n  - check the fence',
        )
        expect(doc(graph, 'Garden').text).toBe('---\ntitle: Garden\n---\n- Plans\n- Harvest')
        expect(report(graph, 'rename')).toContainEqual({
            category: 'rename',
            concept: '[[Templates]] Weekly Review',
            detail: 'The Logseq template "Weekly Review" in [[Garden]] became a Template page of its own, and was removed from [[Garden]].',
        })
    })

    it('takes only the children, at the margin, when template-including-parent is false', async () => {
        const graph = await convertLogseq([
            src(
                'pages/Kitchen.md',
                [
                    '- Recipes',
                    '\t- Soup',
                    '\t  template:: Soup',
                    '\t  template-including-parent:: false',
                    '\t  collapsed:: true',
                    '\t\t- chop the carrots',
                    '\t\t\t- small pieces',
                    '\t\t- boil the water',
                    '\t- Bread',
                ].join('\n'),
            ),
        ])
        expect(doc(graph, '[[Templates]] Soup').text).toBe(
            '---\ntitle: "[[Templates]] Soup"\ntemplate: true\n---\n- chop the carrots\n  - small pieces\n- boil the water',
        )
        expect(doc(graph, 'Kitchen').text).toBe('---\ntitle: Kitchen\n---\n- Recipes\n  - Bread')
    })

    it('keeps a template block in a journal, and a fenced one, the way Logseq reads them', async () => {
        const graph = await convertLogseq([
            src('journals/2026_07_16.md', '- Evening\n  template:: Evening\n  - close the shed\n- the day itself'),
            src('pages/Notes.md', '- ```\n  - not a block\n    template:: Fenced\n  ```'),
        ])
        expect(doc(graph, '[[Templates]] Evening').text).toContain('- Evening\n  - close the shed')
        expect(doc(graph, '2026-07-16').text).toBe('- the day itself')
        expect(graph.documents.some((d) => d.concept.includes('Fenced'))).toBe(false)
        expect(doc(graph, 'Notes').text).toContain('template:: Fenced')
    })

    it('turns the dynamic variables into Template Variables, in Template pages only', async () => {
        const graph = await convertLogseq([
            src(
                'pages/Garden.md',
                [
                    '- Daily',
                    '  template:: Daily',
                    '  template-including-parent:: false',
                    '\t- [[<% today %>]] notes',
                    '\t- planted on <% today %>, before <% Tomorrow %> and after <%yesterday%>',
                    '\t- at <% time %> on <%  current   page %>',
                    '\t- later <% next monday %> and <% last friday %> and <% NEXT MONDAY %>',
                    '- elsewhere <% today %> stays',
                ].join('\n'),
            ),
        ])
        expect(doc(graph, '[[Templates]] Daily').text).toBe(
            [
                '---',
                'title: "[[Templates]] Daily"',
                'template: true',
                '---',
                '- [[{{date}}]] notes',
                '- planted on [[{{date}}]], before [[{{tomorrow}}]] and after [[{{yesterday}}]]',
                '- at {{time}} on [[{{title}}]]',
                '- later <% next monday %> and <% last friday %> and <% NEXT MONDAY %>',
            ].join('\n'),
        )
        expect(doc(graph, 'Garden').text).toContain('- elsewhere <% today %> stays')
        expect(report(graph, 'unsupported')).toEqual([
            {
                category: 'unsupported',
                concept: '[[Templates]] Daily',
                detail: 'The template variables `<% next monday %>`, `<% last friday %>` and `<% NEXT MONDAY %>` were kept as written. EtherPK does not fill them in.',
            },
        ])
    })

    it('fills a variable inside a longer link without a second pair of brackets', async () => {
        const graph = await convertLogseq([
            src('pages/Garden.md', '- Log\n  template:: Log\n  - see [[<% today %> harvest]] and [[<% current page %>]]'),
        ])
        expect(doc(graph, '[[Templates]] Log').text).toContain('- see [[{{date}} harvest]] and [[{{title}}]]')
    })

    it('takes the children of a block whose only text is its template property', async () => {
        const graph = await convertLogseq([
            src('pages/Kitchen.md', '- template:: Kitchen Tidy\n  icon:: broom\n\t- wash the pans\n\t- sweep the floor\n\n- Pantry'),
        ])
        expect(doc(graph, '[[Templates]] Kitchen Tidy').text).toBe(
            '---\ntitle: "[[Templates]] Kitchen Tidy"\ntemplate: true\n---\n- wash the pans\n- sweep the floor',
        )
        // The blank line after the block separated it from the next one, so it stays.
        expect(doc(graph, 'Kitchen').text).toBe('---\ntitle: Kitchen\n---\n\n- Pantry')
    })

    it('makes a template inside another template a Template too, and cuts only the outer one', async () => {
        const graph = await convertLogseq([
            src(
                'pages/Garden.md',
                [
                    '- Season',
                    '  template:: Season',
                    '	- Spring',
                    '	  template:: Spring',
                    '		- sow the beans',
                    '	- Autumn',
                    '- Shed',
                ].join('\n'),
            ),
        ])
        expect(doc(graph, '[[Templates]] Season').text).toContain('- Season\n  - Spring\n    - sow the beans\n  - Autumn')
        expect(doc(graph, '[[Templates]] Spring').text).toContain('---\n- Spring\n  - sow the beans')
        expect(doc(graph, 'Garden').text).toBe('---\ntitle: Garden\n---\n- Shed')
    })

    it('keeps the bullet of a nested template whose only text was its property, so its children keep their depth', async () => {
        const graph = await convertLogseq([
            src('pages/Garden.md', '- Season\n  template:: Season\n\t- template:: Spring\n\t\t- sow the beans\n\t- Autumn'),
        ])
        expect(doc(graph, '[[Templates]] Season').text).toContain('---\n- Season\n  -\n    - sow the beans\n  - Autumn')
        expect(doc(graph, '[[Templates]] Spring').text).toContain('---\n- sow the beans')
    })

    it('suffixes a template whose name is taken, and says so', async () => {
        const graph = await convertLogseq([
            src('pages/Templates___Daily.md', '- the namespace page'),
            src('pages/Garden.md', '- Daily\n  template:: Daily\n  - water the beans'),
            src('pages/Kitchen.md', '- Daily\n  template:: daily\n  - wash the pans'),
        ])
        expect(doc(graph, '[[Templates]] Daily').text).toContain('- the namespace page')
        expect(doc(graph, '[[Templates]] Daily (2)').text).toContain('water the beans')
        expect(doc(graph, '[[Templates]] daily (3)').text).toContain('wash the pans')
        expect(report(graph, 'collision').map((r) => r.concept)).toEqual(['[[Templates]] Daily (2)', '[[Templates]] daily (3)'])
    })

    it('marks a page whose page properties name it a template, named after the page', async () => {
        const graph = await convertLogseq([
            src('pages/Morning Routine.md', 'template:: Morning\ntemplate-including-parent:: false\n- stretch\n- water the beans on <% today %>'),
            src('pages/Evening.md', 'template:: evening\n- close the shed'),
        ])
        expect(doc(graph, 'Morning Routine').text).toBe(
            '---\ntitle: Morning Routine\ntemplate: true\n---\n- stretch\n- water the beans on [[{{date}}]]',
        )
        expect(doc(graph, 'Evening').text).toBe('---\ntitle: Evening\ntemplate: true\n---\n- close the shed')
        expect(report(graph, 'rename')).toEqual([
            {
                category: 'rename',
                concept: 'Morning Routine',
                detail: 'Logseq named this template "Morning". A Template takes the name of its page, so it is now the Template "Morning Routine".',
            },
        ])
    })

    it('sets the Journal Template from :default-templates when the import found that template', async () => {
        const graph = await convertLogseq([
            src('logseq/config.edn', '{:meta/version 1\n ;; :default-templates {:journals "Commented"}\n :default-templates\n {:journals "daily"}}'),
            src('pages/Garden.md', '- Daily\n  template:: Daily\n  - water the beans'),
        ])
        expect(graph.settings).toEqual({ journalTemplate: '[[Templates]] Daily' })
        expect(report(graph, 'unresolved')).toEqual([])
    })

    it('reports a default journal template the import did not find, and sets nothing', async () => {
        const graph = await convertLogseq([
            src('logseq/config.edn', '{:default-templates {:journals "Weekly Review"}}'),
            src('pages/Garden.md', '- Daily\n  template:: Daily\n  - water the beans'),
        ])
        expect(graph.settings).toBeUndefined()
        expect(report(graph, 'unresolved')).toEqual([
            {
                category: 'unresolved',
                detail: 'logseq/config.edn names "Weekly Review" as the default journal template, but the import found no template with that name. The graph has no Journal Template.',
            },
        ])
    })

    it('sets nothing for the empty default Logseq writes', async () => {
        const graph = await convertLogseq([src('logseq/config.edn', '{:default-templates\n {:journals ""}}'), src('pages/Garden.md', '- x')])
        expect(graph.settings).toBeUndefined()
        expect(graph.report).toEqual([])
    })
})

describe('parseLogseqConfig', () => {
    it('reads the default journal template, and nothing from comments', () => {
        expect(parseLogseqConfig(':default-templates\n {:journals "Daily"}').journalTemplate).toBe('Daily')
        expect(parseLogseqConfig(':default-templates {:journals ""}').journalTemplate).toBeUndefined()
        expect(parseLogseqConfig(';; :default-templates {:journals "Daily"}').journalTemplate).toBeUndefined()
    })

    it('reads a setting after a commented-out example of it', () => {
        const config = parseLogseqConfig(';; :journal/file-name-format "yyyy_MM_dd"\n:journal/file-name-format "yyyy-MM-dd" ; the one in use')
        expect(config.journalFileFormat).toBe('yyyy-MM-dd')
    })

    it('keeps a semicolon inside a string', () => {
        expect(parseLogseqConfig(':default-templates {:journals "Plan; Review"}').journalTemplate).toBe('Plan; Review')
    })
})
