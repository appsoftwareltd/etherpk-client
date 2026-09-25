/**
 * Protection [[Command]]s: locking the graph now, protecting a document, and turning protection
 * back off.
 *
 * Commands rather than inline handlers for the same reason the document commands are — the
 * [[Context Menu]] and [[Command Menu]] stay presentation surfaces over one registry — but here
 * it also matters that **Lock now** is reachable from the Command Menu and a keybinding, because
 * a lock you have to hunt for in a settings pane is one nobody uses.
 *
 * Everything destructive or credential-bearing is delegated to the workspace, which owns the
 * dialogs: this module decides *when* an action is offered, never how it is confirmed.
 */

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    isDocumentTarget,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '$lib/surface'

export const PROTECTION_LOCK_NOW = 'protection.lockNow'
export const PROTECTION_UNLOCK = 'protection.unlock'
export const DOCUMENT_PROTECT = 'document.protect'
export const DOCUMENT_UNPROTECT = 'document.unprotect'
/** The unlock prompt, reached from a locked document's own context menu — its tab or its row. */
export const DOCUMENT_UNLOCK = 'document.unlock'
/** Palette rows acting on the ACTIVE document, where a context-menu target does not exist. */
export const PROTECT_DOCUMENT = 'protection.protectDocument'
export const UNPROTECT_DOCUMENT = 'protection.unprotectDocument'

function conceptOf(arg: unknown): string {
    const target = arg as ContextMenuTarget | undefined
    return target && isDocumentTarget(target) && typeof target.concept === 'string' ? target.concept : ''
}

export interface ProtectionCommandDeps {
    /** Whether this graph has a Protection Key at all. */
    isConfigured: () => boolean
    /** Whether the key is currently in memory. */
    isUnlocked: () => boolean
    /** Whether the named document is already protected. */
    isProtected: (concept: string) => boolean
    /** Discard the key now, after committing pending work (ADR 0058). */
    lockNow: () => void
    /** Open the unlock prompt — passphrase, or a bound passkey where one exists. */
    promptUnlock: () => void
    /**
     * Protect a document. The workspace prompts to set a passphrase first when the graph has no
     * Protection Key yet, which is the only moment the "there is no recovery" warning is shown.
     */
    promptProtect: (concept: string) => void
    /** Confirm and then decrypt a document back to ordinary readable content. */
    promptUnprotect: (concept: string) => void
    /** The document the user is working in, for the Command Menu rows. Null when none is. */
    activeConcept: () => string | null
    /** Whether a concept can be protected at all — only pages can, never journal entries. */
    isProtectable: (concept: string) => boolean
    onError?: (message: string) => void
}

