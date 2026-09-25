/**
 * What a document's [[Frontmatter]] proposes about its identity, as a list of steps (ADR 0061).
 *
 * Computed when an editing episode ends, against the registry as it stands then - not against
 * the text as it was when the episode began - so typing a title and changing it back proposes
 * nothing, and a block that already agrees with the registry proposes nothing.
 *
 * The steps come out in the order they must run: silent ones first, confirmed ones after, so the
 * rename cascade sees the aliases the user just wrote. A cancel reverts only its own step. A
 * future property with its own confirmation is one more step kind here and one more row in
 * `FRONTMATTER_PROPERTIES`; the sequencing belongs to the caller and needs no change.
 */
import { frontmatterIdentity, normaliseAliases, sameAliases } from './identity'

export type Backend = 'filesystem' | 'server'

/** The document's identity as the registry has it. */
export interface RegistryIdentity {
    kind: 'journal' | 'page'
    concept: string
    aliases: readonly string[]
}

export type ProposalStep =
    | { property: 'aliases'; policy: 'silent'; from: string[]; to: string[] }
    | { property: 'title'; policy: 'confirm'; from: string; to: string }

export interface ProposalInput {
    /** The document's text as the editor holds it - for a Protected Document, the projection. */
    text: string
    registry: RegistryIdentity
    backend: Backend
    /**
     * The file's name without `.md`, on a Filesystem Backend. A block with no `title` names the
     * file there (ADR 0007), so removing the title is a proposal to be called after the file.
     */
    fileStem?: string
}

export function proposeFrontmatter(input: ProposalInput): ProposalStep[] {
    const claim = frontmatterIdentity(input.text)
    // No block is no claim - on a synced graph most documents never have one, and their
    // registry aliases are not up for clearing.
    if (!claim.hasBlock) return []

    const steps: ProposalStep[] = []
    const from = normaliseAliases(input.registry.aliases, input.registry.concept)
    const to = normaliseAliases(claim.aliases, input.registry.concept)
    if (!sameAliases(from, to)) steps.push({ property: 'aliases', policy: 'silent', from, to })

    // A journal entry is named by its date: a `title` there is kept as text and means nothing.
    if (input.registry.kind === 'page') {
        const title = claim.title?.trim() || null
        const target = title ?? (input.backend === 'filesystem' ? (input.fileStem ?? null) : null)
        if (target !== null && target !== input.registry.concept) {
            steps.push({ property: 'title', policy: 'confirm', from: input.registry.concept, to: target })
        }
    }
    return steps
}
