import { describe, expect, it } from 'vitest'

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

    it('converts Tasks-plugin lines inside a vault', async () => {
        const graph = await convertObsidian([
            src('todo.md', '- [ ] ship it ⏫ 📅 2026-08-01\n- [/] drafting\n- [-] dropped idea'),
        ])
        const text = doc(graph, 'todo').text
        expect(text).toContain('- [ ] #P2 #D-2026-08-01 ship it')
        expect(text).toContain('- [ ] #D drafting')
        expect(text).toContain('- [x] #C dropped idea')
    })

    it('leaves external links, tags, callouts, and fences untouched', async () => {
        const graph = await convertObsidian([
            src(
                'note.md',
                '[site](https://example.com/page.md)\n#hashtag stays\n> [!note] a callout\n```\n![[not-an-embed]]\n```',
            ),
        ])
        const text = doc(graph, 'note').text
        expect(text).toContain('[site](https://example.com/page.md)')
        expect(text).toContain('#hashtag stays')
        expect(text).toContain('> [!note] a callout')
        expect(text).toContain('![[not-an-embed]]')
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
})
