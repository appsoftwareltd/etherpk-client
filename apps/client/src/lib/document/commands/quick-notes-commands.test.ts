import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'
import type { CommandMenuContext } from '$lib/surface'

import type { DocumentCreatingStore } from '../draft'
import { getQuickNotes, type QuickNote, resetQuickNotes, setQuickNotes } from '../quick-notes'
import type { EditorDocument, TextChange } from '../types'
import { QUICK_NOTES_MOVE, moveQuickNotesToJournal, registerQuickNotesCommands } from './quick-notes-commands'

const note = (id: string, text: string, createdAt: number): QuickNote => ({ id, text, createdAt })
const day = (createdAt: number): string => (createdAt < 100 ? '2026-09-16' : '2026-09-17')

/** A creating store over a map of concept → text, recording what happens to it. */
function fakeStore(initial: Record<string, string> = {}) {
    const texts = new Map(Object.entries(initial))
    const changes: { concept: string; change: TextChange; origin?: string }[] = []
    const created: { concept: string; body: string }[] = []
    const store: DocumentCreatingStore = {
        open(target): EditorDocument {
            return {
                id: target,
                getText: () => texts.get(target) ?? '',
                applyChange(change, origin) {
                    const current = texts.get(target) ?? ''
                    texts.set(target, current.slice(0, change.from) + change.insert + current.slice(change.to))
                    changes.push({ concept: target, change, origin })
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
            created.push({ concept: date, body })
            return date
        },
    }
    return { store, texts, changes, created }
}

afterEach(() => resetQuickNotes())

describe('moveQuickNotesToJournal', () => {
    it("creates today's entry with the blocks when there is none, then deletes exactly those notes", async () => {
        const persist = { add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }
        setQuickNotes([note('a', 'Ring the dentist', 10), note('b', 'Fix the bike lock', 200)], persist)
        const { store, texts, created } = fakeStore()

        const outcome = await moveQuickNotesToJournal(store, { today: () => '2026-09-17', dayOf: day })

        expect(outcome).toEqual({ moved: 2, concept: '2026-09-17' })
        expect(created).toHaveLength(1)
        expect(texts.get('2026-09-17')).toBe('- [[2026-09-16]]\n  - Ring the dentist\n- [[2026-09-17]]\n  - Fix the bike lock\n')
        expect(persist.remove).toHaveBeenCalledWith(['a', 'b'])
        expect(getQuickNotes()).toEqual([])
    })

    it('appends after one blank line when the entry exists, as an external change', async () => {
        setQuickNotes([note('a', 'Late thought', 200)], { add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) })
        const { store, texts, changes } = fakeStore({ '2026-09-17': '- Morning\n' })

        await moveQuickNotesToJournal(store, { today: () => '2026-09-17', dayOf: day })

        expect(texts.get('2026-09-17')).toBe('- Morning\n\n- [[2026-09-17]]\n  - Late thought\n')
        expect(changes).toHaveLength(1)
        expect(changes[0].origin).toBe('external')
        expect(changes[0].change.from).toBe('- Morning\n'.length)
    })

    it('leaves every note in place when the journal write fails', async () => {
        const persist = { add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }
        setQuickNotes([note('a', 'Keep me', 200)], persist)
        const { store } = fakeStore()
        store.createJournal = async () => {
            throw new Error('read-only')
        }
        // The adopt path then finds no document either.
        store.open = () => {
            throw new Error('not found')
        }

        await expect(moveQuickNotesToJournal(store, { today: () => '2026-09-17', dayOf: day })).rejects.toThrow()
        expect(persist.remove).not.toHaveBeenCalled()
        expect(getQuickNotes().map((n) => n.id)).toEqual(['a'])
    })

    it('moves only the notes it wrote: one that arrives mid-write stays', async () => {
        const persist = { add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }
        setQuickNotes([note('a', 'Written', 200)], persist)
        const { store } = fakeStore()
        const create = store.createJournal
        store.createJournal = async (date, body) => {
            // A peer's note lands while the create is in flight.
            setQuickNotes([note('a', 'Written', 200), note('peer', 'From the phone', 300)], persist)
            return create(date, body)
        }

        const outcome = await moveQuickNotesToJournal(store, { today: () => '2026-09-17', dayOf: day })

        expect(outcome.moved).toBe(1)
        expect(persist.remove).toHaveBeenCalledWith(['a'])
        expect(getQuickNotes().map((n) => n.id)).toEqual(['peer'])
    })

    it('does nothing with an empty list', async () => {
        setQuickNotes([], { add: vi.fn(), remove: vi.fn() })
        const { store, created } = fakeStore()
        const outcome = await moveQuickNotesToJournal(store, { today: () => '2026-09-17', dayOf: day })
        expect(outcome).toEqual({ moved: 0, concept: '2026-09-17' })
        expect(created).toHaveLength(0)
    })
})

describe('registerQuickNotesCommands', () => {
    const menuCtx = { bodyWritable: true, inTable: false, tableInsertable: true } as unknown as CommandMenuContext

    function setup(overrides: Partial<Parameters<typeof registerQuickNotesCommands>[2]> = {}) {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const { store } = fakeStore()
        const deps = {
            store: () => store,
            openConcept: vi.fn(),
            onError: vi.fn(),
            onMoved: vi.fn(),
            today: () => '2026-09-17',
            dayOf: day,
            ...overrides,
        }
        registerQuickNotesCommands(commands, contributions, deps)
        return { commands, contributions, deps }
    }

    it('offers the Command Menu row only while there are notes to move', () => {
        const { contributions } = setup()
        const titles = () => listCommandMenuItems(contributions, menuCtx).map((i) => i.id)
        setQuickNotes([], { add: vi.fn(), remove: vi.fn() })
        expect(titles()).not.toContain(QUICK_NOTES_MOVE)
        setQuickNotes([note('a', 'x', 1)], { add: vi.fn(), remove: vi.fn() })
        expect(titles()).toContain(QUICK_NOTES_MOVE)
    })

    it("opens today's entry after a successful move and reports how many moved", async () => {
        const { commands, deps } = setup()
        setQuickNotes([note('a', 'x', 200)], { add: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) })
        await commands.execute(QUICK_NOTES_MOVE)
        expect(deps.openConcept).toHaveBeenCalledWith('2026-09-17')
        expect(deps.onMoved).toHaveBeenCalledWith(1)
        expect(deps.onError).not.toHaveBeenCalled()
    })

    it('reports a refused write through onError and opens nothing', async () => {
        const { commands, deps } = setup({
            store: () => {
                const { store } = fakeStore()
                store.createJournal = async () => {
                    throw new Error('The folder is read-only.')
                }
                store.open = () => {
                    throw new Error('not found')
                }
                return store
            },
        })
        setQuickNotes([note('a', 'x', 200)], { add: vi.fn(), remove: vi.fn() })
        await commands.execute(QUICK_NOTES_MOVE)
        expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('Could not move quick notes'))
        expect(deps.openConcept).not.toHaveBeenCalled()
    })

    it('refuses when the store cannot create documents', async () => {
        const { commands, deps } = setup({ store: () => ({ open: () => { throw new Error('no') } }) })
        setQuickNotes([note('a', 'x', 200)], { add: vi.fn(), remove: vi.fn() })
        await commands.execute(QUICK_NOTES_MOVE)
        expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('Could not move quick notes'))
    })
})
