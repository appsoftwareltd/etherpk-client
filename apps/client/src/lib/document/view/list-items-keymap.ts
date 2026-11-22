/**
 * The outliner's keys on the list kinds a graph does not write: `*`, `+`, `1.` and `1)` items, and
 * their tasks, in a file of a [[Plain Folder]] (ADR 0195). The text rules are `../list-items.ts`.
 *
 * A graph's outline is `- ` bullets on a two-space grid (ADR 0067), and `outliner-keymap.ts` acts on
 * those alone. A file written elsewhere uses the other markers as often, so in the editor's plain
 * profile these commands come first and take the lines the outliner would read as prose:
 *
 * - **Tab** nests an item, with everything under it, under the item above it. A selection across
 *   several items nests each of them.
 * - **Shift+Tab** lifts it to its parent's column.
 * - **Enter** starts the next item with the same marker. A numbered list counts on, and the items
 *   after it are renumbered while they were in sequence. Enter on an empty item lifts it a level,
 *   and at the margin ends the list.
 *
 * A `- ` bullet, a fenced block, the frontmatter and a block selection are left to the outliner.
 * The commands do nothing outside the plain profile (`plainLists`), so a Command can run them
 * first in any editor. In that profile Tab on a line that is no list item leaves it prose, where
 * in a graph it would become a bullet.
 */
import { type ChangeSpec, EditorSelection, type EditorState, Facet, type StateCommand, type TransactionSpec } from '@codemirror/state'
import type { KeyBinding } from '@codemirror/view'

import {
    type ListItem,
    branchEnd,
    keepsOneNumber,
    leadingOf,
    listItemAt,
    listStructure,
    nestedIndent,
    nextMarker,
    parentOf,
    previousSibling,
    renumberings,
} from '../list-items'
import { isBulletLine, lineIndent } from '../outliner'

import { rangeBlockOwner, selectedBranches } from './block-select'

/**
 * Set in the plain profile (ADR 0195): the other list kinds take the outliner's keys, and Tab on a
 * prose line leaves it prose. Read by these commands and by the outliner's own Tab.
 */
export const plainLists = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/** The document as these commands read it. */
interface Lists {
    /** The lines as written. */
    lines: string[]
    /** The same with fenced code and the frontmatter blanked (`listStructure`). */
    structure: string[]
}

function listsOf(state: EditorState): Lists {
    const lines = state.doc.toString().split('\n')
    return { lines, structure: listStructure(lines) }
}

/**
 * The items a Tab or Shift+Tab acts on: the item the caret is on, or each item a selection
 * reaches that is not under one already taken. Null when the outliner should have the key: a block
 * selection, a `- ` bullet in the range, or no item of these kinds.
 */
function rootsInSelection(state: EditorState, lists: Lists): number[] | null {
    if (!state.facet(plainLists) || selectedBranches(state) || rangeBlockOwner(state) !== null) return null
    const { main } = state.selection
    const first = state.doc.lineAt(main.from).number - 1
    const last = state.doc.lineAt(main.to).number - 1
    const roots: number[] = []
    let taken = -1
    for (let index = first; index <= last; index++) {
        if (isBulletLine(lists.structure[index])) return null
        if (index <= taken || !listItemAt(lists.structure, index)) continue
        roots.push(index)
        taken = branchEnd(lists.lines, index)
    }
    return roots.length > 0 ? roots : null
}

/** Give the branch rooted at `root` the indent `to` in place of its own, its lines keeping their offsets. */
function reindent(state: EditorState, lines: readonly string[], root: number, to: string): ChangeSpec[] {
    const from = leadingOf(lines[root])
    const changes: ChangeSpec[] = []
    for (let index = root; index <= branchEnd(lines, root); index++) {
        if (lines[index].trim() === '' || !lines[index].startsWith(from)) continue
        const start = state.doc.line(index + 1).from
        changes.push({ from: start, to: start + from.length, insert: to })
    }
    return changes
}

/** Where each root lands on Tab, or null when one of them has nothing to nest under. */
function nestTargets(lists: Lists, roots: readonly number[]): Map<number, string> | null {
    const targets = new Map<number, string>()
    for (const root of roots) {
        const sibling = previousSibling(lists.structure, root)
        if (sibling === null) return null
        // A sibling that is moving too takes this one with it: the pair keeps its shape.
        targets.set(root, targets.get(sibling) ?? nestedIndent(lists.structure, sibling))
    }
    return targets
}

export const indentListItem: StateCommand = ({ state, dispatch }) => {
    const lists = listsOf(state)
    const roots = rootsInSelection(state, lists)
    if (!roots) return false
    // Every item nests, or none does. The key is still taken, so focus never leaves the editor.
    const targets = nestTargets(lists, roots)
    if (!targets) return true
    const changes = roots.flatMap((root) => reindent(state, lists.lines, root, targets.get(root)!))
    // The selection is mapped through the change, so it stays on its text.
    dispatch(state.update({ changes, userEvent: 'input.indent', scrollIntoView: true }))
    return true
}

