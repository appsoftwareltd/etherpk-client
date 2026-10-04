/**
 * The renames one link edit proposes, asked together and run in turn (ADR 0065, amended
 * 2026-10-03). Pure, so the order and the previews are tested without a workspace; the dialog
 * (`LinkRenameDialog.svelte`) shows the rows and `GraphWorkspace.svelte` holds and runs them.
 *
 * The renames run outermost first, each with the names exactly as they were and as typed, so no
 * rename depends on another. An earlier rename can still take names a later one would otherwise
 * cascade into - renaming `Planning [[Garden]]` first moves that page before `Garden → Gardens` would
 * have retitled it - so each row's preview leaves those out, and each rename is planned afresh
 * just before it runs.
 */

import { frontmatterSpan } from '../../storage/fs/frontmatter-span'
import { conceptKey } from '../../storage/fs/identity'
import { type RenameLinkStrategy, renameSteps, type RenamePlan } from '../../storage/rename'
import { isScopedBy } from '../wikilink/rename'
import { wikilinkOccurrencesInSource } from '../wikilink/source'
import { renamesProposedByName, type WikilinkEdit } from './augmentations/wikilink-episode'

/** The keys of every concept a plan renames: the one named, and every scoped concept it cascades to. */
function namesRenamedBy(plan: RenamePlan): Set<string> {
    return new Set(renameSteps(plan).map((step) => conceptKey(step.from)))
}

/**
 * Each row's plan as the dialog previews it: a row's cascade leaves out the concepts a ticked
 * row above it renames first. A row with nothing left out keeps its plan as it is.
 */
export function previewPlans(rows: readonly { plan: RenamePlan | null; ticked: boolean }[]): (RenamePlan | null)[] {
    const taken = new Set<string>()
    return rows.map(({ plan, ticked }) => {
        if (!plan) return null
        const cascade = plan.cascade.filter((step) => !taken.has(conceptKey(step.from)))
        if (ticked) for (const name of namesRenamedBy(plan)) taken.add(name)
        return cascade.length === plan.cascade.length ? plan : { ...plan, cascade }
    })
}

/** Where a row of the dialog stands: not run yet, renamed, or failed (and then retried from). */
export type RunStatus = 'waiting' | 'done' | 'failed'

/** One rename in the dialog: what the link named and names now, its plan, and how its run went. */
export interface LinkRenameRow {
    /** The concept the link named. */
    before: string
    /** The name it has now: what was typed. */
    after: string
    /** What renaming it would do, or null while that is computed. */
    plan: RenamePlan | null
    /** The concept has no document, so there is no alias arm (ADR 0064). */
    pageless: boolean
    status: RunStatus
    /** Why the last attempt failed, when it did. */
    error: string | null
}

/** What the user chose for one row. */
export interface LinkRenameChoice {
    ticked: boolean
    strategy: RenameLinkStrategy
}

/**
 * Run the ticked rows that are not done yet, in order, stopping at the first failure: a later
 * rename may depend on the graph an earlier one leaves. `report` hears each outcome as it lands,
 * so the dialog can mark the row. Resolves true when every ticked row is done. A retry calls it
 * again with the same rows: what is done stays done, and the failed row runs first.
 */
export async function runInOrder(
    rows: readonly { ticked: boolean; status: RunStatus }[],
    apply: (index: number) => Promise<void>,
    report: (index: number, status: RunStatus, error: string | null) => void,
): Promise<boolean> {
    for (const [index, row] of rows.entries()) {
        if (!row.ticked || row.status === 'done') continue
        try {
            await apply(index)
            report(index, 'done', null)
        } catch (error) {
            report(index, 'failed', error instanceof Error ? error.message : String(error))
            return false
        }
    }
    return true
}

/**
 * The scopes a name typed for a page renames (ADR 0065, amended 2026-10-04): what the name proposes
 * read as an edited link reads (`renamesProposedByName`), less the page's own name. The page's
 * dialog always renames the page itself to what was typed, so its own row is not one of these.
 */
export function scopeRenamesInTypedName(page: string, typed: string): WikilinkEdit[] {
    return renamesProposedByName(page, typed).filter((edit) => conceptKey(edit.before) !== conceptKey(page))
}

/**
 * Whether `text` uses `scope` on its own rather than only as part of `page`'s name (ADR 0065,
 * amended 2026-10-04): a `[[scope]]` that is not inside a link to the page, or to a concept the
 * page scopes. Such a link carries the scope in its name, and renaming just the page updates it,
 * so it is no use of the scope of its own. Code is not a reference, and the frontmatter is left
 * out: a document's names are the registry's to answer for.
 */
export function usesScopeBeyondPage(text: string, scope: string, page: string): boolean {
    const links = wikilinkOccurrencesInSource(text.slice(frontmatterSpan(text)?.end ?? 0))
    const namesPage = (concept: string) => conceptKey(concept) === conceptKey(page) || isScopedBy(concept, page)
    return links.some(
        (link) =>
            conceptKey(link.concept) === conceptKey(scope) &&
            !links.some(
                (outer) =>
                    outer !== link &&
                    outer.line === link.line &&
                    outer.matchStart <= link.matchStart &&
                    link.matchEnd <= outer.matchEnd &&
                    namesPage(outer.concept),
            ),
    )
}
