import { describe, expect, it, vi } from 'vitest'

import {
    createCommandRegistry,
    createContributionRegistry,
    listCommandMenuItems,
    listContextMenuItems,
} from '$lib/surface'

import {
    DOCUMENT_PROTECT,
    DOCUMENT_UNLOCK,
    DOCUMENT_UNPROTECT,
    PROTECT_DOCUMENT,
    PROTECTION_LOCK_NOW,
    PROTECTION_UNLOCK,
    UNPROTECT_DOCUMENT,
    lockNowAvailable,
    protectDocumentAvailable,
    registerProtectionCommands,
    unlockAvailable,
    unprotectDocumentAvailable,
} from './protection-commands'

type Deps = Parameters<typeof registerProtectionCommands>[2]

function setup(overrides: Partial<Deps> = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const deps = {
        isConfigured: () => true,
        isUnlocked: () => true,
        isProtected: () => false,
        lockNow: vi.fn(),
        promptUnlock: vi.fn(),
        promptProtect: vi.fn(),
        promptUnprotect: vi.fn(),
        // No active document by default, so the palette assertions about the lock rows stay
        // about the lock rows; the document rows have their own describe.
        activeConcept: () => null as string | null,
        isProtectable: () => true,
        onError: vi.fn(),
        ...overrides,
    }
    const dispose = registerProtectionCommands(commands, contributions, deps)
    const menuIds = () =>
        listContextMenuItems(contributions, { kind: 'document-row', concept: 'Bank' }).map((item) => item.id)
    const paletteIds = () => listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true }).map((item) => item.id)
    return { commands, contributions, deps, dispose, menuIds, paletteIds }
}

describe('lock now', () => {
    it('discards the key', async () => {
        const { commands, deps } = setup()

        await commands.execute(PROTECTION_LOCK_NOW)

        expect(deps.lockNow).toHaveBeenCalled()
    })

    it('is offered only when there is a key in memory to discard', () => {
        expect(lockNowAvailable({ isConfigured: () => true, isUnlocked: () => true })).toBe(true)
        expect(lockNowAvailable({ isConfigured: () => true, isUnlocked: () => false })).toBe(false)
        expect(lockNowAvailable({ isConfigured: () => false, isUnlocked: () => true })).toBe(false)
    })
})

describe('unlock', () => {
    it('opens the prompt', async () => {
        const { commands, deps } = setup()

        await commands.execute(PROTECTION_UNLOCK)

        expect(deps.promptUnlock).toHaveBeenCalled()
    })

    it('is offered only when a configured graph is locked', () => {
        expect(unlockAvailable({ isConfigured: () => true, isUnlocked: () => false })).toBe(true)
        expect(unlockAvailable({ isConfigured: () => true, isUnlocked: () => true })).toBe(false)
        expect(unlockAvailable({ isConfigured: () => false, isUnlocked: () => false })).toBe(false)
    })
})

describe('protecting a document', () => {
    it('prompts for the document the menu was opened on', async () => {
        const { commands, deps } = setup()

        await commands.execute(DOCUMENT_PROTECT, { kind: 'document-row', concept: 'Bank' })

        expect(deps.promptProtect).toHaveBeenCalledWith('Bank')
    })

    it('ignores a target that is not a document', async () => {
        const { commands, deps } = setup()

        await commands.execute(DOCUMENT_PROTECT, { kind: 'tab', panelId: 'p1' })

        expect(deps.promptProtect).not.toHaveBeenCalled()
    })

    it('offers Protect on an unprotected document and nothing else', () => {
        const { menuIds } = setup({ isProtected: () => false })

        expect(menuIds()).toContain(DOCUMENT_PROTECT)
        expect(menuIds()).not.toContain(DOCUMENT_UNPROTECT)
    })
})

describe('removing protection', () => {
    it('offers it on a protected document while unlocked', () => {
        const { menuIds } = setup({ isProtected: () => true, isUnlocked: () => true })

        expect(menuIds()).toContain(DOCUMENT_UNPROTECT)
        expect(menuIds()).not.toContain(DOCUMENT_PROTECT)
    })

    // Removing protection means decrypting, which a locked graph cannot do. Offering it would
    // produce a dialog whose only possible outcome is failure.
    it('does not offer it while locked', () => {
        const { menuIds } = setup({ isProtected: () => true, isUnlocked: () => false })

        expect(menuIds()).not.toContain(DOCUMENT_UNPROTECT)
    })
})

// A locked document's own menu — its tab, or its sidebar row — offers the way back in, so nobody
// has to hunt for the sidebar control or find the card's button under the fold.
describe('unlocking from a locked document’s menu', () => {
    it('offers Unlock on a protected document while locked, in place of Remove protection', () => {
        const { menuIds } = setup({ isProtected: () => true, isUnlocked: () => false })

        expect(menuIds()).toContain(DOCUMENT_UNLOCK)
        expect(menuIds()).not.toContain(DOCUMENT_UNPROTECT)
        expect(menuIds()).not.toContain(DOCUMENT_PROTECT)
    })

    it('does not offer it while unlocked, when Remove protection is the row', () => {
        const { menuIds } = setup({ isProtected: () => true })

        expect(menuIds()).not.toContain(DOCUMENT_UNLOCK)
        expect(menuIds()).toContain(DOCUMENT_UNPROTECT)
    })

    it('does not offer it on an unprotected document, whatever the lock state', () => {
        expect(setup({ isUnlocked: () => false }).menuIds()).not.toContain(DOCUMENT_UNLOCK)
    })

    it('does not offer it on a graph with no Protection Key', () => {
        const { menuIds } = setup({ isConfigured: () => false, isProtected: () => true, isUnlocked: () => false })

        expect(menuIds()).not.toContain(DOCUMENT_UNLOCK)
    })

    it('opens the one prompt, whichever document it came from', async () => {
        const { commands, deps } = setup({ isProtected: () => true, isUnlocked: () => false })

        await commands.execute(DOCUMENT_UNLOCK, { kind: 'document-tab', concept: 'Bank' })

        expect(deps.promptUnlock).toHaveBeenCalledTimes(1)
    })
})

