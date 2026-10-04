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
     * The block did not exist when the editing episode began: the person typed or pasted it. It
     * then claims nothing about aliases unless it has an `aliases` key, so typing `tags:` onto a
     * synced page whose aliases are in the registry and not yet shown does not clear them.
     */
    blockIsNew?: boolean
    /**
     * The block was there when the editing episode began and the person deleted it. On a Server
     * Backend that clears the aliases, as deleting a local file's block does (ADR 0061, amended
     * 2026-10-03).
     */
    blockRemoved?: boolean
    /**
     * The file's name without `.md`, on a Filesystem Backend. A block with no `title` names the
     * file there (ADR 0007), so removing the title is a proposal to be called after the file.
     */
    fileStem?: string
}

export function proposeFrontmatter(input: ProposalInput): ProposalStep[] {
    const claim = frontmatterIdentity(input.text)
    if (!claim.hasBlock) {
        // No block is no claim: a synced document without aliases need not have one, and nothing
        // it has not said is up for clearing. A block the person just deleted is the exception,
        // and clears the aliases it showed. On a local graph the saved file already has none.
        if (!input.blockRemoved || input.backend !== 'server') return []
        const from = normaliseAliases(input.registry.aliases, input.registry.concept)
        return from.length > 0 ? [{ property: 'aliases', policy: 'silent', from, to: [] }] : []
    }
    // Nor is a block whose YAML does not parse: most often a line is still being typed when the
    // episode ends. Its identity is unknown, not empty, so nothing is proposed until it parses.
    if (!claim.readable) return []

    const steps: ProposalStep[] = []
    // A block that existed before this episode and has no `aliases` key claims none: deleting
    // the line is how a person clears them. A block created in this episode has said nothing yet.
    const claimsAliases = claim.hasAliasesKey || !input.blockIsNew
    const from = normaliseAliases(input.registry.aliases, input.registry.concept)
    const to = normaliseAliases(claim.aliases, input.registry.concept)
    if (claimsAliases && !sameAliases(from, to)) steps.push({ property: 'aliases', policy: 'silent', from, to })

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
