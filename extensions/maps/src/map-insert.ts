/**
 * Where `/map` puts a new, empty [[Map Block]] (ADR 0118), worked out from the caret's line. It
 * follows where a code block goes (`insertCodeBlock`, editor-commands.ts) and a table
 * (`table-insert.ts`):
 *
 * - an empty bullet takes the map's opener as its content (`- ```map`, form 1), so the map is drawn
 *   beside the bullet's dot;
 * - an empty line is replaced, at its own indentation;
 * - any other line keeps the caret, and the map goes on new lines beneath it at its content column,
 *   so beneath a bullet it is the bullet's own.
 *
 * The new map's search box takes the keyboard, so nothing is added round the map. The editor's
 * caret still waits outside it, since the caret touching a fence shows its text
 * (interactive-fence-state.ts) and the map would not be drawn. Beside a map that took its line, the
 * caret waits at the start of the line after it or the end of the line before, whichever no block
 * of its own starts or ends on, where the caret would show that block's text. Only a map that would
 * be all the document holds after its frontmatter gets an empty line after it, the one place left
 * for the caret.
 */
import { MAP_FENCE_INFO } from '$lib/document/map-text'
import { bulletContent, contentColumn, isBulletLine, lineIndent, taskDone } from '$lib/document/outliner'

export interface MapInsertPlan {
    from: number
    to: number
    insert: string
    /** Where the caret goes once the map is in. */
    caret: number
}

const FENCE = '```'

/**
 * A line beside the caret's line: none there, a plain line, or a line a block of its own (a fenced
 * block, a table, an image) starts or ends on, where the caret would show the block's text.
 */
export type MapInsertNeighbour = 'none' | 'plain' | 'block'

/** The lines either side of the caret's line, where the caret can wait beside a map that takes it. */
export interface MapInsertContext {
    /** The line before: none at the document's start or straight after its frontmatter. */
    before: MapInsertNeighbour
    /** The line after: none at the document's end. */
    after: MapInsertNeighbour
}

/** The edit that adds an empty Map Block at the caret's line. */
export function planMapInsert(line: { from: number; to: number; text: string }, context: MapInsertContext): MapInsertPlan {
    // A task's marker is no fence's bullet: `- [ ] ` before the backticks is not an opener.
    const emptyBullet = isBulletLine(line.text) && taskDone(line.text) === undefined && bulletContent(line.text).trim() === ''
    if (emptyBullet || line.text.trim() === '') {
        // The map takes the line: an empty bullet keeps its marker and opens the map after it.
        const column = emptyBullet ? contentColumn(line.text) : lineIndent(line.text)
        const opener = emptyBullet ? line.text.slice(0, column) : ' '.repeat(column)
        const map = `${opener}${FENCE}${MAP_FENCE_INFO}\n${' '.repeat(column)}${FENCE}`
        const after = line.from + map.length + 1
        const caret = caretBeside(context, line.from - 1, after)
        if (caret === null) return { from: line.from, to: line.to, insert: `${map}\n`, caret: after }
        return { from: line.from, to: line.to, insert: map, caret }
    }
    const indent = ' '.repeat(contentColumn(line.text))
    return { from: line.to, to: line.to, insert: `\n${indent}${FENCE}${MAP_FENCE_INFO}\n${indent}${FENCE}`, caret: line.to }
}

/**
 * Where the caret waits beside a map that took its line: a plain line after or before it first,
 * then a block's line there, or null when there is no line either side.
 */
function caretBeside(context: MapInsertContext, before: number, after: number): number | null {
    if (context.after === 'plain') return after
    if (context.before === 'plain') return before
    if (context.after === 'block') return after
    if (context.before === 'block') return before
    return null
}
