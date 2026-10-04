/**
 * Runs what an edited [[Wikilink]] proposes (ADR 0065, amended 2026-10-03), one document at a
 * time.
 *
 * The editor says only *what changed*: the renames one editing episode in `target` proposes,
 * outermost first, each a concept a link named `before` and names `after` now. The workspace
 * says whether `before` still exists elsewhere and how to ask. This is the piece between them.
 * An edit's renames are asked together, in one prompt; two edits in one document queue rather
 * than raising two prompts. A rename the user skips changes nothing, because the text the user
 * typed is canonical.
 *
 * Pure apart from its collaborators, so the sequencing is unit-tested without a workspace.
 */

/** A rename a link edit proposes: the concept a link named, and the name it has now. */
export interface ProposedRename {
    before: string
    after: string
}

export interface LinkRenameControllerDeps {
    /**
     * Whether `after` is another name of the document `before` names, its title or one of its
     * aliases: the edit chose which of the page's names the link uses, and it still reaches the
     * same page, so nothing is renamed and nothing moves.
     */
    sameDocument(before: string, after: string): boolean
    /**
     * Whether `before` still exists once this link has stopped naming it: another instance
     * anywhere in the graph (this document included), or a page with that name.
     */
    existsElsewhere(target: string, before: string): Promise<boolean>
    /**
     * Ask about every rename the edit proposes, in one dialog, and run the ones the user keeps.
     * Resolves once the dialog is done with.
     */
    promptRenames(target: string, renames: readonly ProposedRename[]): Promise<void>
    /**
     * Nothing else named `before`, so the edit moved the concept rather than proposing a
     * rename: whatever was keyed by the old name (an open Draft, a favourite) follows.
     */
    conceptMoved(before: string, after: string): Promise<void>
}

export interface LinkRenameController {
    /** An editing episode in a link ended: decide what to propose, and ask. */
    edited(target: string, edits: readonly ProposedRename[]): Promise<void>
}

/**
 * Whether a proposed rename has anything to ask: both names say something, the new one is more
 * than the old with padding, and it is not just another name of the same page. The name the
 * dialogs offer is the trimmed one, so a space typed at the end has no "rename to what?" to answer,
 * though the graph keeps the padding as part of the concept. A page's other name still reaches the
 * page, so nothing is renamed and nothing moves. Shared by the link route and a page's own dialog.
 */
export function asksSomething(edit: ProposedRename, sameDocument: (before: string, after: string) => boolean): boolean {
    if (edit.after.trim() === '' || edit.before.trim() === '') return false
    if (edit.after.trim() === edit.before.trim()) return false
    return !sameDocument(edit.before, edit.after.trim())
}

export function createLinkRenameController(deps: LinkRenameControllerDeps): LinkRenameController {
    const running = new Map<string, Promise<void>>()

    async function run(target: string, edits: readonly ProposedRename[]): Promise<void> {
        const asked: ProposedRename[] = []
        for (const { before, after } of edits) {
            if (!asksSomething({ before, after }, deps.sameDocument)) continue
            if (await deps.existsElsewhere(target, before)) asked.push({ before, after: after.trim() })
            // A move is not a rename, and nothing the dialog asks changes it, so it is applied
            // at once rather than waiting for the dialog to be answered.
            else await deps.conceptMoved(before, after.trim())
        }
        if (asked.length > 0) await deps.promptRenames(target, asked)
    }

    return {
        edited(target, edits) {
            const queued = (running.get(target) ?? Promise.resolve()).then(() => run(target, edits))
            running.set(target, queued)
            return queued.finally(() => {
                if (running.get(target) === queued) running.delete(target)
            })
        },
    }
}
