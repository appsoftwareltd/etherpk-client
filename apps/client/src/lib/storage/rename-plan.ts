/**
 * Building a {@link RenamePlan} from the graph's concepts - pure, so the whole cascade is
 * unit-testable without either backend.
 *
 * Both stores compute their plan here and then apply it, so the impact the dialog shows and
 * the work that actually happens come from one source.
 */

import { frontmatterIdentity } from '$lib/document/frontmatter/identity'
import { cascadeFor, rewriteWikilinkScope } from '$lib/document/wikilink/rename'
import { conceptKey } from './fs/identity'
import { type AliasRewrite, type RenameLinkStrategy, type RenamePlan, type RenameStep, renameRefusal, renameSteps } from './rename'

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
    // A name no document has as its title, but one has as an alias: the rename renames that alias,
    // on that document, and retitles nothing (ADR 0065, amended 2026-10-04). A page's own title
    // outranks another page's alias, so the caller's kind, read by title, decides first.
    const renamedAlias = input.kind === null ? (input.aliases ?? []).find((alias) => conceptKey(alias.name) === conceptKey(from)) : undefined
    const aliasOf = renamedAlias?.concept ?? null

    // An alias is a page's name, so it is refused what a page's title is: never a day.
    const refusal = renameRefusal({ from, to, kind: renamedAlias ? 'page' : input.kind })
    const hasDocument = input.kind !== null
    const direct: RenameStep = { from, to, hasDocument, merges: false, redirects: false, into: to }
    if (refusal) {
        return { direct, cascade: [], aliases: [], aliasOf, referencingDocuments: input.referencingDocuments, refusal }
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

    const plan: RenamePlan = {
        // A renamed alias moves no document: it stays on its holder under its new form, which is
        // the name the renamed concept goes by now.
        direct: renamedAlias ? direct : stepFor(from, to, hasDocument, existing),
        cascade,
        aliases: [],
        aliasOf,
        referencingDocuments: input.referencingDocuments,
        refusal: null,
    }
    const rewrites = aliasRewrites(plan, renamedAlias, input.aliases ?? [], existing)
    return 'refusal' in rewrites ? { ...plan, refusal: rewrites.refusal } : { ...plan, aliases: rewrites.aliases }
}

/**
 * The aliases the rename rewrites: the alias it names, when it names one (ADR 0065, amended
 * 2026-10-04), then every alias that names `from` as a scope, by the cascade's own rule, on
 * whatever document holds it (ADR 0038, amended 2026-10-03). A new form that a different document
 * will answer to refuses the rename: one another document already has, by title or alias; one a
 * title step of this same rename gives; or one another alias of this rename also becomes. Sharing
 * an alias does not make two documents one concept, and the name would go to whichever document a
 * lookup reached first.
 *
 * "Different" is judged on where each document ends up: a merge in the same rename makes two
 * documents one, so a parallel hierarchy merging into another, each page with its scoped alias,
 * is no collision. Nor is a re-casing (the name stays the same name), a form the holder itself
 * already has (the applier drops the duplicate), or one alias two documents already shared (the
 * rename carries that over rather than creating it).
 */
