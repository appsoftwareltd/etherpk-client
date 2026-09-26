/**
 * Runs what a document's [[Frontmatter]] proposes (ADR 0061), step by step.
 *
 * The editor says only *when* - an editing episode in the block ended - and the store says only
 * *what* the registry holds. This is the piece between them: it computes the proposal against
 * the registry as it stands now, then runs the steps **in sequence**, silent ones first and
 * confirmed ones after, one dialog at a time. A cancel reverts only its own property: the title
 * goes back into the block, the aliases already applied stay applied. Confirming a rename closes
 * the document and reopens it under its new name, so the steps that follow are re-targeted rather
 * than lost. A second episode for the same document while one is running waits its turn - two
 * rename dialogs for one document is the thing this exists to prevent.
 *
 * Pure apart from its collaborators, so the sequencing is unit-tested without a workspace.
 */
import { type IdentityPatch, frontmatterIdentity } from '$lib/document/frontmatter/identity'
import { type Backend, type ProposalStep, type RegistryIdentity, proposeFrontmatter } from '$lib/document/frontmatter/proposal'
import type { EpisodeEnd } from '$lib/document/view/augmentations/frontmatter-episode'

/** A document's identity as the registry has it, plus what the proposal needs to read it. */
export interface DocumentIdentity extends RegistryIdentity {
    /** The file's name without `.md` on a Filesystem Backend; absent on a Server Backend. */
    fileStem?: string
}

export interface FrontmatterControllerDeps {
    backend(): Backend
    /** The document's text as the editor holds it - for a Protected Document, the projection. */
    textOf(target: string): string | null
    identityOf(target: string): DocumentIdentity | null
    applyAliases(target: string, aliases: readonly string[]): Promise<void>
    /** Rewrite the block through the store, so every editor showing the document sees it. */
    writeBack(target: string, patch: IdentityPatch): void
    /**
     * Open the rename dialog pre-filled with `initialName`. Resolves to the document's new
     * concept once renamed, or null if the user cancelled.
     */
    promptRename(concept: string, initialName: string): Promise<string | null>
}

export interface FrontmatterController {
    /**
     * An editing episode in the block ended: compute the proposal and run it. `end` says what
     * the editor knows of the episode; the mismatch mark's own Apply passes none.
     */
    episodeEnded(target: string, end?: EpisodeEnd): Promise<void>
    /** Put the registry's identity back into the block - the mismatch indicator's "Restore". */
    restore(target: string): void
    /** What the block proposes right now, for the indicator. Empty when it agrees or has no block. */
    proposal(target: string): ProposalStep[]
}

export function createFrontmatterController(deps: FrontmatterControllerDeps): FrontmatterController {
    const running = new Map<string, Promise<void>>()
    /**
     * Documents whose block an episode created while it was still unreadable. Nothing was decided
     * then, and the next episode finds the block already there; it is still new until an episode
     * ends with it readable, or it is gone.
     */
    const createdUnread = new Set<string>()

    function proposal(target: string, end?: EpisodeEnd): ProposalStep[] {
        const text = deps.textOf(target)
        const registry = deps.identityOf(target)
        if (text === null || !registry) return []
        return proposeFrontmatter({ text, registry, backend: deps.backend(), fileStem: registry.fileStem, blockIsNew: end?.blockIsNew })
    }

    /**
     * A block the episode created without an `aliases` line made no claim about them, so the
     * proposal left the registry's alone. Written into the block now, as part of this person's
     * action on this device (ADR 0061), so the block agrees with the registry: otherwise the
     * mismatch mark would offer to clear them, and the next episode would.
     */
    function carryAliasesIntoNewBlock(target: string): void {
        // Only a Server Backend holds aliases outside any block. A local graph's listing reads them
        // from the last saved file, so it can still name ones the person just cut: the file decides.
        if (deps.backend() !== 'server') return
        const text = deps.textOf(target)
        const registry = deps.identityOf(target)
        if (text === null || !registry || registry.aliases.length === 0) return
        const claim = frontmatterIdentity(text)
        if (claim.hasBlock && claim.readable && !claim.hasAliasesKey) deps.writeBack(target, { aliases: registry.aliases })
    }

    /**
     * The episode's end, with a block created earlier but not yet read still counted as new. No
     * `end` is the mark's Apply, which asks for what the block says: never new.
     */
    function settleNewBlock(target: string, end?: EpisodeEnd): EpisodeEnd | undefined {
        const isNew = end !== undefined && (end.blockIsNew || createdUnread.has(target))
        const text = deps.textOf(target)
        const claim = text === null ? null : frontmatterIdentity(text)
        if (isNew && claim?.hasBlock && !claim.readable) createdUnread.add(target)
        else createdUnread.delete(target)
        return isNew ? { blockIsNew: true } : end
    }

    async function run(target: string, given?: EpisodeEnd): Promise<void> {
        const end = settleNewBlock(target, given)
        let current = target
        for (const step of proposal(target, end)) {
            if (step.property === 'aliases') {
                await deps.applyAliases(current, step.to)
                continue
            }
            const renamed = await deps.promptRename(current, step.to)
            if (renamed === null) deps.writeBack(current, { title: step.from })
            else current = renamed
        }
        if (end?.blockIsNew) carryAliasesIntoNewBlock(current)
    }

    return {
        episodeEnded(target, end) {
            const queued = (running.get(target) ?? Promise.resolve()).then(() => run(target, end))
            running.set(target, queued)
            return queued.finally(() => {
                if (running.get(target) === queued) running.delete(target)
            })
        },

        restore(target) {
            const identity = deps.identityOf(target)
            if (!identity) return
            deps.writeBack(target, {
                ...(identity.kind === 'page' ? { title: identity.concept } : {}),
                aliases: identity.aliases,
            })
        },

        proposal,
    }
}
