import { describe, expect, it, vi } from 'vitest'

import { asksSomething, createLinkRenameController } from './link-rename-controller'

describe('link rename controller (ADR 0065, amended 2026-10-03)', () => {
    it('proposes only while the old concept still exists elsewhere', async () => {
        const promptRenames = vi.fn().mockResolvedValue(undefined)
        const conceptMoved = vi.fn().mockResolvedValue(undefined)
        const controller = createLinkRenameController({
            sameDocument: () => false,
            existsElsewhere: async (_target, before) => before === 'Shared',
            promptRenames,
            conceptMoved,
        })
        await controller.edited('Notes', [{ before: 'Lonely', after: 'New' }])
        expect(promptRenames).not.toHaveBeenCalled()
        // The concept moved with its only link: whatever was keyed by the old name follows.
        expect(conceptMoved).toHaveBeenCalledWith('Lonely', 'New')
        await controller.edited('Notes', [{ before: 'Shared', after: 'New' }])
        expect(promptRenames).toHaveBeenCalledWith('Notes', [{ before: 'Shared', after: 'New' }])
    })

    it('asks about every rename of one edit in one prompt, in order, and moves the rest at once', async () => {
        const calls: string[] = []
        const controller = createLinkRenameController({
            sameDocument: () => false,
            existsElsewhere: async (_target, before) => before !== 'Lonely',
            promptRenames: async (_target, renames) => {
                calls.push(`ask ${renames.map((r) => r.before).join(', ')}`)
            },
            conceptMoved: async (before) => {
                calls.push(`move ${before}`)
            },
        })
        await controller.edited('Notes', [
            { before: 'Planning [[Garden]]', after: 'Budgeting [[Gardens]]' },
            { before: 'Lonely', after: 'Lonely Two' },
            { before: 'Garden', after: 'Gardens' },
        ])
        // A move is not a rename (nothing in the dialog changes it), so it does not wait for one.
        expect(calls).toEqual(['move Lonely', 'ask Planning [[Garden]], Garden'])
    })

    // Editing a link to another name of the page it names (its title, or another of its aliases)
    // only chooses which name this link uses: it still reaches the same page, so nothing is renamed
    // and nothing moves (ADR 0065, amended 2026-10-04).
    it('proposes nothing when the new name is another name of the same page', async () => {
        const promptRenames = vi.fn()
        const conceptMoved = vi.fn()
        const existsElsewhere = vi.fn().mockResolvedValue(true)
        const names = ['JS', 'JavaScript', 'ECMAScript']
        const controller = createLinkRenameController({
            sameDocument: (before, after) => names.includes(before) && names.includes(after),
            existsElsewhere,
            promptRenames,
            conceptMoved,
        })
        await controller.edited('Notes', [
            { before: 'JS', after: 'JavaScript' },
            { before: 'JS', after: 'ECMAScript' },
        ])
        expect(existsElsewhere).not.toHaveBeenCalled()
        expect(promptRenames).not.toHaveBeenCalled()
        expect(conceptMoved).not.toHaveBeenCalled()
    })

    it('asks nothing for an emptied link', async () => {
        const promptRenames = vi.fn()
        const existsElsewhere = vi.fn().mockResolvedValue(true)
        const controller = createLinkRenameController({
            sameDocument: () => false, existsElsewhere, promptRenames, conceptMoved: vi.fn() })
        await controller.edited('Notes', [{ before: 'Shared', after: '   ' }])
        expect(existsElsewhere).not.toHaveBeenCalled()
        expect(promptRenames).not.toHaveBeenCalled()
    })

    it('asks nothing when trimming makes the new name the old one, and offers the trimmed name otherwise', async () => {
        // A space typed at the end of a link's text: the episode reports `Test` → `Test `, the
        // name the dialog would offer is the trimmed one, and that is the name it already has.
        // Asking would offer a rename to the unchanged name (live, 2026-09-18).
        const promptRenames = vi.fn().mockResolvedValue(undefined)
        const conceptMoved = vi.fn()
        const existsElsewhere = vi.fn().mockResolvedValue(true)
        const controller = createLinkRenameController({
            sameDocument: () => false, existsElsewhere, promptRenames, conceptMoved })
        await controller.edited('Notes', [
            { before: '[[Test]] [[Test]]', after: '[[Test]] [[Test]] ' },
            { before: 'Test', after: ' Test' },
        ])
        expect(existsElsewhere).not.toHaveBeenCalled()
        expect(promptRenames).not.toHaveBeenCalled()
        expect(conceptMoved).not.toHaveBeenCalled()
        await controller.edited('Notes', [{ before: 'Test', after: 'Test Two ' }])
        expect(promptRenames).toHaveBeenCalledWith('Notes', [{ before: 'Test', after: 'Test Two' }])
    })

    it('queues a second edit in the same document behind the first prompt', async () => {
        let answerFirst: () => void = () => {}
        const promptRenames = vi
            .fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => (answerFirst = resolve)))
            .mockResolvedValue(undefined)
        const controller = createLinkRenameController({
            sameDocument: () => false, existsElsewhere: async () => true, promptRenames, conceptMoved: vi.fn() })
        const first = controller.edited('Notes', [{ before: 'A', after: 'B' }])
        const second = controller.edited('Notes', [{ before: 'C', after: 'D' }])
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptRenames).toHaveBeenCalledTimes(1)
        answerFirst()
        await first
        await second
        expect(promptRenames).toHaveBeenCalledTimes(2)
        expect(promptRenames).toHaveBeenLastCalledWith('Notes', [{ before: 'C', after: 'D' }])
    })
})

describe('asksSomething: whether a proposed rename has anything to ask', () => {
    const never = () => false
    it('asks for a real change of name', () => {
        expect(asksSomething({ before: 'Garden', after: 'Gardens' }, never)).toBe(true)
    })

    it('asks nothing for an empty name, padding alone, or another name of the same page', () => {
        expect(asksSomething({ before: 'Garden', after: '  ' }, never)).toBe(false)
        expect(asksSomething({ before: ' ', after: 'Garden' }, never)).toBe(false)
        expect(asksSomething({ before: 'Garden', after: 'Garden ' }, never)).toBe(false)
        expect(asksSomething({ before: 'JS', after: 'JavaScript' }, (before, after) => before === 'JS' && after === 'JavaScript')).toBe(false)
    })
})