export const outdentListItem: StateCommand = ({ state, dispatch }) => {
    const lists = listsOf(state)
    const roots = rootsInSelection(state, lists)
    if (!roots) return false
    const changes = roots
        .filter((root) => lineIndent(lists.lines[root]) > 0)
        .flatMap((root) => {
            const parent = parentOf(lists.structure, root)
            return reindent(state, lists.lines, root, parent === null ? '' : leadingOf(lists.lines[parent]))
        })
    if (changes.length > 0) dispatch(state.update({ changes, userEvent: 'delete.dedent', scrollIntoView: true }))
    return true
}

/** The item Enter acts on, with where its text starts: the selection lies within one item's text. */
function itemForEnter(state: EditorState, lists: Lists): { index: number; item: ListItem; textFrom: number } | null {
    if (!state.facet(plainLists) || selectedBranches(state)) return null
    const { main } = state.selection
    const line = state.doc.lineAt(main.from)
    if (state.doc.lineAt(main.to).number !== line.number) return null
    const item = listItemAt(lists.structure, line.number - 1)
    if (!item) return null
    const textFrom = line.from + item.indent.length + item.marker.length + item.gap.length + item.box.length
    // In the marker or the box: a line break there is the default's.
    return main.from < textFrom ? null : { index: line.number - 1, item, textFrom }
}

type EnterTarget = NonNullable<ReturnType<typeof itemForEnter>>

/** Enter on an empty item: a nested one lifts a level, and one at the margin ends the list. */
function leaveEmptyItem(state: EditorState, lists: Lists, { index, item }: EnterTarget): TransactionSpec {
    const line = state.doc.line(index + 1)
    if (item.indent === '') return { changes: { from: line.from, to: line.to, insert: '' }, selection: EditorSelection.cursor(line.from) }
    const parent = parentOf(lists.structure, index)
    const to = parent === null ? '' : leadingOf(lists.lines[parent])
    return { changes: { from: line.from, to: line.from + item.indent.length, insert: to }, selection: EditorSelection.cursor(line.to - item.indent.length + to.length) }
}

/** The changes that renumber the items after a new one, moving what is under an item whose marker grew. */
function renumberChanges(state: EditorState, lists: Lists, index: number, marker: string): ChangeSpec[] {
    const changes: ChangeSpec[] = []
    for (const next of renumberings(lists.structure, index, marker)) {
        const start = state.doc.line(next.line + 1).from + lineIndent(lists.lines[next.line])
        changes.push({ from: start, to: start + next.marker.length - next.wider, insert: next.marker })
        if (next.wider <= 0) continue
        // `9.` became `10.`: its text starts a column later, and so must everything under it.
        for (let under = next.line + 1; under <= branchEnd(lists.lines, next.line); under++) {
            if (lists.lines[under].trim() !== '') changes.push({ from: state.doc.line(under + 1).from, insert: ' '.repeat(next.wider) })
        }
    }
    return changes
}

/** Enter in an item with text: the next item, with the same marker or the next number. */
function startNextItem(state: EditorState, lists: Lists, { index, item }: EnterTarget): TransactionSpec {
    const { main } = state.selection
    // A list numbered `1.` throughout stays so. Any other counts on.
    const lazy = keepsOneNumber(lists.structure, index, item.marker)
    const marker = nextMarker(item.marker, lazy)
    const prefix = `${item.indent}${marker}${item.gap}${item.box ? '[ ] ' : ''}`
    const split: ChangeSpec = { from: main.from, to: main.to, insert: `\n${prefix}` }
    const following = lazy ? [] : renumberChanges(state, lists, index, marker)
    return { changes: [split, ...following], selection: EditorSelection.cursor(main.from + 1 + prefix.length) }
}

export const enterListItem: StateCommand = ({ state, dispatch }) => {
    const lists = listsOf(state)
    const at = itemForEnter(state, lists)
    if (!at) return false
    const empty = state.selection.main.empty && at.item.content.trim() === ''
    const spec = empty ? leaveEmptyItem(state, lists, at) : startNextItem(state, lists, at)
    dispatch(state.update({ ...spec, userEvent: 'input', scrollIntoView: true }))
    return true
}

/** The bindings, for the editor's plain profile, ahead of the outliner's own. */
export function listItemBindings(): readonly KeyBinding[] {
    return [
        { key: 'Tab', run: indentListItem },
        { key: 'Shift-Tab', run: outdentListItem },
        { key: 'Enter', run: enterListItem },
    ]
}
