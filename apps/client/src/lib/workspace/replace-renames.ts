/**
 * A replace that changes the name in a wikilink asks before any text changes (ADR 0153 §4).
 *
 * The find box plans the replace and says what it would propose: the renames, each a concept a
 * link named `before` and would name `after`. This decides what to ask by the rules an edited link
 * follows (ADR 0065): a rename is asked only while its old name is still used outside this
 * document's text as the replace leaves it, and is otherwise a move, made with the replace. Then it
 * asks, plans again when the person confirms, and only then has the box write the text and the
 * workspace run the renames that were ticked.
 *
 * Pure apart from its collaborators, so the order of asking, writing and renaming is unit-tested
 * without a workspace or an editor.
 */

import type { ReplaceOutcome, ReplaceRequest } from '$lib/document/find/replace-question'

import { asksSomething, type ProposedRename } from './link-rename-controller'

export type { ReplaceMode, ReplaceOutcome, ReplaceRequest } from '$lib/document/find/replace-question'

/** What the dialog is told besides its rows. */
export interface ReplaceQuestion {
    /** How many matches the replace changes. */
    replaced: number
    /** Why the dialog is shown again, or null the first time. */
    notice: string | null
}

export interface ReplaceRenamesDeps {
    /** Whether `after` is another name of the page `before` names: no rename, and nothing moves. */
    sameDocument(before: string, after: string): boolean
    /** Whether `name` is used beyond `target`, reading `target`'s text as `textAfter`. */
    usedBeyond(target: string, name: string, textAfter: string): Promise<boolean>
    /** Nothing else used `before`: what was keyed by it (a Draft, a favourite) follows. */
    conceptMoved(before: string, after: string): Promise<void>
    /** Show the renames and wait for the person's answer. */
    ask(target: string, renames: readonly ProposedRename[], question: ReplaceQuestion): Promise<'confirm' | 'outside' | 'cancel'>
    /** Run the renames ticked in the dialog, the text already replaced. Resolves when it closes. */
    runRenames(): Promise<void>
}

/** Said when the dialog's rows change under it. */
export const RENAMES_CHANGED = 'The document changed while this was open. Check the renames again.'

export function createReplaceRenames(deps: ReplaceRenamesDeps) {
    /** The renames to ask about and the moves to make with the replace, by the edited-link rules. */
    async function sort(target: string, plan: ReturnType<ReplaceRequest['plan']>) {
        const asked: ProposedRename[] = []
        const moved: ProposedRename[] = []
        for (const edit of plan.edits) {
            if (!asksSomething(edit, deps.sameDocument)) continue
            const rename = { before: edit.before, after: edit.after.trim() }
            if (await deps.usedBeyond(target, edit.before, plan.textAfter)) asked.push(rename)
            else moved.push(rename)
        }
        return { asked, moved }
    }

    async function moveAll(moved: readonly ProposedRename[]): Promise<void> {
        for (const { before, after } of moved) await deps.conceptMoved(before, after)
    }

    return {
        async replace(request: ReplaceRequest): Promise<ReplaceOutcome> {
            let shown: readonly ProposedRename[] | null = null
            let notice: string | null = null
            for (;;) {
                const plan = request.plan()
                const { asked, moved } = await sort(request.target, plan)
                // Nothing to ask (now or any longer), or the renames confirmed are still the ones
                // the replace proposes: write it.
                const confirmed = shown !== null && asked.length > 0 && sameRenames(shown, asked)
                if (asked.length === 0 || confirmed) {
                    if (!request.apply('all')) return { kind: 'refused' }
                    await moveAll(moved)
                    if (!confirmed) return { kind: 'replaced', renamed: false }
                    await deps.runRenames()
                    return { kind: 'replaced', renamed: true }
                }
                if (shown !== null) notice = RENAMES_CHANGED
                const answer = await deps.ask(request.target, asked, { replaced: plan.replaced, notice })
                if (answer === 'cancel') return { kind: 'cancelled' }
                if (answer === 'outside') return request.apply('outside-links') ? { kind: 'replaced', renamed: false } : { kind: 'refused' }
                // Confirmed: plan again, since the document may have changed while the dialog was open.
                shown = asked
            }
        },
    }
}

function sameRenames(a: readonly ProposedRename[], b: readonly ProposedRename[]): boolean {
    return a.length === b.length && a.every((rename, i) => rename.before === b[i].before && rename.after === b[i].after)
}
