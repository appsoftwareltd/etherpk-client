/**
 * The list kinds a graph's outline does not write: `*`, `+`, `1.` and `1)` items and their tasks,
 * as a file of a [[Plain Folder]] holds them (ADR 0195). Text rules only, with no editor in them:
 * what an item is, what is under it, and where a nested item goes. `view/list-items-keymap.ts`
 * turns them into keys.
 *
 * A graph's own bullets are `- ` on a two-space grid (ADR 0067) and stay `outliner.ts`'s.
 */
import { fencedBlocks } from './fenced-code'
import { MARKER_WIDTH, isBulletLine, lineIndent, opaqueLineFlags } from './outliner'

/** A list item of a kind the graph outline does not write. */
export interface ListItem {
    /** The whitespace before the marker, as written. */
    indent: string
    /** `*`, `+`, `3.` or `3)`. */
    marker: string
    /** The whitespace between the marker and the text. */
    gap: string
    /** A task's box with the space after it (`[ ] `), or empty. */
    box: string
    /** The item's text. */
    content: string
}

const ITEM = /^([ \t]*)([*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/
/** `* * *` and `***`: a thematic break, not a list. */
const RULE = /^[ \t]*([*_-])([ \t]*\1){2,}[ \t]*$/
const NUMBERED = /^(\d{1,9})([.)])$/

/** The item a line holds by its own text, or null for any other line (a `- ` bullet included). */
export function parseListItem(text: string): ListItem | null {
    if (RULE.test(text)) return null
    const match = ITEM.exec(text)
    if (!match) return null
    return { indent: match[1], marker: match[2], gap: match[3], box: match[4] ?? '', content: match[5] }
}

export const leadingOf = (text: string): string => text.slice(0, lineIndent(text))
const isBlank = (text: string) => text.trim() === ''
/** Any list item, of the outline's own kind or another: what an item can nest under. */
const isAnyItem = (text: string) => isBulletLine(text) || parseListItem(text) !== null
export const isNumbered = (marker: string): boolean => NUMBERED.test(marker)

/**
 * The lines with fenced code and the frontmatter blanked, so nothing in them is read as part of a
 * list: a `* ` inside a code block is code, and a tab there says nothing of how the lists indent.
 */
export function listStructure(lines: readonly string[]): string[] {
    const all = [...lines]
    const opaque = opaqueLineFlags(all, fencedBlocks(all))
    return all.map((text, index) => (opaque[index] ? '' : text))
}

/**
 * The item on line `index`, or null. Beyond its own text, a numbered line straight after a
 * paragraph line is the paragraph going on unless it starts at 1 (CommonMark): `2025. It rained`
 * under a sentence is prose.
 */
export function listItemAt(structure: readonly string[], index: number): ListItem | null {
    const item = parseListItem(structure[index] ?? '')
    if (!item) return null
    const numbered = NUMBERED.exec(item.marker)
    if (!numbered || Number(numbered[1]) === 1 || index === 0) return item
    const above = structure[index - 1]
    const inParagraph = !isBlank(above) && !isAnyItem(above) && leadingOf(above) === ''
    return inParagraph ? null : item
}

/** The last line of the branch rooted at `root`: the lines under it that are indented further. */
export function branchEnd(lines: readonly string[], root: number): number {
    const width = lineIndent(lines[root])
    let end = root
    for (let index = root + 1; index < lines.length; index++) {
        if (isBlank(lines[index])) continue
        if (lineIndent(lines[index]) <= width) break
        end = index
    }
    return end
}

/** The nearest non-blank line above `root` that `stop` accepts, scanning while lines are indented at least as far as `least`. */
function above(structure: readonly string[], root: number, least: number, take: (index: number, width: number) => boolean | null): number | null {
    for (let index = root - 1; index >= 0; index--) {
        if (isBlank(structure[index])) continue
        const width = lineIndent(structure[index])
        if (width < least) return null
        const verdict = take(index, width)
        if (verdict !== null) return verdict ? index : null
    }
    return null
}

/** The item above `root` at the same indent, with nothing shallower between them. Null for a first item. */
export function previousSibling(structure: readonly string[], root: number): number | null {
    const own = lineIndent(structure[root])
    return above(structure, root, own, (index, width) => (width === own ? isAnyItem(structure[index]) : null))
}

/** The item below `root` at the same indent, with nothing shallower between them. */
export function nextSibling(structure: readonly string[], root: number): number | null {
    const own = lineIndent(structure[root])
    for (let index = root + 1; index < structure.length; index++) {
        if (isBlank(structure[index])) continue
        const width = lineIndent(structure[index])
        if (width < own) return null
        if (width === own) return isAnyItem(structure[index]) ? index : null
    }
    return null
}

/** The item `root` is nested under: the nearest item above it that is indented less. */
export function parentOf(structure: readonly string[], root: number): number | null {
    const own = lineIndent(structure[root])
    return above(structure, root, 0, (index, width) => (width < own && isAnyItem(structure[index]) ? true : null))
}

/** The first item nested directly under the item on `root`, or null when it has none. */
function firstChild(structure: readonly string[], root: number): number | null {
    const own = lineIndent(structure[root])
    for (let index = root + 1; index < structure.length; index++) {
        if (isBlank(structure[index])) continue
        if (lineIndent(structure[index]) <= own) return null
        if (isAnyItem(structure[index])) return index
    }
    return null
}

/** How far an item's text starts past its indent: its marker and the space after it. */
function markerWidth(text: string): number {
    const item = parseListItem(text)
    return item ? item.marker.length + item.gap.length : MARKER_WIDTH
}

/**
 * The indent a file nests its lists by, where it nests any with spaces: the smallest step between
 * an item and the item it sits under. Null for a file with no such list.
 */
function fileNestingStep(structure: readonly string[]): number | null {
    let smallest: number | null = null
    structure.forEach((text, index) => {
        if (!isAnyItem(text) || leadingOf(text).includes('\t')) return
        const parent = parentOf(structure, index)
        if (parent === null || leadingOf(structure[parent]).includes('\t')) return
        const step = lineIndent(text) - lineIndent(structure[parent])
        if (smallest === null || step < smallest) smallest = step
    })
    return smallest
}

/**
 * The indent of an item nested under the item on `under`: the indent of the children it already
 * has, else one tab more where the file's lists indent with tabs, else that item's content column,
 * or the file's own step when the file nests deeper and the step still nests (CommonMark: fewer
 * than four columns past the content column).
 */
export function nestedIndent(structure: readonly string[], under: number): string {
    // Beside the children the item already has, so the new one is their sibling and not a child of the last.
    const child = firstChild(structure, under)
    if (child !== null) return leadingOf(structure[child])
    const base = leadingOf(structure[under])
    if (structure.some((text) => text.startsWith('\t') && isAnyItem(text))) return `${base}\t`
    const needed = markerWidth(structure[under])
    const own = fileNestingStep(structure)
    const step = own !== null && own > needed && own < needed + 4 ? own : needed
    return base + ' '.repeat(step)
}

/** The marker of the item after one with `marker`: the next number, or the same for `*`, `+` and a list kept at one number. */
export function nextMarker(marker: string, sameNumber = false): string {
    const numbered = NUMBERED.exec(marker)
    if (!numbered || sameNumber) return marker
    return `${Number(numbered[1]) + 1}${numbered[2]}`
}

/** A list numbered the same throughout (`1.` on every item): the item on `index` has a neighbour with its own marker. */
export function keepsOneNumber(structure: readonly string[], index: number, marker: string): boolean {
    if (!isNumbered(marker)) return false
    const same = (at: number | null) => at !== null && parseListItem(structure[at])?.marker === marker
    return same(previousSibling(structure, index)) || same(nextSibling(structure, index))
}

/** One item to renumber after an item was added above it. */
export interface Renumbering {
    line: number
    marker: string
    /** How many columns wider the marker became (`9.` to `10.`): what is under the item moves in by as much. */
    wider: number
}

/**
 * The items after `index` to renumber once the item after it takes `marker`: its following
 * siblings, while they were in sequence. A list that was not counting is left as it is.
 */
export function renumberings(structure: readonly string[], index: number, marker: string): Renumbering[] {
    const out: Renumbering[] = []
    if (!isNumbered(marker)) return out
    let expected = marker
    for (let next = nextSibling(structure, index); next !== null; next = nextSibling(structure, next)) {
        const following = parseListItem(structure[next])
        if (!following || following.marker !== expected) break
        expected = nextMarker(expected)
        out.push({ line: next, marker: expected, wider: expected.length - following.marker.length })
    }
    return out
}
