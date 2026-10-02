/**
 * What a built-in [[Extension]] is handed when it registers: the surfaces it may fill and the
 * questions it may ask, and nothing more.
 *
 * Extension Architecture.md asks for "narrower facades" than the workspace's own service bridge
 * (`WorkspaceServices`, which holds the store, protection, sync and more). This is the first of
 * them, made for the [[Graph View]] and shaped so a later extension loader can hand the same
 * object to code it did not write:
 *
 * - the Contribution Points through `views` (View kinds) and `contributions` (menu rows),
 * - [[Command]]s and [[Event]]s,
 * - the open graph's [[Layout]], read when needed because a presenter can be rebuilt,
 * - read-only questions to the [[Derived Index]], never a document store.
 *
 * A context belongs to one open graph. The workspace builds it as the graph opens and disposes
 * what the extension registered when the graph closes.
 */
import type { ConceptCandidate } from '$lib/document/index-db'
import type { LinkGraph } from '$lib/document/index-link-graph'
import type { IndexUpdate } from '$lib/document/index-worker/client'
import type { LayoutController, ViewRegistry } from '$lib/layout'

import type { CommandRegistry } from './command-registry'
import type { ContributionRegistry } from './contribution-registry'
import type { EventBus } from './types'

/** The Derived Index questions an extension may ask. */
export interface ExtensionIndex {
    /** Synchronous: every concept the index knows, aliases and Pageless Concepts included. */
    allConcepts(): readonly ConceptCandidate[]
    /** A round trip: every concept and every pair a wikilink joins. */
    linkGraph(): Promise<LinkGraph>
    /** Called after each change the index commits. Returns the unsubscribe. */
    onUpdated(listener: (update: IndexUpdate) => void): () => void
}

export interface ExtensionContext {
    /** The extension's own id: the prefix of its View kinds and Command ids. */
    readonly extensionId: string
    readonly views: ViewRegistry
    readonly contributions: ContributionRegistry
    readonly commands: CommandRegistry
    readonly events: EventBus
    readonly index: ExtensionIndex
    /** The open graph's Layout, or undefined before a presenter has mounted. */
    layout(): LayoutController | undefined
    /** The document the user is working in, or null (active-document.ts). */
    activeDocument(): string | null
    /** True while the desktop presenter is showing (1024px and wider). */
    isDesktop(): boolean
}
