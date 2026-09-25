/**
 * The [[File Link]] Command: **copy** the link's native path to the clipboard, and the `/` menu
 * row that offers it while the caret is inside one (`link-affordances.ts` says why copy is the
 * whole affordance). Registered with the Command registry so the editor's trailing icon, a
 * click on the link text, the quoted-line button and the menu row are one behaviour.
 *
 * Handed a target, it copies that path. Handed nothing (the menu row, a keybinding), it copies
 * the link the active editor's caret means (`file-link-context.ts`: at the caret, else the nearest
 * before it on the line), and does nothing when the line holds none. It reports `true`
 * only when the path landed, which is what a surface keys its tick on; a write the browser
 * refuses (permissions, an insecure context) is told to the user, path included, so it can be
 * copied by hand.
 */

import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '../../surface'
import { getActiveEditorView } from '../active-editor'
import { type FileLinkTarget, isFileLinkTarget, LINK_COPY_PATH } from '../link-affordances'
import { fileLinkForCaret } from '../view/file-link-context'
import { copyFailureMessage, writeClipboardText } from './clipboard-text'

export interface LinkCommandDeps {
    /** Where a refused clipboard write is reported; absent hosts (the dev harness) get a console warning. */
    onError?: (text: string) => void
}

/** The link the active editor's caret means, as a target, or null. */
function targetAtCaret(): FileLinkTarget | null {
    const view = getActiveEditorView()
    if (!view) return null
    const hit = fileLinkForCaret(view.state)
    return hit ? { kind: 'file-link', path: hit.path } : null
}

/** Register the file-link Command and its menu row. Returns a teardown. */
export function registerLinkCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: LinkCommandDeps = {},
): () => void {
    const offs: (() => void)[] = []

    offs.push(
        commands.register(LINK_COPY_PATH, async (arg?: unknown) => {
            const target = isFileLinkTarget(arg) ? arg : targetAtCaret()
            if (!target) return false
            try {
                await writeClipboardText(target.path)
                return true
            } catch (err) {
                const text = copyFailureMessage('file path', err, target.path)
                if (deps.onError) deps.onError(text)
                else console.warn(text)
                return false
            }
        }),
    )

    offs.push(
        registerCommandMenuItem(contributions, {
            id: LINK_COPY_PATH,
            title: 'Copy file path',
            detail: 'Put the path of the file link on this line on the clipboard',
            icon: 'copy',
            group: 'Link',
            keywords: ['file', 'path', 'clipboard', 'link', 'copy'],
            when: (ctx) => ctx.fileLinkOnLine === true,
            command: LINK_COPY_PATH,
        }),
    )

    return () => {
        for (const off of offs) off()
    }
}
