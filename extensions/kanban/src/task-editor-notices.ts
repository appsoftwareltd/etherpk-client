/**
 * What the [[Task Editor]] says when it is opened outside a board (ADR 0170), from a task's line in
 * an editor or a Tasks View row, and Archive or Delete closes it. On a board the board's own line
 * says so, with Undo; outside one there is no such line, so the Client's notice says it, with Undo
 * on the notice (`context.notify(text, { action })`). Framework-free, so it is tested in Node.
 *
 * A notice's action runs once: a second press finds the undo used. Whatever the undo did is said
 * by the next notice, which takes the first one's place in the rail.
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'

import { type TaskWrite, undoTaskWrite } from '#lib/document/task-write.js'
import type { DocumentStore } from '#lib/document/types.js'

import type { ArchivedTask } from './task-editor-model'
import { type RemovedTask, restoreTask } from './task-editor-writes'

export interface TaskEditorNoticeDeps {
    notify: ExtensionContext['notify']
    /** The open graph's store, which an undo writes through; null with no graph open. */
    store(): DocumentStore | null
}

/** An Undo that runs `undo` once, and does nothing when pressed again. */
function once(undo: () => Promise<void>): () => Promise<void> {
    let used = false
    return async () => {
        if (used) return
        used = true
        await undo()
    }
}

export function taskEditorNotices(deps: TaskEditorNoticeDeps) {
    return {
        /** A task Archive took off the boards: said, with Undo, which puts its line back as it was. */
        archived(archived: ArchivedTask): void {
            const { document, label, outcome } = archived
            const write: TaskWrite = { line: outcome.line, before: outcome.before, after: outcome.after, nested: outcome.nested }
            const undo = once(async () => {
                const store = deps.store()
                if (!store) return
                const undone = await undoTaskWrite(store, document, write)
                deps.notify(
                    undone.ok
                        ? `Undone: "${label}" is as it was.`
                        : undone.reason === 'missing'
                          ? `Could not undo: "${document}" was renamed or deleted.`
                          : `Could not undo: "${label}" has changed since it was archived.`,
                )
            })
            deps.notify(`Archived "${label}". The Tasks view still lists it.`, { action: { label: 'Undo', run: undo } })
        },

        /** A task Delete took out with everything nested under it: said, with Undo, which puts it back. */
        deleted(removed: RemovedTask, label: string): void {
            const undo = once(async () => {
                const store = deps.store()
                if (!store) return
                const restored = await restoreTask(store, removed)
                deps.notify(
                    restored.ok
                        ? `Undone: "${label}" is back where it was.`
                        : restored.reason === 'missing'
                          ? `Could not undo: "${removed.concept}" was renamed or deleted.`
                          : `Could not undo: the lines around "${label}" changed since it was deleted. Its text is still in the document's history.`,
                )
            })
            deps.notify(`Deleted "${label}" and everything nested under it.`, { action: { label: 'Undo', run: undo } })
        },
    }
}
