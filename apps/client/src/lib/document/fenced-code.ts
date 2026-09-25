/**
 * Pure logic for [[Fenced Code Block]]s (ADR 0018, ADR 0020). No CodeMirror imports — the
 * syntax-tree / view glue lives in `view/outliner-context.ts` and `view/fence-guard.ts`.
 *
 * A fence is a run of three or more backticks; the run length is mirrored on completion so
 * a 4-backtick fence balances with 4 (lets a 3-backtick block sit inside one) — and ONLY with
 * 4: a closer is exactly the opener's length, never merely "at least" it as CommonMark allows,
 * so a longer opener below can never be taken as a shorter block's closer (ADR 0020, amended
 * 2026-09-12). The optional info-string after the opener selects the language.
 */

/** A clean opener line is exactly a backtick run (3+) and an optional info-string. */
const FENCE_OPENER = /^(`{3,})\s*([\w+#.-]*)\s*$/
/** A fence line (opener or closer): a bare backtick/tilde run. */
const FENCE_LINE = /^(`{3,}|~{3,})\s*$/
/** A backtick fence line, tolerant of a leading plain-bullet marker (`- `) so `- ``` ` is a fence.
 *  Backticks only (this slice) — tildes are left untouched, so they are not auto-completed. */
const FENCE_LINE_INFO = /^(\s*(?:-\s)?)(`{3,})\s*(\S*)\s*$/

export interface FenceInfo {
    /** Column where the backtick/tilde run starts (after any indent + bullet marker) — the clamp edge. */
    col: number
    /** The full fence run, e.g. ` ``` ` or ` ```` `. */
    run: string
    /** The fence character: `` ` `` or `~`. */
    char: string
    /** Length of the run (3+). */
    len: number
    /** The info-string after the run; `''` for a bare fence (a closer is always bare). */
    info: string
    /** The fence sits on a bullet line (`- ``` `) — so it OPENS a block (form-1) and can never be a
     *  closer: a sibling bullet's opener directly below must not be mistaken for this one's closer. */
    bullet: boolean
}

/** Parse a line as a fence line (opener or closer), tolerant of a leading `- ` bullet. Null if not. */
export function fenceLineInfo(line: string): FenceInfo | null {
    const m = FENCE_LINE_INFO.exec(line)
    if (!m) return null
    return { col: m[1].length, run: m[2], char: m[2][0], len: m[2].length, info: m[3], bullet: m[1].includes('-') }
}

/** Whether `lines[a]` would close an open fence `b` (same char, run of the SAME length, no info, and not
 *  itself a bullet-line opener). */
function closes(a: FenceInfo, open: FenceInfo): boolean {
    return a.info === '' && !a.bullet && a.char === open.char && a.len === open.len
}

export interface FencedBlockRange {
    /** 0-based line index of the opening fence. */
    start: number
    /** 0-based line index of the closing fence. */
    end: number
    /** Column where the fence/content sits (the clamp edge). */
    fenceColumn: number
}

/**
 * The **complete** fenced blocks (opener paired with a closer) by line index — **balance-aware** and
 * **outliner-block-scoped**, so styling never bleeds past where a block actually ends. An unterminated
 * opener is omitted entirely (its region stays unstyled until a closer completes it).
 *
 * Pairing (a fence run is 3+ backticks; tildes are not handled this slice):
 * - A **closer** is a BARE fence (no info-string) at the SAME column as its opener and of the SAME
 *   length. Each closer is consumed once — it can't also close a fence higher up. Exact length
 *   (not CommonMark's "at least") is what keeps a ```` block below a stray ``` intact: the app
 *   mirrors lengths on completion, so nothing legitimate is lost, and a longer opener is never eaten.
 * - A fence with an **info-string** is unambiguously an OPENER, never a closer: an unterminated opener
 *   therefore can't swallow the start of an already-completed block below it (the reported bug).
 * - Pairing is **column-scoped** (one outliner block). A deeper fence (greater column) opens a nested
 *   block that completes independently; a non-blank line that **dedents below** an open fence's column
 *   leaves that block, so the fence can no longer be closed (its closer must live in the same block);
 *   a same-column fence that is LONGER than an unterminated opener — bare or not — or an equal-length
 *   info opener *replaces* it instead of nesting: a longer run can never be a shorter block's content
 *   (CommonMark would close the block with it), so it is the next block's opener, and the shorter
 *   opener above it was a stray. That is what keeps a ```` block whole beneath a dangling ```.
 * - A shorter same-column fence is literal content (e.g. a ``` block inside a ```` one). To hold a
 *   fence as content, the outer fence must be the longer one — the CommonMark convention.
 *
 * `closerTolerance` (default 0 — strict) lets a bare closer sit up to N columns RIGHT of its opener
 * and still pair. Only the source hard-guard uses it (with CommonMark's 3), to recognise a closer
 * that a raw edit/paste nudged right so it can snap it back; every other consumer stays col-exact.
 */
export function fencedBlocks(lines: readonly string[], closerTolerance = 0): FencedBlockRange[] {
    const blocks: FencedBlockRange[] = []
    const stack: { info: FenceInfo; index: number }[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.trim() !== '') {
            // A non-blank line below an open fence's column has left that fence's block — abandon it.
            const indent = line.length - line.trimStart().length
            while (stack.length && stack[stack.length - 1].info.col > indent) stack.pop()
        }
        const f = fenceLineInfo(line)
        if (!f) continue
        const top = stack.length ? stack[stack.length - 1] : null
        if (top && f.col >= top.info.col && f.col - top.info.col <= closerTolerance && closes(f, top.info)) {
            stack.pop()
            blocks.push({ start: top.index, end: i, fenceColumn: top.info.col })
        } else if (!top || f.col > top.info.col) {
            stack.push({ info: f, index: i }) // a fresh opener, or a nested block in a deeper column
        } else if (f.col === top.info.col && (f.len > top.info.len || (f.info !== '' && f.len === top.info.len))) {
            stack.pop() // an unterminated opener can't contain a longer fence, or an info opener, at its column
            stack.push({ info: f, index: i })
        }
        // else: a shorter same-column fence, or a bare fence that closes nothing — literal content, ignore.
    }
    return blocks
}

