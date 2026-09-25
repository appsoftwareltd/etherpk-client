/**
 * Shared structural analysis for editor augmentations.
 *
 * CodeMirror updates this field once for a document transaction. Selection and viewport
 * changes reuse the same facts, avoiding the previous independent whole-document scans in
 * tables, fences, images, wikilinks, clamping and outline guides.
 */
import { MapMode, StateField, type Extension, type Text, type Transaction } from '@codemirror/state'
import { defangFence, fencedBlocks, fenceLineInfo, type FencedBlockRange } from '../../fenced-code'
import { imageLineKind, type ImageLineKind } from '../../image-line'
import { outlineLines, type OutlineLine } from '../../indent-unit'
import { findTables, type MarkdownTable } from '../../markdown-table'
import { codeRanges, type CodeRange } from '../../wikilink/code-ranges'
import { frontmatterSpan, isFrontmatterDelimiter } from '$lib/storage/fs/frontmatter-span'

import { wikilinkSegmentsInSource } from '../../wikilink/source'
import { renderableFences, type RenderableFence } from '../augmentations/fence-render-core'
import { branchEnds } from '../augmentations/outline-guides-core'

export interface EditorImageLine {
    line: number
    kind: ImageLineKind
}

export interface EditorAnalysis {
    lines: readonly string[]
    fencedBlocks: readonly FencedBlockRange[]
    renderableFences: readonly RenderableFence[]
    tables: readonly MarkdownTable[]
    codeRanges: readonly CodeRange[]
    /** End offset of leading YAML frontmatter, or -1 when the document has none. */
    frontmatterEnd: number
    /**
     * The 0-based index of a bare fence line the user has just added that leaves the document
     * unbalanced, or null. While pending it is treated as plain text by every fence consumer:
     * otherwise a freshly typed opener pairs with the next bare fence below, which is some
     * existing block's opener, and everything between is restyled as code until the closer is
     * typed. It stays pending, mapped through edits, until the document balances with it.
     */
    pendingFence: number | null
    wikilinks: ReturnType<typeof wikilinkSegmentsInSource>
    branchEnds: readonly number[]
    /**
     * Each line's structural depth and owning bullet (the Indent Unit walk, ADR 0067) — what the
     * content clamp indents by, so a four-space child renders at the same depth as a two-space one.
     */
    outline: readonly OutlineLine[]
    imageLines: readonly EditorImageLine[]
    /** Present only when the latest document transaction used the local line-update path. */
    incremental?: {
        oldFrom: number
        oldTo: number
        newFrom: number
        newTo: number
    }
}

let fullAnalysisCount = 0
let incrementalAnalysisCount = 0

/**
 * End offset of the document's [[Frontmatter]], or -1 when it has none.
 *
 * The rule itself lives in `frontmatter-span.ts`, shared with the storage parse and the reveal
 * offset. This used to keep its own: it also accepted `...` as a closer and treated an
 * UNTERMINATED opener as frontmatter running to the end of the document, so typing `---` at the
 * top suppressed wikilink and slash completion everywhere below it, and a file closed with
 * `...` was frontmatter here while storage read no title from it at all.
 */
function frontmatterEnd(source: string): number {
    const span = frontmatterSpan(source)
    if (!span) return -1
    // The span's `end` is where the BODY starts - what a slice wants. Every consumer here asks
    // `frontmatterEnd >= pos`, so what they want is the last offset still INSIDE Frontmatter:
    // the end of the closing delimiter's text, before its terminator. One off, and the first
    // line of the body stops being toggleable and loses its completions.
    return span.end > 0 && source[span.end - 1] === '\n' ? span.end - 1 : span.end
}

/**
 * Wikilink segments outside [[Frontmatter]]. Frontmatter is verbatim metadata, opaque like a
 * [[Fenced Code Block]] - and the [[Derived Index]] derives over the BODY, so a `[[Wikilink]]`
 * written up there makes no [[Backlink]]. Decorating it as a live link was the editor promising
 * something the graph never did. Filtered here rather than in the augmentation, so every
 * consumer of `wikilinks` gets the same answer.
 */
function wikilinksOutsideFrontmatter(
    source: string,
    ranges: readonly CodeRange[],
): ReturnType<typeof wikilinkSegmentsInSource> {
    const segments = wikilinkSegmentsInSource(source, ranges)
    const end = frontmatterEnd(source)
    return end < 0 ? segments : segments.filter((segment) => segment.start >= end)
}

