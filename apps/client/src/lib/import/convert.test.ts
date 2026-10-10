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

// A Map Block (ADR 0118) is a fenced block every source format already carries: each converter
// leaves its lines as written, in prose and beneath a bullet, so no import rewrites a place.
describe('convertSource keeps Map Blocks as written', () => {
    const body = ['Places we liked.', '', '```map', 'Pebble Cove @ 50.74860, -4.07890', 'Coast walk @ 50.6623, -4.5887 > 50.67000, -1.55000', '```', '', '- Day 1', '  ```map', '  Chalk Point @ 50.66230, -4.58870', '  ```'].join('\n')

    it.each([
        ['obsidian', 'Trips.md'],
        ['logseq', 'pages/Trips.md'],
        ['etherpk', 'pages/Trips.md'],
        ['markdown', 'Trips.md'],
    ] as const)('from %s', async (format, path) => {
        const graph = await convertSource([src(path, body)], format)
        // Some formats gain a title in frontmatter above it, which is not the map's business.
        expect(doc(graph, 'Trips').endsWith(body)).toBe(true)
    })

    it('from AS Notes', async () => {
        const graph = await convertSource([src('.asnotes/index.db', ''), src('pages/Trips.md', body)], 'asnotes')
        expect(doc(graph, 'Trips').endsWith(body)).toBe(true)
    })
})
