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
import { type IdentityPatch } from '$lib/document/frontmatter/identity'
import { type Backend, type ProposalStep, type RegistryIdentity, proposeFrontmatter } from '$lib/document/frontmatter/proposal'

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
    /** An editing episode in the block ended: compute the proposal and run it. */
    episodeEnded(target: string): Promise<void>
    /** Put the registry's identity back into the block - the mismatch indicator's "Restore". */
    restore(target: string): void
    /** What the block proposes right now, for the indicator. Empty when it agrees or has no block. */
    proposal(target: string): ProposalStep[]
}

export function createFrontmatterController(deps: FrontmatterControllerDeps): FrontmatterController {
    const running = new Map<string, Promise<void>>()

    function proposal(target: string): ProposalStep[] {
        const text = deps.textOf(target)
        const registry = deps.identityOf(target)
        if (text === null || !registry) return []
        return proposeFrontmatter({ text, registry, backend: deps.backend(), fileStem: registry.fileStem })
    }

    async function run(target: string): Promise<void> {
        let current = target
        for (const step of proposal(target)) {
            if (step.property === 'aliases') {
                await deps.applyAliases(current, step.to)
                continue
            }
            const renamed = await deps.promptRename(current, step.to)
            if (renamed === null) deps.writeBack(current, { title: step.from })
            else current = renamed
        }
    }

    return {
        episodeEnded(target) {
            const queued = (running.get(target) ?? Promise.resolve()).then(() => run(target))
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