/** A bare fence line: three or more backticks, no info string, whatever its indent. */
function isBareFence(line: string): boolean {
    const f = fenceLineInfo(line)
    return f !== null && f.info === ''
}

/** Whether every fence line sits inside some complete block (the pending line excepted). */
function balanced(lines: readonly string[], blocks: readonly FencedBlockRange[], pending: number | null): boolean {
    return lines.every((l, i) => i === pending || !fenceLineInfo(l) || blocks.some((b) => i >= b.start && i <= b.end))
}

/** The lines with the pending fence defanged, so the scans pair the others as they were. */
function withoutPending(lines: string[], pending: number | null): string[] {
    return pending === null ? lines : lines.map((l, i) => (i === pending ? defangFence(l) : l))
}

/**
 * Which fence line, if any, to hold pending (see {@link EditorAnalysis.pendingFence}): the one
 * carried from the previous analysis if its line is still a bare fence, else the single bare
 * fence line this transaction introduced, and only while the document is unbalanced.
 */
function resolvePending(lines: string[], previous: EditorAnalysis | undefined, tr: Transaction | undefined): number | null {
    if (balanced(lines, fencedBlocks(lines), null)) return null
    if (!previous || !tr) return null
    const oldDoc = tr.startState.doc
    const mapLine = (oldIndex: number): number | null => {
        const pos = tr.changes.mapPos(oldDoc.line(oldIndex + 1).from, 1, MapMode.TrackDel)
        return pos === null ? null : tr.newDoc.lineAt(pos).number - 1
    }
    if (previous.pendingFence !== null) {
        const carried = mapLine(previous.pendingFence)
        if (carried !== null && isBareFence(lines[carried])) return carried
    }
    const before = new Set<number>()
    previous.lines.forEach((l, i) => {
        if (!fenceLineInfo(l)) return
        const mapped = mapLine(i)
        if (mapped !== null) before.add(mapped)
    })
    const fresh: number[] = []
    lines.forEach((l, i) => {
        if (isBareFence(l) && !before.has(i)) fresh.push(i)
    })
    if (fresh.length !== 1) return null
    // Only an opener is held: a fresh bare fence that a block below needs as its closer would, if
    // defanged, dissolve that block (a whole-document replacement introduces its closers as "fresh").
    const raw = fencedBlocks(lines).length
    return fencedBlocks(withoutPending(lines, fresh[0])).length >= raw ? fresh[0] : null
}

function analyse(doc: Text, previous?: EditorAnalysis, tr?: Transaction): EditorAnalysis {
    fullAnalysisCount += 1
    const source = doc.toString()
    const lines = source.split('\n')
    const ranges = codeRanges(source)
    const pendingFence = resolvePending(lines, previous, tr)
    const scanned = withoutPending(lines, pendingFence)
    const blocks = fencedBlocks(scanned)
    // Fenced content is opaque: an image line or a table inside a fence is code (the incremental
    // path applies the same rule through `insideFence`).
    const inFence = new Array<boolean>(lines.length).fill(false)
    for (const b of blocks) for (let k = b.start + 1; k <= b.end; k++) inFence[k] = true
    const imageLines: EditorImageLine[] = []
    for (let line = 0; line < lines.length; line += 1) {
        if (inFence[line]) continue
        const kind = imageLineKind(lines[line])
        if (kind) imageLines.push({ line: line + 1, kind })
    }
    return {
        lines,
        fencedBlocks: blocks,
        renderableFences: renderableFences(scanned),
        tables: findTables(source).filter((t) => !inFence[t.startLine]),
        codeRanges: ranges,
        frontmatterEnd: frontmatterEnd(source),
        wikilinks: wikilinksOutsideFrontmatter(source, ranges),
        branchEnds: branchEnds(lines, blocks),
        outline: outlineLines(lines, blocks),
        imageLines,
        pendingFence,
        incremental: undefined,
    }
}

interface SingleLineChange {
    oldLineNumber: number
    oldLineFrom: number
    oldLineTo: number
    newLineFrom: number
    newLineText: string
}

function structuralPrefix(line: string): string {
    return /^(\s*(?:-\s(?:\[[ xX]\]\s)?)?)/.exec(line)?.[1] ?? ''
}

