import { describe, expect, it } from 'vitest'

import type { DocumentCreatingStore } from './draft'
import { addTaskToJournal, taskPlacement } from './task-placement'
import type { EditorDocument } from './types'

const task = ['- [ ] #P1 Build the shed', '  - measure the floor']
/** Garden, with Plot as an alias of it. */
const isGarden = (name: string) => ['garden', 'plot'].includes(name.toLowerCase())

function apply(text: string, placement: { from: number; to: number; insert: string }): string {
    return text.slice(0, placement.from) + placement.insert + text.slice(placement.to)
}

describe('taskPlacement', () => {
    it('writes the concept bullet and the task under it into an empty entry', () => {
        const placement = taskPlacement('', 'Garden', isGarden, task)
        expect(apply('', placement)).toBe('- [[Garden]]\n  - [ ] #P1 Build the shed\n    - measure the floor\n')
        expect(placement.line).toBe(1)
    })

    it("adds the task as the last child of the entry's bullet linking the concept, by any of its names and in any case", () => {
        const entry = ['- [[plot]]', '  - [ ] Water the beans', '    - twice', '- [[Kitchen]]', '  - wash up'].join('\n')
        const placement = taskPlacement(entry, 'Garden', isGarden, task)
        expect(apply(entry, placement)).toBe(
            ['- [[plot]]', '  - [ ] Water the beans', '    - twice', '  - [ ] #P1 Build the shed', '    - measure the floor', '- [[Kitchen]]', '  - wash up'].join('\n'),
        )
        expect(placement.line).toBe(3)
    })

    it('passes over a bullet where the link is not alone, or that is nested, and starts one at the end after a blank line', () => {
        const entry = ['- Talked about [[Garden]]', '- [[Kitchen]]', '  - [[Garden]]', ''].join('\n')
        const placement = taskPlacement(entry, 'Garden', isGarden, task)
        expect(apply(entry, placement)).toBe(
            ['- Talked about [[Garden]]', '- [[Kitchen]]', '  - [[Garden]]', '', '- [[Garden]]', '  - [ ] #P1 Build the shed', '    - measure the floor', ''].join('\n'),
        )
        expect(placement.line).toBe(5)
    })

    it('counts the line from the body, past any frontmatter', () => {
        const entry = ['---', 'title: 2026-11-03', '---', '- [[Garden]]'].join('\n')
        const placement = taskPlacement(entry, 'Garden', isGarden, task)
        expect(apply(entry, placement)).toBe(['---', 'title: 2026-11-03', '---', '- [[Garden]]', '  - [ ] #P1 Build the shed', '    - measure the floor'].join('\n'))
        expect(placement.line).toBe(1)
    })

    it('writes the task at the top level on the Graph Kanban, which has no concept', () => {
        const entry = '- water the beans\n'
        const placement = taskPlacement(entry, null, () => false, task)
        expect(apply(entry, placement)).toBe('- water the beans\n\n- [ ] #P1 Build the shed\n  - measure the floor\n')
        expect(placement.line).toBe(2)
    })
})

/** A creating store over a map of concept to text. */
function fakeStore(initial: Record<string, string> = {}) {
    const texts = new Map(Object.entries(initial))
    const origins: string[] = []
    const store: DocumentCreatingStore = {
        open(target): EditorDocument {
            return {
                id: target,
                getText: () => texts.get(target) ?? '',
                applyChange(change, origin) {
                    const current = texts.get(target) ?? ''
                    texts.set(target, current.slice(0, change.from) + change.insert + current.slice(change.to))
                    origins.push(origin ?? 'editor')
                },
                subscribe: () => () => {},
            }
        },
        whenReady: async () => {},
        async createPage() {
            throw new Error('not a page')
        },
        async createJournal(date, body = '') {
            if (texts.has(date)) throw new Error(`A document for "${date}" already exists.`)
            texts.set(date, body)
            return date
        },
    }
    return { store, texts, origins }
}

describe('addTaskToJournal', () => {
    it("creates the day's entry with the task when there is none", async () => {
        const { store, texts } = fakeStore()
        const added = await addTaskToJournal(store, { day: '2026-11-03', concept: 'Garden', sameConcept: isGarden, lines: task })
        expect(added).toEqual({ document: '2026-11-03', line: 1, text: '  - [ ] #P1 Build the shed' })
        expect(texts.get('2026-11-03')).toBe('- [[Garden]]\n  - [ ] #P1 Build the shed\n    - measure the floor\n')
    })

    it('writes into an entry that exists as one external change', async () => {
        const { store, texts, origins } = fakeStore({ '2026-11-03': '- [[Garden]]\n  - weed' })
        const added = await addTaskToJournal(store, { day: '2026-11-03', concept: 'Garden', sameConcept: isGarden, lines: task })
        expect(texts.get('2026-11-03')).toBe('- [[Garden]]\n  - weed\n  - [ ] #P1 Build the shed\n    - measure the floor')
        expect(origins).toEqual(['external'])
        expect(added.line).toBe(2)
    })
})
