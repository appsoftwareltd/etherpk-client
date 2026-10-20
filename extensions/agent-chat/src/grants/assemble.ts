/**
 * What a turn's [[Context Grant]] puts in front of the model, read at the moment the person sends,
 * so edits since the last turn count (ADR 0147):
 *
 * - Nothing: no document.
 * - Block siblings and ancestors: the outline around the bullet the chat is open on, as the Client
 *   reads it from the editor (`InlinePanel.outline`): the bullet's ancestors, and its siblings with
 *   what is under them. It is sent only while the home document can be read, so a document
 *   protected since is never sent from an outline taken before.
 * - This document: the home document's current text.
 * - This document and its links, and The whole graph: that, and every document the home document
 *   links to directly, whole, while they fit a budget. One that does not fit is left out and named,
 *   rather than cut short, so the model is never handed half a document without knowing. Under the
 *   whole graph the model reads further through its tools (`tools.ts`).
 *
 * Protected documents never reach this far: `context.documents` leaves them out, name and all.
 */
import type { ExtensionDocuments } from '@appsoftwareltd/etherpk-extension-api'

import type { GrantLevel } from '../chat/model'

/** Characters of linked documents one turn sends at most, about 30,000 tokens. */
export const LINKS_BUDGET = 120_000

export interface ContextDocument {
    name: string
    text: string
    /** The reader cut the document at its own cap. */
    truncated: boolean
    /** Only part of the document: the outline around the chat's bullet. */
    excerpt?: true
}

export interface AssembledContext {
    documents: ContextDocument[]
    /** The names of the documents sent, the home document first. */
    included: string[]
    /** Linked documents not sent, and why. */
    leftOut: { name: string; reason: string }[]
    /**
     * The home document could not be read: deleted, protected since, or never written. Also true
     * for a chat without a document, which has no home to read.
     */
    homeMissing: boolean
}

export async function assembleContext(grant: GrantLevel, home: string | null, documents: ExtensionDocuments, budget = LINKS_BUDGET, block: string | null = null): Promise<AssembledContext> {
    const context: AssembledContext = { documents: [], included: [], leftOut: [], homeMissing: false }
    if (grant === 'nothing') return context
    const own = home === null ? null : await documents.read(home)
    if (!own) {
        context.homeMissing = true
        return context
    }
    if (grant === 'block') {
        if (block === null) return context
        context.documents.push({ name: own.name, text: block, truncated: false, excerpt: true })
        context.included.push(own.name)
        return context
    }
    context.documents.push({ name: own.name, text: own.text, truncated: own.truncated })
    context.included.push(own.name)
    if (grant === 'document') return context
    let left = budget
    for (const name of (await documents.links(own.name)) ?? []) {
        const linked = await documents.read(name)
        if (!linked) continue
        if (linked.text.length > left) {
            context.leftOut.push({ name: linked.name, reason: 'too long' })
            continue
        }
        left -= linked.text.length
        context.documents.push({ name: linked.name, text: linked.text, truncated: linked.truncated })
        context.included.push(linked.name)
    }
    return context
}