/**
 * Return the one ordinary line edit which can be updated locally.
 *
 * Structural edits deliberately fall back to a fresh analysis. This keeps the incremental
 * path easy to reason about while making the overwhelmingly common operation, typing within
 * existing prose or a bullet, independent of total document length.
 */
function ordinarySingleLineChange(transaction: Transaction): SingleLineChange | null {
    let result: SingleLineChange | null = null
    let count = 0
    transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        count += 1
        if (count > 1 || inserted.lines !== 1) return
        const oldStart = transaction.startState.doc.lineAt(fromA)
        const oldEnd = transaction.startState.doc.lineAt(toA)
        const nextStart = transaction.newDoc.lineAt(fromB)
        const nextEnd = transaction.newDoc.lineAt(toB)
        if (oldStart.number !== oldEnd.number || nextStart.number !== nextEnd.number) return

        const oldText = oldStart.text
        const newText = nextStart.text
        const removed = transaction.startState.sliceDoc(fromA, toA)
        // These characters can open or close Markdown regions whose effect crosses a line.
        if (/[`~<>|]/.test(removed) || /[`~<>|]/.test(inserted.toString())) return
        // A fence line edited without a backtick (an info string typed after ```) still changes pairing.
        if (fenceLineInfo(oldText) || fenceLineInfo(newText)) return
        // A delimiter line made or unmade - the third `-` of a closer typed, a `-` deleted from
        // one - forms or dissolves the Frontmatter block, whose end the incremental path can only
        // map, never discover. Without this the guard on the block's seam read a stale "no block"
        // on the keystroke after a hand-typed closer.
        if (isFrontmatterDelimiter(oldText) || isFrontmatterDelimiter(newText)) return
        if (oldText.includes('|') || newText.includes('|')) return
        if (structuralPrefix(oldText) !== structuralPrefix(newText)) return
        if ((oldText.trim() === '') !== (newText.trim() === '')) return

        result = {
            oldLineNumber: oldStart.number,
            oldLineFrom: oldStart.from,
            oldLineTo: oldStart.to,
            newLineFrom: nextStart.from,
            newLineText: newText,
        }
    })
    return count === 1 ? result : null
}

function mapWikilink(
    segment: EditorAnalysis['wikilinks'][number],
    transaction: Transaction,
): EditorAnalysis['wikilinks'][number] {
    return {
        ...segment,
        start: transaction.changes.mapPos(segment.start, -1),
        end: transaction.changes.mapPos(segment.end, 1),
        wikilink: {
            ...segment.wikilink,
            start: transaction.changes.mapPos(segment.wikilink.start, -1),
            end: transaction.changes.mapPos(segment.wikilink.end, 1),
        },
    }
}

