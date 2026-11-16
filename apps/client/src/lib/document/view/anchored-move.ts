/**
 * A branch move written so that the moved branch's own text stays in the document.
 *
 * Alt+Up, Alt+Down and the block menu's Move rows work out the lines a move rearranges and their
 * new order (`computeMove`). Written as one replace of all those lines, the move deletes and
 * re-inserts every one of them, and in a synced graph (a text CRDT has no "move") a word another
 * person types into any of them at the same moment lands at the edge of the deleted text: in another
 * line, where it can break a bullet's marker. Everything that follows a position through an edit
 * (a [[Fold]], a [[Bookmark]], a peer's caret) loses the moved branch the same way.
 *
 * {@link anchoredMove} writes the same result as smaller changes: the moved branch (the anchor) is
 * left where it is, re-indented a line at a time when the move changes its depth, and the lines it
 * passes are the ones deleted and re-inserted on its other side. A word typed into the moved branch
 * at the same moment stays in it, and a position in it maps through the move. The lines passed are
 * still deleted and re-inserted, so an edit made to those at the same moment is still misplaced:
 * that half cannot be had from a text CRDT.
 *
 * Pure: strings and line numbers in, changes out.
 */

/** One change, in offsets of the text before the move. */
export interface MoveChange {
    from: number
    to: number
    insert: string
}

const indentOf = (line: string) => line.length - line.trimStart().length

/** `line` moved `delta` columns: spaces added, or leading spaces taken (a blank line gives what it has). */
function shifted(line: string, delta: number): string | null {
    if (delta >= 0) return line.trim() === '' ? line : ' '.repeat(delta) + line
    const take = Math.min(-delta, indentOf(line))
    if (take < -delta && line.trim() !== '') return null
    return /^ *$/.test(line.slice(0, take)) ? line.slice(take) : null
}

/**
 * Where the anchor lines `anchor` sit in `next`, moved by one uniform indent, with the lines around
 * them equal to `before` and `after` in order: the index in `next` and the indent change, or null.
 */
function locate(before: string[], anchor: string[], after: string[], next: string[]): { at: number; delta: number } | null {
    const others = [...before, ...after]
    if (next.length !== others.length + anchor.length) return null
    const first = anchor.findIndex((l) => l.trim() !== '')
    if (first < 0) return null
    for (let at = 0; at + anchor.length <= next.length; at++) {
        const delta = indentOf(next[at + first]) - indentOf(anchor[first])
        if (!anchor.every((line, i) => shifted(line, delta) === next[at + i])) continue
        const rest = [...next.slice(0, at), ...next.slice(at + anchor.length)]
        if (rest.every((line, i) => line === others[i])) return { at, delta }
    }
    return null
}

/** The lines of a text with where each starts and ends, as offsets into the whole text. */
function offsets(lines: readonly string[]): { starts: number[]; endOf: (i: number) => number } {
    const starts: number[] = []
    let offset = 0
    for (const line of lines) {
        starts.push(offset)
        offset += line.length + 1
    }
    return { starts, endOf: (i) => starts[i] + lines[i].length }
}

/**
 * The changes that carry `count` lines from below the anchor to above it (`count` > 0) or from above
 * it to below (`count` < 0), less the insertion in front of the anchor, which is returned as `lead`
 * for the anchor's first line to carry with its own change.
 */
function carried(lines: readonly string[], anchorFirst: number, anchorLast: number, count: number): { changes: MoveChange[]; lead: string } {
    const { starts, endOf } = offsets(lines)
    if (count > 0) {
        const lastMoved = anchorLast + count
        const lead = lines.slice(anchorLast + 1, lastMoved + 1).join('\n') + '\n'
        // Whole lines with the break after them where one follows, so the end of the anchor's last
        // line, where a person may be typing, is no edge of the deletion.
        const whole = lastMoved + 1 < lines.length
        return { lead, changes: [{ from: whole ? starts[anchorLast + 1] : endOf(anchorLast), to: whole ? starts[lastMoved + 1] : endOf(lastMoved), insert: '' }] }
    }
    const firstMoved = anchorFirst + count
    const moved = lines.slice(firstMoved, anchorFirst).join('\n')
    // Written at the start of the line after the anchor where there is one, not at the end of the
    // anchor's last line: text a peer types there at the same moment would come out on either side of it.
    const after = anchorLast + 1 < lines.length
    const at = after ? starts[anchorLast + 1] : endOf(anchorLast)
    return { lead: '', changes: [{ from: starts[firstMoved], to: starts[anchorFirst], insert: '' }, { from: at, to: at, insert: after ? moved + '\n' : '\n' + moved }] }
}

/** The anchor's own lines re-indented by `delta`, one change a line, the first carrying `lead` in front of it. */
function reindented(lines: readonly string[], anchorFirst: number, anchorLast: number, delta: number, lead: string): MoveChange[] {
    const { starts } = offsets(lines)
    const changes: MoveChange[] = []
    for (let i = anchorFirst; i <= anchorLast; i++) {
        const add = (i === anchorFirst ? lead : '') + (delta > 0 && lines[i].trim() !== '' ? ' '.repeat(delta) : '')
        if (add) changes.push({ from: starts[i], to: starts[i], insert: add })
        const take = delta < 0 ? Math.min(-delta, indentOf(lines[i])) : 0
        if (take > 0) changes.push({ from: starts[i], to: starts[i] + take, insert: '' })
    }
    return changes
}

/**
 * The move that replaces lines `fromLine`..`toLine` (0-based, inclusive) of `lines` with `insert`,
 * as changes that leave lines `anchorFirst`..`anchorLast` (the moved branch) in place. Null when the
 * replacement is not the same lines with the anchor moved and re-indented, in which case the caller
 * dispatches the replace as it is.
 */
export function anchoredMove(lines: readonly string[], fromLine: number, toLine: number, insert: string, anchorFirst: number, anchorLast: number): MoveChange[] | null {
    if (anchorFirst < fromLine || anchorLast > toLine || anchorLast < anchorFirst) return null
    const before = lines.slice(fromLine, anchorFirst)
    const anchor = lines.slice(anchorFirst, anchorLast + 1)
    const after = lines.slice(anchorLast + 1, toLine + 1)
    const found = locate(before, anchor, after, insert.split('\n'))
    if (!found) return null
    const count = found.at - before.length
    const passed = count === 0 ? { changes: [], lead: '' } : carried(lines, anchorFirst, anchorLast, count)
    const changes = [...passed.changes, ...reindented(lines, anchorFirst, anchorLast, found.delta, passed.lead)]
    return changes.sort((a, b) => a.from - b.from || a.to - b.to)
}

/** `text` with `changes` (offsets into `text`, not overlapping) applied: what the rule tests check a move against. */
export function applyMoveChanges(text: string, changes: readonly MoveChange[]): string {
    let out = ''
    let at = 0
    for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
        out += text.slice(at, change.from) + change.insert
        at = change.to
    }
    return out + text.slice(at)
}
