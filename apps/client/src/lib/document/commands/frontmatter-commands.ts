/**
 * **Add frontmatter**, as [[Command]]s: a row on a document's [[Context Menu]] (its tab, or its
 * row in the Sidebar; long-press on a phone) and a [[Command Menu]] row for the active document,
 * which is the keyboard path to it.
 *
 * Both open the workspace's dialog, which lays out the keys EtherPK reads with values that
 * change nothing until they are edited (ADR 0108). This module decides when the action is
 * offered; what it writes is `document/frontmatter/add-frontmatter.ts`.
 */

import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    isDocumentTarget,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '$lib/surface'

/** Open the Add frontmatter dialog for the document a Context Menu targets. */
export const DOCUMENT_ADD_FRONTMATTER = 'document.addFrontmatter'
/** The same for the active document, from the Command Menu. */
export const ADD_FRONTMATTER_TO_ACTIVE = 'frontmatter.addToActiveDocument'

export interface FrontmatterCommandDeps {
    /**
     * Whether the action has anything to do for this document: a key it can use is missing, or
     * its block does not parse and the action should say so. False on a locked Protected
     * Document, whose text cannot be edited.
     */
    canAddFrontmatter: (concept: string) => boolean
    /** Open the dialog; the workspace owns it and the write. */
    promptAddFrontmatter: (concept: string) => void
    /** The document the user is working in, for the Command Menu row. Null when none is. */
    activeConcept: () => string | null
    onError?: (message: string) => void
}

function conceptOf(arg: unknown): string {
    const target = arg as ContextMenuTarget | undefined
    return target && isDocumentTarget(target) && typeof target.concept === 'string' ? target.concept : ''
}

export function registerFrontmatterCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: FrontmatterCommandDeps): () => void {
    const prompt = (concept: string) => {
        if (concept === '') return
        try {
            deps.promptAddFrontmatter(concept)
        } catch (err) {
            deps.onError?.((err as Error).message)
        }
    }

    const disposers = [
        commands.register(DOCUMENT_ADD_FRONTMATTER, (arg) => prompt(conceptOf(arg))),
        commands.register(ADD_FRONTMATTER_TO_ACTIVE, () => prompt(deps.activeConcept() ?? '')),
        registerContextMenuItem(contributions, {
            id: DOCUMENT_ADD_FRONTMATTER,
            label: 'Add frontmatter…',
            command: DOCUMENT_ADD_FRONTMATTER,
            // Beside Publish…, which writes two of the same keys.
            order: 26,
            when: (target) => isDocumentTarget(target) && deps.canAddFrontmatter(target.concept),
        }),
        registerCommandMenuItem(contributions, {
            id: ADD_FRONTMATTER_TO_ACTIVE,
            title: 'Add frontmatter',
            detail: 'Lay out the keys EtherPK reads at the top of this document',
            icon: 'frontmatter',
            group: 'Document',
            order: 170,
            keywords: ['frontmatter', 'properties', 'yaml', 'metadata', 'aliases', 'slug', 'public', 'publish'],
            command: ADD_FRONTMATTER_TO_ACTIVE,
            when: () => {
                const concept = deps.activeConcept()
                return concept !== null && deps.canAddFrontmatter(concept)
            },
        }),
    ]

    return () => {
        for (const dispose of disposers) dispose()
    }
}
