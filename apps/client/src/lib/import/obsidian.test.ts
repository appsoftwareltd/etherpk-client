import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { aliasesOf } from '$lib/storage/fs/identity'

import { convertObsidian } from './obsidian'
import type { ConvertedGraph, SourceFile } from './types'

function src(path: string, content: string | Uint8Array<ArrayBuffer>): SourceFile {
    return { path, data: new Blob([content]) }
}

function doc(graph: ConvertedGraph, concept: string) {
    const found = graph.documents.find((d) => d.concept === concept)
    if (!found) throw new Error(`no document with concept "${concept}"`)
    return found
}

describe('convertObsidian', () => {
    it('flattens folders; only colliding base names become scoped concepts', async () => {
        const graph = await convertObsidian([
            src('projects/alpha/Notes.md', 'alpha notes'),
            src('projects/beta/Notes.md', 'beta notes'),
            src('deep/nested/Unique.md', 'unique'),
            src('linker.md', 'see [[Notes]] and [[projects/alpha/Notes]] and [[Unique]]'),
        ])
        expect(doc(graph, '[[alpha]] Notes').text).toContain('title: "[[alpha]] Notes"')
        expect(doc(graph, '[[beta]] Notes').kind).toBe('page')
        expect(doc(graph, 'Unique').text).toContain('title: Unique')
        const linker = doc(graph, 'linker').text
        expect(linker).toContain('[[[[alpha]] Notes]]')
        expect(linker).toContain('[[Unique]]')
        expect(graph.report.some((r) => r.category === 'collision')).toBe(true)
        expect(graph.report.some((r) => r.category === 'unresolved' && r.detail.includes('ambiguous'))).toBe(true)
    })

    it('resolves a link by the end of its path, and reports an ambiguous name once', async () => {
        const graph = await convertObsidian([
            src('garden/beds/Notes.md', 'bed notes'),
            src('kitchen/Notes.md', 'kitchen notes'),
            src('linker.md', 'see [[beds/Notes]], [[Notes]] and [[Notes]] again'),
        ])
        expect(doc(graph, 'linker').text).toContain('see [[[[beds]] Notes]], [[[[beds]] Notes]] and [[[[beds]] Notes]] again')
        expect(graph.report.filter((r) => r.category === 'unresolved' && r.detail.includes('ambiguous'))).toHaveLength(1)
    })

    it('reports no ambiguity for a name only one note has', async () => {
        const graph = await convertObsidian([src('garden/Notes.md', 'notes'), src('linker.md', 'see [[Notes]]')])
        expect(graph.report.filter((r) => r.category === 'unresolved')).toEqual([])
    })

    it('reads only text alias values, and drops an empty alias property', async () => {
        const graph = await convertObsidian([
            src('Garden.md', '---\nalias: [Allotment, 7]\n---\nx'),
            src('Kitchen.md', '---\nalias: []\ntags: [n]\n---\nx'),
        ])
        expect(aliasesOf(parseFrontmatter(doc(graph, 'Garden').text))).toEqual(['Allotment'])
        expect(doc(graph, 'Kitchen').text).toBe('---\ntitle: Kitchen\ntags:\n  - n\n---\nx')
    })

    it('reports no title change when the title was the page’s name or blank', async () => {
        const graph = await convertObsidian([src('Garden.md', '---\ntitle: Garden\n---\nx'), src('Kitchen.md', '---\ntitle: " "\n---\nx')])
        expect(graph.report.filter((r) => r.detail.includes('title'))).toEqual([])
    })

    it('rewrites piped links alias-aware with a visible prose fallback', async () => {
        const graph = await convertObsidian([
            src('Quantum Mechanics.md', '---\naliases:\n  - QM\n---\ncontent'),
            src('user.md', 'a [[Quantum Mechanics|QM]] b [[Quantum Mechanics|quantum mechanics]] c [[Quantum Mechanics|the theory]]'),
        ])
        const text = doc(graph, 'user').text
        expect(text).toContain('a [[QM]] b')
        expect(text).toContain('b [[quantum mechanics]] c')
        expect(text).toContain('c the theory ([[Quantum Mechanics]])')
        expect(graph.report.some((r) => r.category === 'degradation' && r.detail.includes('the theory'))).toBe(true)
    })

    // Obsidian read `alias` as well as `aliases` and split a text value at its commas until 1.4
    // began rewriting both to a list; 1.9 stopped reading them. A vault last saved by an older
    // Obsidian still holds them, and EtherPK reads aliases only from an `aliases:` list.
    it('reads the older alias forms and writes each as an aliases list', async () => {
        const graph = await convertObsidian([
            src('One.md', '---\naliases: Uno\n---\nx'),
            src('Two.md', '---\naliases: Dos, Deux\ntags: [n]\n---\nx'),
            src('Three.md', '---\nalias: Tres\n---\nx'),
            src('Four.md', '---\nalias: [Cuatro, Quatre]\n---\nx'),
            src('Five.md', '---\nalias: Cinq, Fünf\naliases: [Cinco]\n---\nx'),
            src('user.md', '[[One|Uno]] [[Two|Deux]] [[Three|Tres]] [[Four|Quatre]] [[Five|Fünf]]'),
        ])
        const aliases = (concept: string) => aliasesOf(parseFrontmatter(doc(graph, concept).text))
        expect(aliases('One')).toEqual(['Uno'])
        expect(aliases('Two')).toEqual(['Dos', 'Deux'])
        expect(aliases('Three')).toEqual(['Tres'])
        expect(aliases('Four')).toEqual(['Cuatro', 'Quatre'])
        expect(aliases('Five')).toEqual(['Cinco', 'Cinq', 'Fünf'])
        for (const concept of ['One', 'Two', 'Three', 'Four', 'Five']) {
            expect(doc(graph, concept).text).not.toMatch(/^alias:/m)
        }
        expect(doc(graph, 'Two').text).toContain('tags:\n  - n\n')
        // The piped links see the same aliases the pages now carry.
        expect(doc(graph, 'user').text).toContain('[[Uno]] [[Deux]] [[Tres]] [[Quatre]] [[Fünf]]')
    })

    it('degrades note embeds and fragment links, and strips block anchors', async () => {
        const graph = await convertObsidian([
            src('Target.md', 'body ^abc123'),
            src('user.md', '![[Target]]\n[[Target#Section]]\n[[Target#^abc123]]'),
        ])
        const text = doc(graph, 'user').text
        expect(text).toContain('[[Target]]\n[[Target]]\n[[Target]]')
        expect(doc(graph, 'Target').text).toBe('---\ntitle: Target\n---\nbody')
        expect(graph.report.filter((r) => r.detail.includes('fragment'))).toHaveLength(2)
    })

    it('detects daily notes from config and falls back to ISO names', async () => {
        const withConfig = await convertObsidian([
            src('.obsidian/daily-notes.json', '{"folder": "daily", "format": "DD-MM-YYYY"}'),
            src('daily/16-07-2026.md', 'today'),
            src('elsewhere/16-07-2026.md', 'not a journal'),
            src('note.md', 'link [[16-07-2026]]'),
        ])
        const journal = doc(withConfig, '2026-07-16')
        expect(journal.kind).toBe('journal')
        expect(journal.fileName).toBe('2026-07-16.md')

        const fallback = await convertObsidian([src('2026-07-16.md', 'today')])
        expect(doc(fallback, '2026-07-16').kind).toBe('journal')
    })

    it('converts wiki asset embeds with size hints and rewrites markdown asset paths', async () => {
        const bytes = new Uint8Array([5, 6, 7])
        const graph = await convertObsidian([
            src('attachments/My Shot.png', bytes),
            src('files/doc.pdf', new Uint8Array([8])),
            src('user.md', '![[My Shot.png|300]]\n![[doc.pdf]]\nplain ![alt](attachments/My%20Shot.png)'),
        ])
        const shot = graph.assets.find((a) => a.fileName.startsWith('my-shot.'))
        expect(shot).toBeDefined()
        const text = doc(graph, 'user').text
        expect(text).toContain(`![my-shot|300](../assets/${shot?.fileName})`)
        expect(text).toContain('[doc](../assets/doc.')
        expect(text).toContain(`![alt](../assets/${shot?.fileName})`)
        expect(shot?.unreferenced).toBe(false)
    })

    it('reads a size hint only from a pipe that is all width, or width and height, and any other pipe as the alt text', async () => {
        const graph = await convertObsidian([
            src('attachments/Shot.png', new Uint8Array([1])),
            src('user.md', '![[Shot.png|300x200]]\n![[Shot.png|300px]]\n![[Shot.png|a 300]]'),
        ])
        const shot = graph.assets.find((a) => a.fileName.startsWith('shot.'))!
        expect(doc(graph, 'user').text).toContain(
            [`![shot|300x200](../assets/${shot.fileName})`, `![300px](../assets/${shot.fileName})`, `![a 300](../assets/${shot.fileName})`].join('\n'),
        )
    })

    it('converts Tasks-plugin lines inside a vault', async () => {
        const graph = await convertObsidian([
            src('todo.md', '- [ ] ship it ⏫ 📅 2026-08-01\n- [/] drafting\n- [-] dropped idea'),
        ])
        const text = doc(graph, 'todo').text
        expect(text).toContain('- [ ] #P2 #D-2026-08-01 ship it')
        expect(text).toContain('- [ ] #D drafting')
        expect(text).toContain('- [x] #C dropped idea')
    })

    it('leaves external links, tags and fences as they are', async () => {
        const graph = await convertObsidian([
            src('note.md', '[site](https://example.com/page.md)\n#hashtag stays\n```\n![[not-an-embed]]\n```'),
        ])
        const text = doc(graph, 'note').text
        expect(text).toContain('[site](https://example.com/page.md)')
        expect(text).toContain('#hashtag stays')
        expect(text).toContain('![[not-an-embed]]')
    })

    it('removes comments, which Obsidian hides, and lists each with its text', async () => {
        const graph = await convertObsidian([
            src(
                'note.md',
                [
                    'before %%hidden inline%% after',
                    '%%',
                    'block line one',
                    'block line two',
                    '%%',
                    'kept `%%not a comment%%` in code',
                    '```',
                    '%%in a fence%%',
                    '```',
                    'an unclosed %% stays',
                ].join('\n'),
            ),
        ])
        const text = doc(graph, 'note').text
        expect(text).toContain('before after\nkept `%%not a comment%%` in code\n```\n%%in a fence%%\n```\nan unclosed %% stays')
        expect(text).not.toContain('hidden inline')
        expect(text).not.toContain('block line')
        expect(graph.report.filter((r) => r.category === 'drop').map((r) => r.detail)).toEqual([
            'Comment removed: "hidden inline"',
            'Comment removed: "block line one block line two"',
        ])
    })

    it('turns a callout into a quote with a bold heading, and says so', async () => {
        const graph = await convertObsidian([
            src('note.md', '> [!warning] Mind the gap\n> the body\n\n> [!tip]-\n> folded\n\n> [!NOTE] Note'),
        ])
        const text = doc(graph, 'note').text
        expect(text).toContain('> **Warning: Mind the gap**\n> the body')
        expect(text).toContain('> **Tip**\n> folded')
        expect(text).toContain('> **Note**')
        expect(graph.report.filter((r) => r.category === 'degradation' && r.detail.startsWith('Callout'))).toHaveLength(3)
    })

    it('reports the footnotes, tags and canvases it keeps as they are', async () => {
        const graph = await convertObsidian([
            src('note.md', '# Heading\nA claim[^1] about #project/alpha and #idea, not `#code`.\n\n[^1]: The source.'),
            src('Board.canvas', '{"nodes":[],"edges":[]}'),
        ])
        expect(doc(graph, 'note').text).toContain('A claim[^1] about #project/alpha and #idea')
        expect(graph.report.filter((r) => r.category === 'unsupported').map((r) => r.detail)).toEqual([
            'Canvas "Board.canvas" imported as a file: EtherPK has no canvas view',
            'Footnotes kept as written: EtherPK does not render them',
            'Tags kept as plain text (#project/alpha, #idea): EtherPK has no tags',
        ])
    })

    it('keeps other frontmatter keys and replaces a conflicting title', async () => {
        const graph = await convertObsidian([
            src('Note.md', '---\ntitle: Something Else\ntags:\n  - x\n---\nbody'),
        ])
        const text = doc(graph, 'Note').text
        expect(text).toContain('title: Note')
        expect(text).toContain('tags:')
        expect(graph.report.some((r) => r.detail.includes('Something Else'))).toBe(true)
    })

    // Obsidian reads properties as YAML, so a block YAML rejects was unreadable there too. It used
    // to vanish here: the parse failed, the body began after the block, and only a new `title:`
    // was written above it.
    it('keeps a frontmatter block YAML cannot read exactly as written, and reports it', async () => {
        const block = '---\ntitle: Plans: 2026\ntags: [a\n---\n'
        const graph = await convertObsidian([
            src('Note.md', `${block}body links [[Other]]`),
            src('2026-07-16.md', `${block}today`),
            src('Other.md', 'x'),
        ])
        expect(doc(graph, 'Note').text).toBe(`${block}body links [[Other]]`)
        expect(doc(graph, '2026-07-16').text).toBe(`${block}today`)
        const unreadable = graph.report.filter((r) => r.category === 'unsupported' && r.detail.includes('not valid YAML'))
        expect(unreadable.map((r) => r.concept).sort()).toEqual(['2026-07-16', 'Note'])
    })
})