function analyseIncrementally(
    previous: EditorAnalysis,
    transaction: Transaction,
    change: SingleLineChange,
): EditorAnalysis {
    incrementalAnalysisCount += 1
    const lineIndex = change.oldLineNumber - 1
    const lines = [...previous.lines]
    lines[lineIndex] = change.newLineText

    const insideFence = previous.fencedBlocks.some(
        (block) => lineIndex >= block.start && lineIndex <= block.end,
    )
    // An ordinary edit cannot change what is code: backticks, tildes and structural-prefix
    // changes all fall back to a full analysis. The previous parse's ranges, mapped through
    // this transaction, are therefore authoritative — the one thing they must NOT be
    // replaced with is a context-free reparse of the line alone, which reads any bullet
    // nested two levels deep (four leading spaces) as an indented code block and silently
    // suppresses every wikilink on it until the next structural edit (live, 2026-07-31:
    // new links in outliner blocks only styled on Enter).
    // Boundary associativity excludes, never absorbs: text typed at the exact edge of an
    // inline-code range is outside the backticks, so it must not extend the suppression.
    const mappedCodeRanges = previous.codeRanges.map((range) => ({
        from: transaction.changes.mapPos(range.from, 1),
        to: transaction.changes.mapPos(range.to, -1),
    }))
    // A line whose whole CONTENT the previous parse placed inside a code range is a
    // code-block line; ordinary edits keep it one (block code has no closing delimiter on
    // the line, so the boundary-exclusion mapping above must not let an append escape it).
    // Content, not line start: an indented CodeBlock node begins after the indent.
    const oldLineText = previous.lines[lineIndex] ?? ''
    const oldContentFrom =
        change.oldLineFrom + (oldLineText.length - oldLineText.trimStart().length)
    const lineWasCode = previous.codeRanges.some(
        (range) => range.from <= oldContentFrom && range.to >= change.oldLineTo,
    )
    const newLineTo = change.newLineFrom + change.newLineText.length
    const lineLocalCodeRanges = mappedCodeRanges
        .filter((range) => range.to > change.newLineFrom && range.from < newLineTo)
        .map((range) => ({
            from: Math.max(0, range.from - change.newLineFrom),
            to: Math.min(change.newLineText.length, range.to - change.newLineFrom),
        }))
    const renderableFences = previous.renderableFences.map((fence) => {
        if (lineIndex <= fence.start || lineIndex >= fence.end) return fence
        return {
            ...fence,
            source: lines
                .slice(fence.start + 1, fence.end)
                .map((line) =>
                    line.length >= fence.fenceColumn
                        ? line.slice(fence.fenceColumn)
                        : '',
                )
                .join('\n'),
        }
    })
    const localWikilinks = insideFence || lineWasCode
        ? []
        : wikilinkSegmentsInSource(change.newLineText, lineLocalCodeRanges).map((segment) => ({
              ...segment,
              start: segment.start + change.newLineFrom,
              end: segment.end + change.newLineFrom,
              wikilink: {
                  ...segment.wikilink,
                  start: segment.wikilink.start + change.newLineFrom,
                  end: segment.wikilink.end + change.newLineFrom,
              },
          }))
    const wikilinks = previous.wikilinks
        .filter(
            (segment) =>
                segment.end <= change.oldLineFrom || segment.start >= change.oldLineTo,
        )
        .map((segment) => mapWikilink(segment, transaction))
        .concat(localWikilinks)
        .sort((a, b) => a.start - b.start)

    const imageLines = previous.imageLines.filter((image) => image.line !== change.oldLineNumber)
    const kind = !insideFence && !lineWasCode ? imageLineKind(change.newLineText) : null
    if (kind) imageLines.push({ line: change.oldLineNumber, kind })
    imageLines.sort((a, b) => a.line - b.line)

    return {
        ...previous,
        lines,
        renderableFences,
        codeRanges: mappedCodeRanges,
        frontmatterEnd:
            previous.frontmatterEnd < 0
                ? previous.frontmatterEnd
                : transaction.changes.mapPos(previous.frontmatterEnd, 1),
        wikilinks,
        imageLines,
        pendingFence: previous.pendingFence,
        incremental: {
            oldFrom: change.oldLineFrom,
            oldTo: change.oldLineTo,
            newFrom: change.newLineFrom,
            newTo: change.newLineFrom + change.newLineText.length,
        },
    }
}

export const editorAnalysisField = StateField.define<EditorAnalysis>({
    create: (state) => analyse(state.doc),
    update(value, transaction) {
        if (!transaction.docChanged) return value
        const change = ordinarySingleLineChange(transaction)
        // Editing an opener or closer can change the fence language or pairing even when
        // the inserted character is not itself a backtick. Interior source edits are safe
        // to update within the one containing fence.
        const changedLine = change?.oldLineNumber ? change.oldLineNumber - 1 : -1
        const touchesFenceBoundary =
            change !== null &&
            value.fencedBlocks.some(
                (block) => changedLine === block.start || changedLine === block.end,
            )
        return change && !touchesFenceBoundary
            ? analyseIncrementally(value, transaction, change)
            : analyse(transaction.newDoc, value, transaction)
    },
})

export function editorAnalysis(): Extension {
    return editorAnalysisField
}

export function analysisFor(state: { field<T>(field: StateField<T>, require?: boolean): T }): EditorAnalysis {
    return state.field(editorAnalysisField)
}

/** Test and development diagnostics. Labels and counts contain no document content. */
export function editorAnalysisDiagnostics(): { fullAnalyses: number; incrementalAnalyses: number } {
    return { fullAnalyses: fullAnalysisCount, incrementalAnalyses: incrementalAnalysisCount }
}

export function resetEditorAnalysisDiagnostics(): void {
    fullAnalysisCount = 0
    incrementalAnalysisCount = 0
}
