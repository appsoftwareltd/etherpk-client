import { describe, expect, it } from 'vitest'

import { registryChanges } from './registry-changes'
import type { DocumentEntry } from './scan'

const entry = (concept: string, overrides: Partial<DocumentEntry> = {}): DocumentEntry => ({
    kind: 'page',
    concept,
    key: concept.toLowerCase(),
    subdir: 'pages',
    fileName: `${concept}.md`,
    aliases: [],
    lastModified: 1,
    size: 10,
    ...overrides,
})

const before = (...entries: DocumentEntry[]) => new Map(entries.map((e) => [e.key, e]))

describe('registryChanges', () => {
    it('finds nothing when the folder is as it was', () => {
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban')])).toEqual({ namesMoved: false, contentChanged: [] })
    })

    // An edit made outside the app, to a document nobody has open: the index re-reads that one.
    it('names a document whose file changed, and moves no names', () => {
        expect(registryChanges(before(entry('Kanban'), entry('Notes')), [entry('Kanban', { lastModified: 2 }), entry('Notes', { size: 11 })])).toEqual({
            namesMoved: false,
            contentChanged: ['Kanban', 'Notes'],
        })
    })

    it('says names moved when a document came, went, was retitled or re-cased, or changed its aliases', () => {
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban'), entry('Roadmap')]).namesMoved).toBe(true)
        expect(registryChanges(before(entry('Kanban'), entry('Roadmap')), [entry('Kanban')]).namesMoved).toBe(true)
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban Board', { fileName: 'Kanban.md' })]).namesMoved).toBe(true)
        expect(registryChanges(before(entry('Kanban')), [entry('kanban', { key: 'kanban' })]).namesMoved).toBe(true)
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban', { aliases: ['Board'] })]).namesMoved).toBe(true)
    })

    // A name the index holds can come back as another document: a page renamed away, and a new one
    // created under the old title before the index caught up. Matched by name alone, the index
    // kept the old page's rows. Named, the new document is read.
    it('names a document new under its name, beside moving the names', () => {
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban'), entry('Roadmap')])).toEqual({ namesMoved: true, contentChanged: ['Roadmap'] })
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban Board', { fileName: 'Kanban.md' })])).toEqual({
            namesMoved: true,
            contentChanged: ['Kanban Board'],
        })
    })

    it('names a document another file now holds, though its names are as they were', () => {
        expect(registryChanges(before(entry('Kanban')), [entry('Kanban', { fileName: 'Kanban (2).md' })])).toEqual({
            namesMoved: false,
            contentChanged: ['Kanban'],
        })
    })
})
