/**
 * Building a {@link RenamePlan} from the graph's concepts - pure, so the whole cascade is
 * unit-testable without either backend.
 *
 * Both stores compute their plan here and then apply it, so the impact the dialog shows and
 * the work that actually happens come from one source.
 */

import { frontmatterIdentity } from '$lib/document/frontmatter/identity'
import { cascadeFor } from '$lib/document/wikilink/rename'
import { conceptKey } from './fs/identity'
import { type RenamePlan, type RenameStep, renameRefusal, renameSteps } from './rename'

export interface PlanRenameInput {
    from: string
    to: string
    /** Every concept in the graph that has a document behind it. */
    concepts: readonly string[]
    /** Every alias in the graph, with the concept of the document it names. */
    aliases?: readonly { name: string; concept: string }[]
    /** The kind of the document being renamed, or null when the concept has none (ADR 0064). */
    kind: 'journal' | 'page' | null
    /** Documents whose BODY references `from` at the top level. */
    referencingDocuments: number
}

export function planRename(input: PlanRenameInput): RenamePlan {
    const from = input.from.trim()
    const to = input.to.trim()

    const refusal = renameRefusal({ from, to, kind: input.kind })
    const hasDocument = input.kind !== null
    const direct: RenameStep = { from, to, hasDocument, merges: false, redirects: false, into: to }
    if (refusal) {
        return { direct, cascade: [], referencingDocuments: input.referencingDocuments, refusal }
    }

    // Which document answers to a name - by title, or by alias - so a step can tell whether
    // its target is already taken, and by whom.
    const existing = new Map(input.concepts.map((c) => [conceptKey(c), c]))
    for (const alias of input.aliases ?? []) {
        if (!existing.has(conceptKey(alias.name))) existing.set(conceptKey(alias.name), alias.concept)
    }

    const cascade = cascadeFor(input.concepts, from, to)
        // Deepest first: a shallower concept must never be renamed onto a name that a deeper
        // step is still about to vacate.
        .sort((a, b) => depthOf(b.from) - depthOf(a.from))
        // The cascade is computed over documented concepts, so every step here has one.
        .map<RenameStep>((step) => stepFor(step.from, step.to, true, existing))

    return {
        direct: stepFor(from, to, hasDocument, existing),
        cascade,
        referencingDocuments: input.referencingDocuments,
        refusal: null,
    }
}

/**
 * A [[Protected Document]] never merges (ADR 0062): not into another document, and nothing into
 * it. Joining bodies would put a cipher fence beside readable text - which is "not the entire
 * body", so the result is no longer protected, shows the ciphertext as an ordinary code block,
 * and on a Filesystem Backend has just written the other document's plaintext into a file that
 * used to hold only ciphertext. Refused, not worked around: there is no join that keeps both
 * documents' guarantees.
 *
 * Both stores call this after planning, with their own way of reading a concept's stored text.
 * Only the endpoints of merging steps are asked about, so a plan with no collision - the common
 * case, and the one previewed on every keystroke in the dialog - reads nothing.
 */
export async function refuseProtectedMerges(
    plan: RenamePlan,
    isProtected: (concept: string) => Promise<boolean> | boolean,
): Promise<RenamePlan> {
    if (plan.refusal) return plan
    for (const step of renameSteps(plan)) {
        if (!step.merges) continue
        if (await isProtected(step.into)) {
            return {
                ...plan,
                refusal: `“${step.into}” is a protected document, so nothing can be merged into it. Choose a different name.`,
            }
        }
        if (await isProtected(step.from)) {
            return {
                ...plan,
                refusal: `“${step.from}” is a protected document, so it cannot be merged into “${step.to}”. Choose a name that is not already taken.`,
            }
        }
    }
    return plan
}

/**
 * Refuse a plan whose steps would rewrite a [[Frontmatter]] block that does not parse. A
 * Filesystem Backend rebuilds each renamed document's block, and a merge survivor's, from its
 * parsed data, which is empty for such a block, so every key it holds would be lost from the file:
 * the only copy. `textOf` gives a document's current text (an open buffer, else its file), or
 * null for a name with no document behind it.
 */
export async function refuseUnreadableBlocks(
    plan: RenamePlan,
    textOf: (concept: string) => Promise<string | null>,
): Promise<RenamePlan> {
    if (plan.refusal) return plan
    for (const step of renameSteps(plan)) {
        for (const concept of step.merges ? [step.from, step.into] : [step.from]) {
            const text = await textOf(concept)
            if (text === null || frontmatterIdentity(text).readable) continue
            return { ...plan, refusal: unreadableBlockRefusal(plan.direct.from, concept) }
        }
    }
    return plan
}

/** Why `renamed` cannot be renamed: the block of `unreadable` (itself, or a page the rename rewrites) does not parse. */
export function unreadableBlockRefusal(renamed: string, unreadable: string): string {
    const fix = 'Fix the block (a property written twice, or a line left half typed) and rename again.'
    if (conceptKey(renamed) === conceptKey(unreadable)) {
        return `“${renamed}” cannot be renamed while its frontmatter is not valid YAML: renaming rewrites the block, and what it holds would be lost. ${fix}`
    }
    return `“${renamed}” cannot be renamed while the frontmatter of “${unreadable}”, which the rename rewrites, is not valid YAML: what it holds would be lost. ${fix}`
}

/**
 * A step merges when a DIFFERENT document already answers to the target name - by title or by
 * alias - and the source has a document to join to it. Renaming onto yourself (a pure
 * re-casing, or onto one of your own aliases) is neither. A source with no document landing
 * on a taken name redirects: its links come to point at the page that already answers to it
 * (ADR 0064 §2). `into` is that page's own title.
 */
function stepFor(from: string, to: string, hasDocument: boolean, existing: Map<string, string>): RenameStep {
    const holder = existing.get(conceptKey(to))
    const taken = holder !== undefined && conceptKey(holder) !== conceptKey(from)
    return {
        from,
        to,
        hasDocument,
        merges: taken && hasDocument,
        redirects: taken && !hasDocument,
        into: taken ? holder : to,
    }
}

/** Nesting depth of a concept - `[[[[A]] B]] C` is deeper than `[[A]] B`. */
function depthOf(concept: string): number {
    let depth = 0
    let max = 0
    for (let i = 0; i < concept.length - 1; i++) {
        if (concept[i] === '[' && concept[i + 1] === '[') {
            depth += 1
            max = Math.max(max, depth)
            i += 1
        } else if (concept[i] === ']' && concept[i + 1] === ']') {
            depth -= 1
            i += 1
        }
    }
    return max
}
