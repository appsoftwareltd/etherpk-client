/**
 * Bullets written with `*` or `+` (ADR 0109). Markdown reads them as list items, but only a `-`
 * bullet is an outliner block, so these get no dot, no children and no keys. The fix makes each
 * marker `-`, which keeps the rest of the line: `* [ ] task` becomes the task `- [ ] task`, and an
 * empty `*` becomes `- `, the empty bullet the editor writes.
 *
 * The markdown parser decides what is a list item, so a thematic break (`* * *`), emphasis and a
 * `*` in code are never touched, and numbered lists are left alone. Lines the editor reads as code
 * or frontmatter are skipped even where the parser reads them otherwise.
 */

import { type CheckedText, fixFinding, type FormattingCheck } from './finding'
import { markColumns } from './list-marks'

/** A line that could start a `*` or `+` list item. A document with none is never parsed. */
const MAYBE_ITEM = /^[ \t>]*[*+](?:[ \t]|$)/m

const LIST_MARK: ReadonlySet<string> = new Set(['ListMark'])

function reason(markers: ReadonlySet<string>): string {
    return `bullets written with ${[...markers].sort().join(' and ')}`
}

/** Each `*` or `+` list marker outside code and frontmatter, by line: the columns of its markers. */
function markerColumns(source: CheckedText): Map<number, number[]> {
    // A `-` bullet, or a numbered item's `1.`, is left alone.
    return markColumns(source, MAYBE_ITEM, LIST_MARK, ({ text, from }) => text[from] === '*' || text[from] === '+')
}

export const bulletMarker: FormattingCheck = {
    id: 'bullet-marker',
    label: 'Bullets written with * or +',
    help: 'Only bullets written with - are outline blocks, so bullets written with * or + get no dot and cannot hold child bullets.',
    find(source) {
        const columns = markerColumns(source)
        if (columns.size === 0) return null
        const markers = new Set<string>()
        const fixed = source.lines.map((line, i) => {
            const at = columns.get(i)
            if (!at) return line
            let text = line.text
            for (const column of at) {
                markers.add(text[column])
                // One character for one, so later columns hold. An empty item gets its space, as the
                // editor writes an empty bullet: a lone `-` would read as text.
                const rest = text.slice(column + 1)
                text = `${text.slice(0, column)}-${rest === '' ? ' ' : rest}`
            }
            return { text, ending: line.ending }
        })
        return fixFinding(source, fixed, () => reason(markers))
    },
}
