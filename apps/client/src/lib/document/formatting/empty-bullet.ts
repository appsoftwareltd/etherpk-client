/**
 * Empty bullets written as a lone `-` (ADR 0109). The editor takes a line as a bullet only when its
 * `-` has a space after it, which is how it writes an empty bullet (`- `), so a lone `-` shows as
 * text: a stray dash where the author meant an empty bullet. Logseq writes an empty block this way.
 * The fix adds the space, which keeps the line where it is and makes it the empty bullet it was.
 *
 * Which lone `-` lines count:
 * - one the markdown parser reads as an empty list item: a sibling of the bullet above it, or a
 *   bullet after a blank line;
 * - one that would underline a paragraph inside a bullet. CommonMark lets an empty item start a
 *   list only where it does not interrupt a paragraph, so the first, empty child of a bullet
 *   (`- a` then `  -`) parses as a setext heading underline. Neither EtherPK nor Logseq writes a
 *   heading that way inside a bullet, so it is the empty child the outline shows.
 *
 * A lone `-` under a paragraph outside any list is a setext heading, and is left alone, as are
 * code, frontmatter and a thematic break (`---`).
 */

import { fixFinding, type FormattingCheck } from './finding'
import { markColumns, type MarkNode } from './list-marks'

/** A line that is a lone `-`, after any indentation or quote markers. A document with none is never parsed. */
const MAYBE_LONE = /^[ \t>]*-$/m

const MARKS: ReadonlySet<string> = new Set(['ListMark', 'HeaderMark'])

/** Whether the mark is a `-` with nothing after it on its line. */
const isLoneDash = ({ text, from, to }: MarkNode) => text[from] === '-' && to === from + 1 && to === text.length

/** Whether a setext heading's underline sits inside a list item. */
function underlinesInsideBullet({ node }: MarkNode): boolean {
    const heading = node.node.parent
    if (heading?.name !== 'SetextHeading2') return false
    for (let up = heading.parent; up; up = up.parent) if (up.name === 'ListItem') return true
    return false
}

function reason(count: number): string {
    return count === 1 ? 'an empty bullet with no space after the -' : `${count} empty bullets with no space after the -`
}

export const emptyBullet: FormattingCheck = {
    id: 'empty-bullet',
    label: 'Empty bullets without a space',
    help: 'An empty bullet needs a space after its -, or the editor shows the - as text rather than as a bullet. Pages from Logseq often have them.',
    find(source) {
        const columns = markColumns(source, MAYBE_LONE, MARKS, (mark) => isLoneDash(mark) && (mark.node.name === 'ListMark' || underlinesInsideBullet(mark)))
        if (columns.size === 0) return null
        const fixed = source.lines.map((line, i) => (columns.has(i) ? { text: `${line.text} `, ending: line.ending } : line))
        return fixFinding(source, fixed, (changed) => reason(changed.length))
    },
}
