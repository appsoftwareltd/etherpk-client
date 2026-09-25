import { describe, expect, it, vi } from 'vitest'

import { createLinkRenameController } from './link-rename-controller'

describe('link rename controller (ADR 0065)', () => {
    it('proposes only while the old concept still exists elsewhere', async () => {
        const promptRename = vi.fn().mockResolvedValue('New')
        const conceptMoved = vi.fn().mockResolvedValue(undefined)
        const controller = createLinkRenameController({
            existsElsewhere: async (_target, before) => before === 'Shared',
            promptRename,
            conceptMoved,
        })
        await controller.edited('Notes', 'Lonely', 'New')
        expect(promptRename).not.toHaveBeenCalled()
        // The concept moved with its only link: whatever was keyed by the old name follows.
        expect(conceptMoved).toHaveBeenCalledWith('Lonely', 'New')
        await controller.edited('Notes', 'Shared', 'New')
        expect(promptRename).toHaveBeenCalledWith('Notes', 'Shared', 'New')
    })

    it('asks nothing for a structural edit or an emptied link', async () => {
        const promptRename = vi.fn()
        const existsElsewhere = vi.fn().mockResolvedValue(true)
        const controller = createLinkRenameController({ existsElsewhere, promptRename, conceptMoved: vi.fn() })
        await controller.edited('Notes', 'Shared', null)
        await controller.edited('Notes', 'Shared', '   ')
        expect(existsElsewhere).not.toHaveBeenCalled()
        expect(promptRename).not.toHaveBeenCalled()
    })

    it('asks nothing when trimming makes the new name the old one', async () => {
        // A space typed at the end of a link's text: the episode reports `Test` → `Test `, the
        // name the dialog would offer is the trimmed one, and that is the name it already has.
        // Asking would open a dialog whose input refuses the unchanged name (live, 2026-09-18).
        const promptRename = vi.fn()
        const conceptMoved = vi.fn()
        const existsElsewhere = vi.fn().mockResolvedValue(true)
        const controller = createLinkRenameController({ existsElsewhere, promptRename, conceptMoved })
        await controller.edited('Notes', '[[Test]] [[Test]]', '[[Test]] [[Test]] ')
        await controller.edited('Notes', 'Test', ' Test')
        expect(existsElsewhere).not.toHaveBeenCalled()
        expect(promptRename).not.toHaveBeenCalled()
        expect(conceptMoved).not.toHaveBeenCalled()
    })

    it('queues a second edit in the same document behind the first dialog', async () => {
        let resolveFirst: (value: string | null) => void = () => {}
        const promptRename = vi
            .fn()
            .mockImplementationOnce(() => new Promise<string | null>((resolve) => (resolveFirst = resolve)))
            .mockResolvedValue(null)
        const controller = createLinkRenameController({ existsElsewhere: async () => true, promptRename, conceptMoved: vi.fn() })
        const first = controller.edited('Notes', 'A', 'B')
        const second = controller.edited('Notes', 'C', 'D')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(promptRename).toHaveBeenCalledTimes(1)
        resolveFirst(null)
        await first
        await second
        expect(promptRename).toHaveBeenCalledTimes(2)
        expect(promptRename).toHaveBeenLastCalledWith('Notes', 'C', 'D')
    })
})
