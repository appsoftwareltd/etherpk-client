/**
 * The [[Task Editor]] opened outside a board (ADR 0170): on the task a menu was raised on, a task's
 * line in an editor or a Tasks View row ("Open in task editor"). It is the same dialog a card opens,
 * drawn on the page's body rather than in a board, with "Task in <document>" as its title, and
 * what Archive and Delete did said in the Client's notices with Undo (`task-editor-notices.ts`),
 * since there is no board line to say it.
 *
 * One at a time: opening another closes the first. Closing hands the keyboard back to what had it
 * when the dialog opened (the dialog's own rule), which the menu gave back to the editor or the
 * Tasks View row before the row ran. The extension closes an open one as it stops (extension.ts).
 */
import type { ExtensionContext } from '@appsoftwareltd/etherpk-extension-api'
import { mount, unmount } from 'svelte'

import { workspaceService } from '#lib/workspace/workspace-services.js'

import TaskEditor from './TaskEditor.svelte'
import type { TaskEditorEdit } from './task-editor-model'
import { taskEditorNotices } from './task-editor-notices'

export function createTaskEditorOpener(context: ExtensionContext): { open(start: TaskEditorEdit): void; close(): void } {
    const notices = taskEditorNotices({ notify: (text, options) => context.notify(text, options), store: () => workspaceService('store') ?? null })
    /** Closes the one open now, or null when none is. */
    let closeOpen: (() => void) | null = null

    return {
        open(start) {
            closeOpen?.()
            const host = document.createElement('div')
            document.body.appendChild(host)
            const close = () => {
                if (closeOpen !== close) return
                closeOpen = null
                void unmount(instance)
                host.remove()
            }
            const instance = mount(TaskEditor, {
                target: host,
                props: { concept: null, onBoard: false, start, onclose: close, onarchived: notices.archived, ondeleted: notices.deleted },
            })
            closeOpen = close
        },
        close() {
            closeOpen?.()
        },
    }
}