/**
 * Obsidian's core Templates plugin keeps templates in one folder (`.obsidian/templates.json`), and
 * its variables are already EtherPK's (`{{date}}`, `{{time}}`, `{{title}}`, `{{date:FORMAT}}`).
 * A page from that folder becomes a Template (ADR 0144), and the daily notes template the graph's
 * Journal Template (ADR 0145).
 */
describe('convertObsidian templates', () => {
    const report = (graph: ConvertedGraph, category: string) => graph.report.filter((r) => r.category === category)

    it('marks every page in the templates folder a Template, keeping its other frontmatter and its variables', async () => {
        const graph = await convertObsidian([
            src('.obsidian/templates.json', '{"folder": "/Templates/"}'),
            src('Templates/Daily.md', '---\ntags:\n  - plan\n---\n# {{date}}\n- [ ] water the beans at {{time}} on [[{{title}}]]'),
            src('Templates/Garden/Weekly.md', '{{date:YYYY-MM-DD}} review'),
            src('Notes.md', 'not a template'),
        ])
        expect(doc(graph, 'Daily').text).toBe(
            '---\ntitle: Daily\ntags:\n  - plan\ntemplate: true\n---\n# {{date}}\n- [ ] water the beans at {{time}} on [[{{title}}]]',
        )
        expect(doc(graph, 'Weekly').text).toBe('---\ntitle: Weekly\ntemplate: true\n---\n{{date:YYYY-MM-DD}} review')
        expect(doc(graph, 'Notes').text).toBe('---\ntitle: Notes\n---\nnot a template')
        expect(graph.settings).toBeUndefined()
    })

    it('marks nothing without a templates folder', async () => {
        const graph = await convertObsidian([src('.obsidian/templates.json', '{}'), src('Templates/Daily.md', '# {{date}}')])
        expect(doc(graph, 'Daily').text).toBe('---\ntitle: Daily\n---\n# {{date}}')
    })

    it('reports the Moment tokens a Template uses that EtherPK does not fill in, once per page', async () => {
        const graph = await convertObsidian([
            src('.obsidian/templates.json', '{"folder": "Templates"}'),
            src(
                'Templates/Log.md',
                'Written {{date:dddd, MMMM Do YYYY}} at {{time:hh:mm A}}, {{date:YYYY-MM-DDTHH:mm}} and {{ date:[Week] MMMM }}',
            ),
            src('Templates/Plain.md', '{{date:DD/MM/YY}} {{time:HH:mm:ss}}'),
            src('Elsewhere.md', '{{date:dddd}} in a page that is no Template'),
        ])
        expect(report(graph, 'unsupported')).toEqual([
            {
                category: 'unsupported',
                concept: 'Log',
                detail: 'The date and time formats in this Template use the Moment tokens `dddd`, `MMMM`, `Do`, `hh` and `A`, which EtherPK does not fill in. EtherPK fills in only YYYY, YY, MM, DD, HH, mm and ss.',
            },
        ])
    })

    it('reports a date or time format setting that EtherPK does not follow', async () => {
        const graph = await convertObsidian([
            src('.obsidian/templates.json', '{"folder": "Templates", "dateFormat": "DD/MM/YYYY", "timeFormat": "HH:mm"}'),
            src('Templates/Daily.md', '# {{date}}'),
        ])
        expect(report(graph, 'degradation').map((r) => r.detail)).toEqual([
            '.obsidian/templates.json sets the date format to "DD/MM/YYYY". In EtherPK, `{{date}}` always gives YYYY-MM-DD. To keep the old form, write `{{date:DD/MM/YYYY}}` in a Template.',
        ])
    })

    it('sets the Journal Template to the daily notes template', async () => {
        const graph = await convertObsidian([
            src('.obsidian/templates.json', '{"folder": "Templates"}'),
            src('.obsidian/daily-notes.json', '{"folder": "daily", "template": "Templates/Daily"}'),
            src('Templates/Daily.md', '# {{date}}'),
        ])
        expect(graph.settings).toEqual({ journalTemplate: 'Daily' })
    })

    it('makes the daily notes template a Template wherever it is, as Obsidian uses it as one', async () => {
        const graph = await convertObsidian([
            src('.obsidian/daily-notes.json', '{"template": "Setup/Morning Page.md"}'),
            src('Setup/Morning Page.md', '- [ ] water the beans'),
        ])
        expect(doc(graph, 'Morning Page').text).toBe('---\ntitle: Morning Page\ntemplate: true\n---\n- [ ] water the beans')
        expect(graph.settings).toEqual({ journalTemplate: 'Morning Page' })
    })

    it('reports a daily notes template the import did not find, and sets nothing', async () => {
        const graph = await convertObsidian([
            src('.obsidian/daily-notes.json', '{"folder": "daily", "template": "Templates/Missing"}'),
            src('Notes.md', 'x'),
        ])
        expect(graph.settings).toBeUndefined()
        expect(report(graph, 'unresolved')).toEqual([
            {
                category: 'unresolved',
                detail: '.obsidian/daily-notes.json names "Templates/Missing" as the template for new daily notes, but the import found no note there. The graph has no Journal Template.',
            },
        ])
    })

    it('reports a template page whose frontmatter it cannot mark', async () => {
        const block = '---\ntitle: Plans: 2026\n---\n'
        const graph = await convertObsidian([
            src('.obsidian/templates.json', '{"folder": "Templates"}'),
            src('.obsidian/daily-notes.json', '{"template": "Templates/Daily"}'),
            src('Templates/Daily.md', `${block}# {{date}}`),
        ])
        expect(doc(graph, 'Daily').text).toBe(`${block}# {{date}}`)
        expect(graph.settings).toBeUndefined()
        expect(report(graph, 'unsupported').map((r) => r.detail)).toContain(
            'This page is a template in Obsidian, but its frontmatter is not valid YAML, so it was not made a Template. Correct the frontmatter and add `template: true` to make it one.',
        )
    })
})