/**
 * A line of a fenced block as code: the indentation up to the fence's column is structure (the
 * block's place in the outline) and goes; whatever lies past it is the code's own and stays.
 */
export function codeLineText(line: string, fenceColumn: number): string {
    const indent = line.length - line.trimStart().length
    return indent >= fenceColumn ? line.slice(fenceColumn) : line.trimStart()
}

/** A fence line with its backtick/tilde run defanged (indent and bullet marker kept), so a re-scan
 *  pairs the other fences as if this one were plain text. */
export function defangFence(line: string): string {
    return line.replace(/[`~]+/, 'x')
}

/**
 * Whether the fence line at `index` is an **unterminated opener** — the one shape Enter completes.
 * This is fence completion's balance check. A fence a complete block already accounts for — its
 * opener, whether the block is empty or holds content, its closer, or a shorter fence that is its
 * content — is never completed again: doing so grew a second closer under the opener and orphaned the
 * real one (found live: Enter at the end of a content-bearing block's opener). Pairing is the
 * column-scoped scan ({@link fencedBlocks}), so stray or orphaned fences elsewhere in the document
 * never make a fresh opener look paired.
 *
 * One refinement for the moment of typing. Pairing is first-with-next, so an opener typed above an
 * existing block swallows it: a prose opener takes the block's bare opener as its closer, and a bullet
 * opener (which no bullet fence can close) runs on to the block's own closer. Setting the candidate
 * aside and re-pairing tells the two apart by TALLY, counting complete blocks from the candidate down:
 * a genuine opener's block dissolves, so the tally drops — even when its orphaned closer then heads a
 * block of its own by taking the next equal-length opener below, that re-pairing runs one fence
 * short — whereas a fresh opener that had swallowed the block below leaves
 * the tally intact, because setting it aside merely hands that block its own opener back. Asking
 * instead whether any block *starts inside* the candidate's conflated the two (live, 2026-09-11: Enter
 * on the opener of a complete block grew a second closer whenever an equal block followed).
 * Blocks starting above the candidate are left out of the tally: a stray opener up there adopting the
 * candidate's closer says nothing about the candidate. `pending` — the analysis's freshly typed,
 * still unclosed fence — is set aside the same way, as every other fence consumer does, and is itself
 * unterminated by definition.
 */
export function isUnterminatedOpener(lines: readonly string[], index: number, pending: number | null = null): boolean {
    if (!fenceLineInfo(lines[index])) return false
    if (pending === index) return true
    const scanned = pending === null ? lines : lines.map((l, i) => (i === pending ? defangFence(l) : l))
    const paired = fencedBlocks(scanned)
    const block = paired.find((b) => b.start <= index && index <= b.end)
    if (!block) return true // pairs with nothing
    if (block.start !== index) return false // its closer, or a shorter fence that is content
    const without = fencedBlocks(scanned.map((l, i) => (i === index ? defangFence(l) : l)))
    const tally = (blocks: readonly FencedBlockRange[], from: number) => blocks.filter((b) => b.start >= from).length
    return tally(without, index + 1) >= tally(paired, index)
}

/** Parse a line as a fence opener; null if it is not a clean opener. Leading indent is ignored. */
export function parseFenceOpener(line: string): { ticks: string; info: string } | null {
    const m = FENCE_OPENER.exec(line.trimStart())
    if (!m) return null
    return { ticks: m[1], info: m[2] }
}

export interface FenceCompletion {
    /** Text to insert at the end of the opener line (which already holds the indent + ticks). */
    insert: string
    /** Caret position as a character offset into {@link insert}. */
    caretOffset: number
}

/**
 * Build the text that completes a fence on Enter: the (optional) default info-string to finish
 * the opener line, an empty middle line, and a balanced closer — all at `indent` (the content
 * column for a bullet, `''` for prose). Assumes the caret is at the end of the opener line.
 */
export function buildFenceCompletion(opts: {
    indent: string
    ticks: string
    info: string
    defaultLang: string
}): FenceCompletion {
    const { indent, ticks, info, defaultLang } = opts
    const head = info === '' ? defaultLang : '' // finish the opener line with the default lang when bare
    const insert = `${head}\n${indent}\n${indent}${ticks}`
    return { insert, caretOffset: `${head}\n${indent}`.length }
}

/**
 * Normalise a fenced block's lines so it stays valid markdown (ADR 0020 hard guard): pad any
 * under-indented content line up to `fenceColumn`, and clamp + rebalance the **closing** fence
 * (the last line, when it is a bare fence) to `fenceColumn` + the opener's tick count. The opener
 * (line 0) is left untouched, as are blank lines and any fence-looking *content* lines (so a
 * 3-backtick block can live inside a 4-backtick one).
 */
export function normaliseFenceLines(lines: string[], fenceColumn: number, openerTicks: string): string[] {
    const pad = ' '.repeat(fenceColumn)
    const last = lines.length - 1
    return lines.map((line, i) => {
        if (i === 0) return line
        const trimmed = line.trimStart()
        if (i === last && FENCE_LINE.test(trimmed)) return pad + openerTicks
        if (trimmed === '') return line
        const indent = line.length - trimmed.length
        return indent < fenceColumn ? pad + trimmed : line
    })
}
