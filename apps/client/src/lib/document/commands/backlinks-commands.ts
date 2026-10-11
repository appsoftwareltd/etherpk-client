/**
 * The Commands for the [[Backlink]]s beneath every document (ADR 0135), and their `/` rows:
 *
 * - **Backlinks below documents: hide** or **show** (`backlinks.belowDocuments`): the collapse
 *   setting, one for every document, per graph on this device. One row at a time, naming the
 *   change it makes, as spell check's rows do.
 * - **Go to backlinks** (`backlinks.goToBelowDocument`): expand the section beneath the document
 *   being edited, scroll it to the top and focus its header. The keyboard's way into it, since
 *   Tab in the text indents. With nothing linking to the document there is no section, and the
 *   status says so; the caret stays where it is.
 *
 * No default keys: Alt+B already reaches the same references in the Backlinks panel.
 */

import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '$lib/surface'

import { getActiveEditorView } from '../active-editor'
import type { BacklinksPreferencesStore } from '../backlinks-preferences'
import { goToDocumentBacklinks } from '../view/document-backlinks'
import { editorDocument } from '../view/editor-document'

export const BACKLINKS_BELOW_DOCUMENTS = 'backlinks.belowDocuments'
export const BACKLINKS_GO_TO_BELOW_DOCUMENT = 'backlinks.goToBelowDocument'

/** Where Go to backlinks went: the editor's document, and whether its section was there to reach. */
export interface SectionVisit {
    concept: string | null
    reached: boolean
}

export interface BacklinksCommandDeps {
    /** The graph's backlinks preferences; absent outside a graph, where no row is offered. */
    preferences: () => BacklinksPreferencesStore | undefined
    /** Show a status message (the workspace's notice rail). */
    notify: (text: string) => void
    /** Bring the active editor's section into view; the real one unless a test stands in. */
    goToSection?: (expand: () => void) => Promise<SectionVisit>
}

/** The active editor's section, expanded, at the top of its scroller, its header focused. */
async function goToActiveSection(expand: () => void): Promise<SectionVisit> {
    const view = getActiveEditorView()
    if (!view) return { concept: null, reached: false }
    const concept = view.state.facet(editorDocument)?.concept ?? null
    return { concept, reached: await goToDocumentBacklinks(view, expand) }
}

function collapsedArg(arg: unknown): boolean | undefined {
    const collapsed = (arg as { collapsed?: unknown } | undefined)?.collapsed
    return typeof collapsed === 'boolean' ? collapsed : undefined
}

export function registerBacklinksCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: BacklinksCommandDeps,
): () => void {
    const goToSection = deps.goToSection ?? goToActiveSection
    const collapsed = () => deps.preferences()?.get().collapsedBelowDocuments
    const offs = [
        commands.register(BACKLINKS_BELOW_DOCUMENTS, (arg) => {
            const wanted = collapsedArg(arg)
            if (wanted !== undefined) deps.preferences()?.set({ collapsedBelowDocuments: wanted })
        }),
        commands.register(BACKLINKS_GO_TO_BELOW_DOCUMENT, async () => {
            const visit = await goToSection(() => deps.preferences()?.set({ collapsedBelowDocuments: false }))
            if (visit.concept !== null && !visit.reached) deps.notify(`Nothing links to ${visit.concept} yet.`)
        }),
        // Not gated on `bodyWritable`: none of these writes to a document, so they stay on a
        // locked Protected Document, whose backlinks are other documents' text.
        registerCommandMenuItem(contributions, {
            id: 'backlinks.goToBelowDocument',
            title: 'Go to backlinks',
            detail: 'Show what links to this document, below its text',
            icon: 'backlinks',
            group: 'Navigate',
            order: 12,
            keywords: ['references', 'linked', 'mentions'],
            when: () => deps.preferences() !== undefined,
            command: BACKLINKS_GO_TO_BELOW_DOCUMENT,
        }),
        registerCommandMenuItem(contributions, {
            id: 'backlinks.hideBelowDocuments',
            title: 'Backlinks below documents: hide',
            detail: 'Show only the Backlinks heading below every document',
            icon: 'backlinks',
            group: 'Editor',
            order: 175,
            keywords: ['references', 'collapse', 'clean'],
            when: () => collapsed() === false,
            command: BACKLINKS_BELOW_DOCUMENTS,
            args: { collapsed: true },
        }),
        registerCommandMenuItem(contributions, {
            id: 'backlinks.showBelowDocuments',
            title: 'Backlinks below documents: show',
            detail: 'List the backlinks below every document',
            icon: 'backlinks',
            group: 'Editor',
            order: 175,
            keywords: ['references', 'expand'],
            when: () => collapsed() === true,
            command: BACKLINKS_BELOW_DOCUMENTS,
            args: { collapsed: false },
        }),
    ]
    return () => {
        for (const off of offs) off()
    }
}