describe('failures', () => {
    it('are surfaced rather than thrown at the menu', async () => {
        const onError = vi.fn()
        const { commands } = setup({
            onError,
            lockNow: () => {
                throw new Error('could not commit')
            },
        })

        await commands.execute(PROTECTION_LOCK_NOW)

        expect(onError).toHaveBeenCalledWith('could not commit')
    })
})

describe('disposal', () => {
    it('removes every menu row it added', () => {
        const { dispose, menuIds } = setup()

        dispose()

        expect(menuIds()).toEqual([])
    })
})

describe('the Command Menu rows', () => {
    // A lock you have to hunt for in a settings pane is one nobody uses when they stand up from
    // their desk, so Lock now has to be in the palette.
    it('offer Lock now on an unlocked, configured graph', () => {
        const { paletteIds } = setup({ isConfigured: () => true, isUnlocked: () => true })

        expect(paletteIds()).toContain(PROTECTION_LOCK_NOW)
        expect(paletteIds()).not.toContain(PROTECTION_UNLOCK)
    })

    it('offer Unlock on a locked, configured graph', () => {
        const { paletteIds } = setup({ isConfigured: () => true, isUnlocked: () => false })

        expect(paletteIds()).toContain(PROTECTION_UNLOCK)
        expect(paletteIds()).not.toContain(PROTECTION_LOCK_NOW)
    })

    // Lock and Unlock both presuppose a key. Protect-this-block deliberately does not:
    // it is how someone with no Protection Key meets protection at all.
    it('offer no lock controls on a graph with no Protection Key', () => {
        const { paletteIds } = setup({ isConfigured: () => false })

        expect(paletteIds()).not.toContain(PROTECTION_LOCK_NOW)
        expect(paletteIds()).not.toContain(PROTECTION_UNLOCK)
    })

})

describe('the Command Menu rows for the active document', () => {
    it('protect reaches the workspace for the active document', async () => {
        const { commands, deps } = setup({ activeConcept: () => 'Bank' })

        await commands.execute(PROTECT_DOCUMENT)

        expect(deps.promptProtect).toHaveBeenCalledWith('Bank')
    })

    it('remove protection reaches the workspace for the active document', async () => {
        const { commands, deps } = setup({ activeConcept: () => 'Bank', isProtected: () => true })

        await commands.execute(UNPROTECT_DOCUMENT)

        expect(deps.promptUnprotect).toHaveBeenCalledWith('Bank')
    })

    it('does nothing with no active document', async () => {
        const { commands, deps } = setup()

        await commands.execute(PROTECT_DOCUMENT)
        await commands.execute(UNPROTECT_DOCUMENT)

        expect(deps.promptProtect).not.toHaveBeenCalled()
        expect(deps.promptUnprotect).not.toHaveBeenCalled()
    })

    // The row is what a user with no Protection Key meets first, so it must be offered before
    // one exists — the workspace prompts for a passphrase on the way through.
    it('offers Protect on a graph that has never been protected', () => {
        const { paletteIds } = setup({ isConfigured: () => false, activeConcept: () => 'Bank' })

        expect(paletteIds()).toEqual([PROTECT_DOCUMENT])
    })

    it('offers exactly one of Protect / Remove protection, by the document’s state', () => {
        const plain = setup({ activeConcept: () => 'Bank' })
        expect(plain.paletteIds()).toContain(PROTECT_DOCUMENT)
        expect(plain.paletteIds()).not.toContain(UNPROTECT_DOCUMENT)

        const protectedDoc = setup({ activeConcept: () => 'Bank', isProtected: () => true })
        expect(protectedDoc.paletteIds()).toContain(UNPROTECT_DOCUMENT)
        expect(protectedDoc.paletteIds()).not.toContain(PROTECT_DOCUMENT)
    })

    it('withholds both while a configured graph is locked, since either needs the key', () => {
        const { paletteIds } = setup({ isUnlocked: () => false, activeConcept: () => 'Bank' })
        expect(paletteIds()).not.toContain(PROTECT_DOCUMENT)

        const locked = setup({ isUnlocked: () => false, activeConcept: () => 'Bank', isProtected: () => true })
        expect(locked.paletteIds()).not.toContain(UNPROTECT_DOCUMENT)
    })

    it('never offers Protect for a journal entry', () => {
        const { paletteIds, menuIds } = setup({ activeConcept: () => '2026-09-07', isProtectable: () => false })
        expect(paletteIds()).not.toContain(PROTECT_DOCUMENT)
        expect(menuIds()).not.toContain(DOCUMENT_PROTECT)
    })

    it('exposes the predicates the sidebar and menus share', () => {
        const base = {
            isConfigured: () => true,
            isUnlocked: () => true,
            isProtected: () => false,
            isProtectable: () => true,
            activeConcept: () => 'Bank',
        }
        expect(protectDocumentAvailable(base)).toBe(true)
        expect(unprotectDocumentAvailable(base)).toBe(false)
        expect(unprotectDocumentAvailable({ ...base, isProtected: () => true })).toBe(true)
        expect(protectDocumentAvailable({ ...base, activeConcept: () => null })).toBe(false)
    })
})