function aliasRewrites(
    plan: RenamePlan,
    renamed: { name: string; concept: string } | undefined,
    aliases: readonly { name: string; concept: string }[],
    existing: Map<string, string>,
): { aliases: AliasRewrite[] } | { refusal: string } {
    const steps = renameSteps(plan).filter((step) => step.hasDocument)
    // Where each document ends up: a title step moves it, and a merge joins it into another.
    const landed = new Map(steps.map((step) => [conceptKey(step.from), step.into]))
    const endsIn = (concept: string) => conceptKey(landed.get(conceptKey(concept)) ?? concept)
    // The names this rename's title steps give, and to which document (named as it is now).
    const given = new Map(steps.map((step) => [conceptKey(step.to), step.from]))
    // The new forms planned so far, to catch two different aliases becoming one name.
    const planned = new Map<string, { name: string; concept: string }>()
    const refuse = (alias: { name: string; concept: string }, to: string, why: string) => ({
        refusal: `“${alias.concept}” has the alias “${alias.name}”, which the rename would make “${to}”, but ${why}. Change one of the two names, then rename again.`,
    })
    // The renamed alias becomes the new name itself; a scoped one has the old name rewritten inside it.
    const candidates: { alias: { name: string; concept: string }; to: string }[] = renamed ? [{ alias: renamed, to: plan.direct.to }] : []
    for (const alias of aliases) {
        const rewritten = rewriteWikilinkScope(alias.name, plan.direct.from, plan.direct.to)
        if (rewritten.count > 0) candidates.push({ alias, to: rewritten.text })
    }
    const out: AliasRewrite[] = []
    for (const { alias, to } of candidates) {
        const key = conceptKey(to)
        if (key !== conceptKey(alias.name)) {
            const holder = endsIn(alias.concept)
            const owner = existing.get(key)
            if (owner !== undefined && endsIn(owner) !== holder) {
                if (alias === renamed) return { refusal: renamedAliasTaken(alias, to, owner) }
                return refuse(alias, to, `that is already a name of “${owner}”`)
            }
            const receiver = given.get(key)
            if (receiver !== undefined && endsIn(receiver) !== holder) return refuse(alias, to, `the rename gives that name to “${receiver}”`)
            const earlier = planned.get(key)
            if (earlier && endsIn(earlier.concept) !== holder && conceptKey(earlier.name) !== conceptKey(alias.name)) {
                return refuse(alias, to, `it would also make “${earlier.concept}”'s alias “${earlier.name}” that name`)
            }
            planned.set(key, alias)
        }
        out.push({ holder: alias.concept, from: alias.name, to })
    }
    return { aliases: out }
}

/**
 * Why an alias cannot be renamed to a name another document answers to. Not a merge, as a page's
 * rename onto a taken name is: the alias belongs to one page, and the other page keeps its name.
 */
function renamedAliasTaken(alias: { name: string; concept: string }, to: string, owner: string): string {
    const taken = conceptKey(owner) === conceptKey(to) ? `“${to}” is another page's name` : `“${to}” is already an alias of “${owner}”`
    return `${taken}, so “${alias.concept}”'s alias “${alias.name}” cannot be renamed to it. Choose another name, or keep the link as typed.`
}

/**
 * A holder's alias list after the rename (ADR 0038, amended 2026-10-03): under the rewrite arm
 * each rewritten alias is replaced in place, as the links that used it are rewritten; under the
 * alias arm the old form stays, since untouched links still say it, and the new form is added
 * after it. The caller normalises the result, which drops a new form the document already has.
 */
export function aliasesAfterRename(
    current: readonly string[],
    rewrites: readonly AliasRewrite[],
    strategy: RenameLinkStrategy,
): string[] {
    const next: string[] = []
    for (const alias of current) {
        const rewrite = rewrites.find((r) => conceptKey(r.from) === conceptKey(alias))
        if (!rewrite) next.push(alias)
        else if (strategy === 'rewrite') next.push(rewrite.to)
        else next.push(alias, rewrite.to)
    }
    return next
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
 * the only copy. `textOf` gives the text a step rewrites, or null for a name with no document
 * behind it. A document whose alias the rename rewrites has its block rewritten too, and
 * `holderTextOf` gives the text that write starts from (an open buffer, where a step's is the
 * file), defaulting to `textOf`.
 */
export async function refuseUnreadableBlocks(
    plan: RenamePlan,
    textOf: (concept: string) => Promise<string | null>,
    holderTextOf: (concept: string) => Promise<string | null> = textOf,
): Promise<RenamePlan> {
    if (plan.refusal) return plan
    const rewritten = renameSteps(plan).flatMap((step) => (step.merges ? [step.from, step.into] : [step.from]))
    const checks = [
        ...rewritten.map((concept) => [concept, textOf] as const),
        ...plan.aliases.map((alias) => [alias.holder, holderTextOf] as const),
    ]
    for (const [concept, read] of checks) {
        const text = await read(concept)
        if (text === null || frontmatterIdentity(text).readable) continue
        return { ...plan, refusal: unreadableBlockRefusal(plan.direct.from, concept) }
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