export function registerProtectionCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: ProtectionCommandDeps,
): () => void {
    const disposers: (() => void)[] = []

    const run = (work: () => void) => {
        try {
            work()
        } catch (err) {
            deps.onError?.((err as Error).message)
        }
    }

    disposers.push(
        // Offered only when there is something to lock. A "Lock now" that does nothing teaches
        // people the control is decorative.
        commands.register(PROTECTION_LOCK_NOW, () => run(() => deps.lockNow())),
        commands.register(PROTECTION_UNLOCK, () => run(() => deps.promptUnlock())),
        commands.register(PROTECT_DOCUMENT, () => {
            const concept = deps.activeConcept()
            if (concept) run(() => deps.promptProtect(concept))
        }),
        commands.register(UNPROTECT_DOCUMENT, () => {
            const concept = deps.activeConcept()
            if (concept) run(() => deps.promptUnprotect(concept))
        }),
        commands.register(DOCUMENT_PROTECT, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') run(() => deps.promptProtect(concept))
        }),
        commands.register(DOCUMENT_UNPROTECT, (arg) => {
            const concept = conceptOf(arg)
            if (concept !== '') run(() => deps.promptUnprotect(concept))
        }),
        // Graph-wide, whichever document's menu it came from: the key is the unit (ADR 0058).
        commands.register(DOCUMENT_UNLOCK, () => run(() => deps.promptUnlock())),
    )

    // Command Menu rows. **Lock now** must be reachable without hunting through a settings pane,
    // because a lock you have to go looking for is one nobody uses when they stand up from a desk.
    // The `when` predicates read the live lock state rather than the menu context, so exactly one
    // of Lock / Unlock is ever offered and neither appears on an unprotected graph.
    disposers.push(
        registerCommandMenuItem(contributions, {
            id: PROTECTION_LOCK_NOW,
            title: 'Lock protected documents',
            detail: 'Discard the key on this device',
            icon: 'lock',
            group: 'Protection',
            keywords: ['lock', 'protect', 'secure', 'passphrase'],
            command: PROTECTION_LOCK_NOW,
            when: () => lockNowAvailable(deps),
        }),
        registerCommandMenuItem(contributions, {
            id: PROTECTION_UNLOCK,
            title: 'Unlock protected documents',
            icon: 'lock-open',
            group: 'Protection',
            keywords: ['unlock', 'protect', 'passphrase', 'passkey'],
            command: PROTECTION_UNLOCK,
            when: () => unlockAvailable(deps),
        }),
        // The keyboard path to protecting a page. Mirrors the context-menu rows' gating, read for
        // the active document: exactly one of the two is ever offered for it.
        registerCommandMenuItem(contributions, {
            id: PROTECT_DOCUMENT,
            title: 'Protect this document',
            detail: 'Encrypt this page under your passphrase',
            icon: 'lock',
            group: 'Protection',
            keywords: ['protect', 'encrypt', 'secret', 'password', 'document', 'page'],
            command: PROTECT_DOCUMENT,
            // Offered whether or not a key exists: the workspace prompts for a passphrase first
            // when there is none, which is how a user meets protection in the first place.
            when: () => protectDocumentAvailable(deps),
        }),
        registerCommandMenuItem(contributions, {
            id: UNPROTECT_DOCUMENT,
            title: 'Remove protection from this document',
            icon: 'lock-open',
            group: 'Protection',
            keywords: ['unprotect', 'remove protection', 'decrypt', 'document', 'page'],
            command: UNPROTECT_DOCUMENT,
            when: () => unprotectDocumentAvailable(deps),
        }),
    )

    disposers.push(
        registerContextMenuItem(contributions, {
            id: DOCUMENT_PROTECT,
            label: 'Protect…',
            command: DOCUMENT_PROTECT,
            order: 25,
            when: (target) =>
                isDocumentTarget(target) && deps.isProtectable(target.concept) && !deps.isProtected(target.concept),
        }),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_UNPROTECT,
            label: 'Remove protection…',
            command: DOCUMENT_UNPROTECT,
            order: 25,
            // Only offered while unlocked: removing protection means decrypting, and a locked
            // graph cannot. Offering it locked would produce a dialog that can only fail.
            when: (target) => isDocumentTarget(target) && deps.isProtected(target.concept) && deps.isUnlocked(),
        }),
        // The row a locked document offers instead: right-click the tab you are looking at and
        // get the passphrase prompt, rather than hunting for the sidebar control or the card.
        registerContextMenuItem(contributions, {
            id: DOCUMENT_UNLOCK,
            label: 'Unlock…',
            command: DOCUMENT_UNLOCK,
            order: 25,
            when: (target) =>
                isDocumentTarget(target) && deps.isConfigured() && deps.isProtected(target.concept) && !deps.isUnlocked(),
        }),
    )

    return () => {
        for (const dispose of disposers) dispose()
    }
}

/** Whether **Lock now** should appear in the Command Menu right now. */
export function lockNowAvailable(deps: Pick<ProtectionCommandDeps, 'isConfigured' | 'isUnlocked'>): boolean {
    return deps.isConfigured() && deps.isUnlocked()
}

/** Whether **Unlock** should appear in the Command Menu right now. */
export function unlockAvailable(deps: Pick<ProtectionCommandDeps, 'isConfigured' | 'isUnlocked'>): boolean {
    return deps.isConfigured() && !deps.isUnlocked()
}

/** Whether **Protect this document** should appear for the active document right now. */
export function protectDocumentAvailable(
    deps: Pick<ProtectionCommandDeps, 'isConfigured' | 'isUnlocked' | 'isProtected' | 'isProtectable' | 'activeConcept'>,
): boolean {
    const concept = deps.activeConcept()
    if (!concept || !deps.isProtectable(concept) || deps.isProtected(concept)) return false
    return deps.isConfigured() ? deps.isUnlocked() : true
}

/** Whether **Remove protection from this document** should appear right now. */
export function unprotectDocumentAvailable(
    deps: Pick<ProtectionCommandDeps, 'isUnlocked' | 'isProtected' | 'activeConcept'>,
): boolean {
    const concept = deps.activeConcept()
    return !!concept && deps.isProtected(concept) && deps.isUnlocked()
}
