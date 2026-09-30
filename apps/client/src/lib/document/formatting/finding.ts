/**
 * What a [[Formatting Check]] is and what it returns (ADR 0109), and the helpers every check reads
 * and reports through. The registry is `checks.ts`.
 */

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { changedLineIndices, joinLines, type SourceLine, splitLines } from './line-diff'

export type FormattingCheckId = 'no-break-space-indent' | 'bullet-marker' | 'indentation' | 'line-endings' | 'unclosed-fence'

/**
 * A document's whole text, frontmatter included, as every check reads it: split into lines once,
 * with the two things most checks skip already found.
 */
export interface CheckedText {
    text: string
    lines: readonly SourceLine[]
    /** Each line's text without its ending: what the editor's line-shaped readers take. */
    texts: readonly string[]
    /** How many lines the frontmatter occupies, delimiters included; 0 when there is none. */
    frontmatter: number
    /** The fenced code blocks the editor pairs (ADR 0020). */
    fencedBlocks: readonly FencedBlockRange[]
}

export function checkedText(text: string): CheckedText {
    const lines = splitLines(text)
    const texts = lines.map((line) => line.text)
    return { text, lines, texts, frontmatter: frontmatterLines(texts), fencedBlocks: fencedBlocks(texts) }
}

/** One check's finding on one document: a Formatting Issue once the scan knows the page. */
export interface FormattingFinding {
    /** 0-based lines the finding is on: the lines the fix changes, or the lines reported. */
    lines: readonly number[]
    /** The whole fixed text, or null for a check that only reports. */
    fixed: string | null
    /** Why the page was flagged, shown on its row: lower case, no full stop, unless it is sentences. */
    reason: string
}

/** One way a document's markdown departs from the form EtherPK writes. */
export interface FormattingCheck {
    id: FormattingCheckId
    /** The heading its issues are grouped under. */
    label: string
    /** One or two sentences under the heading: what the check finds and why it matters. */
    help: string
    /** This check's finding on a document, or null. Pure, and never throws on odd text. */
    find(source: CheckedText): FormattingFinding | null
}

/**
 * The finding for a fix that rewrites `source`'s lines as `fixed`, or null when the fix changes
 * nothing. `fixed` must hold as many lines as `source`: a fix rewrites lines in place, which is what
 * lets the diff compare line by line and the write splice line by line.
 */
export function fixFinding(source: CheckedText, fixed: readonly SourceLine[], reason: (changed: readonly number[]) => string): FormattingFinding | null {
    if (fixed.length !== source.lines.length) throw new Error(`A formatting fix must keep every line: ${source.lines.length} lines became ${fixed.length}`)
    const changed = changedLineIndices(source.lines, fixed)
    if (changed.length === 0) return null
    return { lines: changed, fixed: joinLines(fixed), reason: reason(changed) }
}

/**
 * Per line, a mask of the lines to leave alone: the frontmatter, which is YAML, and every line of
 * each fenced code block, which is code. Blocks are the editor's pairing, whose reading wins over the
 * markdown parser's where the two disagree on text off the grid (ADR 0109).
 */
export function metadataAndCodeLines(source: CheckedText): Uint8Array {
    const skip = new Uint8Array(source.lines.length)
    skip.fill(1, 0, source.frontmatter)
    for (const block of source.fencedBlocks) skip.fill(1, block.start, block.end + 1)
    return skip
}
