/**
 * What a [[File Link]] lets you do, and how a surface asks for it done: **copy** its native path
 * to the clipboard. One action, defined here above both surfaces (the editor's trailing cluster
 * in `markdown-link.ts`, the quoted line in `InlineMarkdown.svelte`) so what one offers cannot
 * drift from what the other does, exactly as `asset-affordances.ts` does for an [[Asset
 * Reference]].
 *
 * Why copy and not open: a page served from the web cannot open a `file:` url (Chrome refuses
 * with "Not allowed to load local resource", Firefox with a security error). The path is the
 * useful thing, so the click hands it over for pasting into a file manager, a terminal or a
 * file dialog. A desktop shell with an OS to hand could swap this one Command for an open,
 * leaving both surfaces as they are.
 */

import { tryGetActiveCommandRegistry } from '$lib/surface'

import type { InlineAction } from './inline-action'

/** The [[Command]] that copies a file link's native path (`commands/link-commands.ts`). */
export const LINK_COPY_PATH = 'link.copyPath'

/** What the Command acts on: the native path, already decoded from the url. */
export interface FileLinkTarget {
    kind: 'file-link'
    path: string
}

export function isFileLinkTarget(arg: unknown): arg is FileLinkTarget {
    const target = arg as Partial<FileLinkTarget> | null | undefined
    return !!target && target.kind === 'file-link' && typeof target.path === 'string' && target.path.length > 0
}

/** The cluster a file link carries: copy, confirmed by a tick, since a clipboard write shows nothing. */
export function fileLinkActions(): InlineAction[] {
    return [{ command: LINK_COPY_PATH, icon: 'copy', label: 'Copy path', confirm: { icon: 'check', label: 'Copied' } }]
}

/**
 * Run one of them. Resolves `true` when the Command reports that the path landed on the
 * clipboard, which is what lets a surface show the action's `confirm`. A registry that has not
 * registered the Command is a no-op, never a throw.
 */
export async function runLinkCommand(command: string, target: FileLinkTarget): Promise<boolean> {
    const commands = tryGetActiveCommandRegistry()
    if (!commands?.has(command)) return false
    return (await commands.execute(command, target)) === true
}
