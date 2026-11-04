/**
 * What a PDF's rename does to the links to it. Each link's path takes the new name. Its label does too
 * when the label was only the old name, with or without `.pdf`, as an upload or an import writes it. A
 * label a person wrote stays. Pure, so the rule tests without a store.
 */
import { markdownLinks } from '../markdown-link-target'

export interface LinkRename {
    /** Whether this target names the renamed file. */
    names(target: string): boolean
    /** The target's new path, keeping any `#page=` it carries. */
    newTarget(target: string): string
    /** The names the file went by: its old name, and its old file name. */
    oldNames: readonly string[]
    /** The new name, with `.pdf`. */
    newName: string
}

export interface LinkEdit {
    from: number
    to: number
    insert: string
}

const stemOf = (name: string) => name.replace(/\.pdf$/i, '')

function newLabel(label: string, rename: LinkRename): string {
    const lower = label.trim().toLowerCase()
    const hit = rename.oldNames.flatMap((name) => [name, stemOf(name)]).some((name) => name.toLowerCase() === lower)
    if (!hit) return label
    return /\.pdf$/i.test(label.trim()) ? rename.newName : stemOf(rename.newName)
}

/** The edits to `text`, in reverse order, so applying them one by one moves none that follow. */
export function linkRenameEdits(text: string, rename: LinkRename): LinkEdit[] {
    const edits: LinkEdit[] = []
    for (const link of markdownLinks(text)) {
        if (!rename.names(link.target)) continue
        const insert = `${link.bang}[${newLabel(link.label, rename)}](${rename.newTarget(link.target)})`
        if (insert !== link.whole) edits.push({ from: link.from, to: link.to, insert })
    }
    return edits.reverse()
}
