/**
 * A bullet ends at a line short of its content column, as the editor's outline reads it: such a
 * line is prose of its own, never the bullet's continuation. CommonMark reads it otherwise when the
 * bullet ends in a paragraph. The line is then a lazy continuation of that paragraph whatever its
 * indent, so a margin line typed under a bullet (`- a`, then `b`) was drawn on the site as part of
 * the bullet's text.
 *
 * The rule only ever ends a block. markdown-it asks every rule listed under a chain name whether a
 * line ends the paragraph being read (or, for a quote inside a bullet, the quote, or a link
 * definition's lines), and this one answers yes where the editor reads the line as outside the
 * innermost list item:
 *
 * - The item is a `-` bullet the editor reads (`isBulletLine`), not inside a quote. The editor's
 *   outline reads no `*`, `+` or numbered item and no list inside a quote, so those keep
 *   CommonMark's reading.
 * - The line is short of the bullet's content column as the editor measures it, two columns past
 *   the dash (`MARKER_WIDTH`) whatever spacing follows the dash. markdown-it's own content column
 *   (`state.blkIndent`) counts the spaces after the dash, so `-  a` puts it at 3, where the editor's
 *   continuation line under that bullet sits at 2.
 * - Both lines are indented with spaces only. With a tab or a no-break space the two measure
 *   columns differently, and the checks for those fix the lines first.
 *
 * The line then starts a block of its own, read the usual way, except that it is always a paragraph
 * where the usual way would read something a lazy continuation never is: a setext heading's text, a
 * link reference definition, an HTML block (a lone `<img …>` or `</span>`, which would run to the
 * next blank line and take the bullets after it), or an indented code block. The editor's markdown
 * parser still reads the line as the item's continuation, so the editor shows it as text with a
 * `---` under it drawn as a rule, and the site does the same. A table, a quote or a heading there
 * starts as it would anywhere.
 *
 * A paragraph started that way ends at an empty bullet (`- `), which the editor reads as a bullet
 * there. CommonMark does not let an empty list item interrupt a paragraph, so the site read `-` as
 * the paragraph's text, where the editor's parser, still inside the list, reads a new item.
 */

import type { Env, MarkdownIt, StateBlock, Token } from 'markdown-it'

import { isBulletLine, lineIndent, MARKER_WIDTH } from '../../outliner'

/** What the rule keeps on a parse's own environment object. */
interface ListItemEnds extends Env {
    etherpkListItemEnds?: Set<number>
}

/** The lines this parse ended a list item at. */
function endedAt(state: StateBlock): Set<number> {
    const env = state.env as ListItemEnds
    env.etherpkListItemEnds ??= new Set()
    return env.etherpkListItemEnds
}

/** A line whose indentation, if any, is spaces only. */
const SPACE_INDENTED = /^ *\S/

/** An empty bullet as the editor reads one: a dash and whitespace, indented with spaces. */
const EMPTY_BULLET = /^ *-[ \t]+$/

/** The block rules whose reading of a line this rule ended an item at is never the editor's. */
const READ_AS_A_PARAGRAPH = ['lheading', 'reference', 'html_block', 'code']

/** Line `line` as typed, from its true start: inside a quote `bMarks` starts after the `>`. */
function rawLine(state: StateBlock, line: number): string {
    const end = state.eMarks[line]
    return state.src.slice(state.src.lastIndexOf('\n', end - 1) + 1, end)
}

/**
 * The first line of the innermost list item the parse is inside, or null when it is in no item or
 * inside a quote. Walking back over the tokens pushed so far, the openers not yet closed are the
 * containers the parse is inside, innermost first. A block being read has not pushed its own tokens.
 */
function openItemLine(state: StateBlock): number | null {
    let closed = 0
    let item: number | null = null
    for (let i = state.tokens.length - 1; i >= 0; i--) {
        const token = state.tokens[i]
        if (token.nesting === -1) closed++
        else if (token.nesting === 1) {
            if (closed > 0) closed--
            else if (token.type === 'blockquote_open') return null
            else if (token.type === 'list_item_open' && item === null) item = token.map?.[0] ?? null
        }
    }
    return item
}

/**
 * `body` parsed by `md`, which must carry this rule, with the 0-based lines at which the rule ended a
 * list item, in order: the lines other markdown tools read as part of the bullet above them.
 */
export function parseListItemEnds(md: MarkdownIt, body: string): { tokens: Token[]; ends: number[] } {
    const env: ListItemEnds = {}
    const tokens = md.parse(body, env)
    return { tokens, ends: [...(env.etherpkListItemEnds ?? [])].sort((a, b) => a - b) }
}

export function listItemEndRule(md: MarkdownIt): void {
    md.block.ruler.before(
        'paragraph',
        'etherpk_list_item_end',
        (state, line, _endLine, silent) => {
            // Asked to start a block (not silent), it never does: it only ends the one being read.
            if (!silent) return false
            // A paragraph started at a line this rule ended an item at (`state.line` is where the block
            // being read starts) ends at an empty bullet.
            if (endedAt(state).has(state.line) && EMPTY_BULLET.test(rawLine(state, line))) return true
            // The editor's content column is never past markdown-it's, so a line at or past
            // markdown-it's stays in the item, and most lines stop here.
            if (state.listIndent < 0 || state.sCount[line] >= state.blkIndent) return false
            const start = openItemLine(state)
            if (start === null) return false
            const bullet = rawLine(state, start)
            const text = rawLine(state, line)
            if (!isBulletLine(bullet) || !SPACE_INDENTED.test(bullet) || !SPACE_INDENTED.test(text)) return false
            if (lineIndent(text) >= lineIndent(bullet) + MARKER_WIDTH) return false
            endedAt(state).add(line)
            return true
        },
        { alt: ['paragraph', 'blockquote', 'reference'] },
    )
    // markdown-it has no public handle on a built-in rule's function, so each rule is taken from the
    // chain by name and wrapped to skip the lines above, which the paragraph rule then reads.
    for (const name of READ_AS_A_PARAGRAPH) {
        const rule = md.block.ruler.__rules__.find((candidate) => candidate.name === name)
        if (!rule) continue
        const read = rule.fn
        md.block.ruler.at(name, (state, startLine, endLine, silent) => !endedAt(state).has(startLine) && read(state, startLine, endLine, silent), { alt: rule.alt })
    }
}
