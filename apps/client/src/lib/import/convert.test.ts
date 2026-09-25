/**
 * The conversion entry point puts every document on the Indent Unit grid (ADR 0067): import is
 * the one boundary where a foreign grid enters a graph, whichever source format it came from.
 */

import { describe, expect, it } from 'vitest'

import { convertSource } from './convert'
import type { ConvertedGraph, SourceFile } from './types'

function src(path: string, content: string): SourceFile {
    return { path, data: new Blob([content]) }
}

function doc(graph: ConvertedGraph, concept: string): string {
    const found = graph.documents.find((d) => d.concept === concept)
    if (!found) throw new Error(`no document with concept "${concept}"`)
    return found.text
}

describe('convertSource normalises to the Indent Unit', () => {
    it('a four-space Obsidian vault arrives at two spaces a level, continuations and fences moving with their bullets', async () => {
        const graph = await convertSource(
            [src('Notes.md', '- a\n    - b\n        - c\n          more\n          ```\n          code\n          ```\n    - d\n\nprose\n\n    indented code block')],
            'obsidian',
        )
        expect(doc(graph, 'Notes')).toBe('---\ntitle: Notes\n---\n- a\n  - b\n    - c\n      more\n      ```\n      code\n      ```\n  - d\n\nprose\n\n    indented code block')
    })

    it('a tab-indented Logseq page arrives at two spaces a level', async () => {
        const graph = await convertSource([src('pages/Physics.md', '- a\n\t- b\n\t\t- c\n\t- d')], 'logseq')
        expect(doc(graph, 'Physics')).toBe('---\ntitle: Physics\n---\n- a\n  - b\n    - c\n  - d')
    })

    it('an EtherPK folder edited elsewhere is re-gridded too, its frontmatter untouched', async () => {
        const graph = await convertSource(
            [src('pages/Foo.md', '---\ntitle: Foo\ntags:\n    - x\n---\n- a\n    - b')],
            'etherpk',
        )
        expect(doc(graph, 'Foo')).toBe('---\ntitle: Foo\ntags:\n    - x\n---\n- a\n  - b')
    })

    it('a document already on the grid is unchanged', async () => {
        const text = '- a\n  - b\n    - c\n  soft\n- d'
        const graph = await convertSource([src('pages/Bar.md', text)], 'etherpk')
        expect(doc(graph, 'Bar')).toBe(text)
    })
})
