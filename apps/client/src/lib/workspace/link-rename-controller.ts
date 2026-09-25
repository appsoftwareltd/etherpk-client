/**
 * Runs what an edited [[Wikilink]] proposes (ADR 0065), one document at a time.
 *
 * The editor says only *what changed* - a link in `target` named `before` and now names
 * `after` - and the workspace says whether `before` still exists elsewhere and how to ask.
 * This is the piece between them. Two edits in one document queue rather than raising two
 * rename dialogs; a decline changes nothing, because the text the user typed is canonical.
 *
 * Pure apart from its collaborators, so the sequencing is unit-tested without a workspace.
 */

export interface LinkRenameControllerDeps {
    /**
     * Whether `before` still exists once this link has stopped naming it: another instance
     * anywhere in the graph (this document included), or a page with that name.
     */
    existsElsewhere(target: string, before: string): Promise<boolean>
    /**
     * Open the rename dialog for `before`, pre-filled with `after`, framed as a question about
     * the edit. Resolves to the new concept once renamed, or null when the user kept just
     * this link.
     */
    promptRename(target: string, before: string, after: string): Promise<string | null>
    /**
     * Nothing else named `before`, so the edit moved the concept rather than proposing a
     * rename: whatever was keyed by the old name (an open Draft, a favourite) follows.
     */
    conceptMoved(before: string, after: string): Promise<void>
}

export interface LinkRenameController {
    /** An editing episode in a link ended: decide whether to propose, and ask. */
    edited(target: string, before: string, after: string | null): Promise<void>
}

export function createLinkRenameController(deps: LinkRenameControllerDeps): LinkRenameController {
    const running = new Map<string, Promise<void>>()

    async function run(target: string, before: string, after: string | null): Promise<void> {
        // No balanced link survived the edit, or nothing is left to rename to: a structural
        // edit, not a rename.
        if (after === null || after.trim() === '' || before.trim() === '') return
        // The name the dialog would offer is the trimmed one; when that is the name the link
        // already had, there is nothing to ask (a space typed at the text's end, say). The graph
        // itself keeps the padding as part of the concept, so the editor reports the change; it
        // is this question, "rename to what?", that has no answer.
        if (after.trim() === before.trim()) return
        if (!(await deps.existsElsewhere(target, before))) {
            await deps.conceptMoved(before, after.trim())
            return
        }
        await deps.promptRename(target, before, after.trim())
    }

    return {
        edited(target, before, after) {
            const queued = (running.get(target) ?? Promise.resolve()).then(() => run(target, before, after))
            running.set(target, queued)
            return queued.finally(() => {
                if (running.get(target) === queued) running.delete(target)
            })
        },
    }
}
