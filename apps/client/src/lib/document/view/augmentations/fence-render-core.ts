/**
 * Pure extraction of the renderer-dispatched fences (ADR 0022): the **complete** fenced
 * blocks whose opener carries an info-string, with the interior de-indented to the fence
 * column as the renderer's source. Built on the same column-scoped pairing as everything
 * else ({@link fencedBlocks}) — never a second notion of "in a block".
 */

import { fencedBlocks, fenceLineInfo } from '../../fenced-code'

export interface RenderableFence {
    /** 0-based line index of the opening fence. */
    start: number
    /** 0-based line index of the closing fence. */
    end: number
    /** The column the fence and its content are clamped to. */
    fenceColumn: number
    /** The opener's info-string (always non-empty here). */
    info: string
    /** Form-1: the opener is a bullet line (`- ```info`) — the marker must stay visible text. */
    bulletOpener: boolean
    /** Interior lines de-indented by fenceColumn, joined with '\n'. */
    source: string
}

/** The complete fenced blocks whose opener carries an info-string — the renderer-dispatch set. */
export function renderableFences(lines: string[]): RenderableFence[] {
    const out: RenderableFence[] = []
    for (const block of fencedBlocks(lines)) {
        const opener = fenceLineInfo(lines[block.start])
        if (!opener || !opener.info) continue
        const source = lines
            .slice(block.start + 1, block.end)
            .map((l) => (l.length >= block.fenceColumn ? l.slice(block.fenceColumn) : ''))
            .join('\n')
        out.push({
            start: block.start,
            end: block.end,
            fenceColumn: block.fenceColumn,
            info: opener.info,
            bulletOpener: opener.bullet,
            source,
        })
    }
    return out
}
