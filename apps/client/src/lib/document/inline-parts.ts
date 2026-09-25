/**
 * What one line of document source holds, for a surface that **renders it without editing it** —
 * the references [[View]] being the first.
 *
 * The editor draws wikilinks, hyperlinks, [[Asset Reference]]s and images as CodeMirror
 * decorations, and every one of those needs an `EditorView`, a syntax tree over the whole
 * document and a viewport. A panel showing single lines lifted out of *other* documents has none
 * of them. So the rules are read here instead, over plain text.
 *
 * The rules are not restated: they are the very functions the augmentations call —
 * `wikilinkSegmentsInSource` (wikilink/source.ts), `linkPieces` (markdown-link-core.ts, asked for
 * its caret-off-the-line rendering, which is the one a read-only surface always wants),
 * `assetNameFromRef` (asset-store.ts), `parseImageLine` (image-line.ts) and `scanInlineMath`
 * (math-inline-core.ts). The inline marks (bold, italic, code, strikethrough, highlight) are the
 * syntax tree's, read the way markdown-format.ts reads it: each mark node styles its text and its
 * marker nodes are hidden, since a read-only line never has the caret on it. Anything none of them
 * claims stays plain text, exactly as it does in the editor. That is what stops the panel and the
 * editor disagreeing about what a construct *is* — the failure this module exists to prevent, and
 * the reason it reuses the editor's markdown parser rather than a regex of its own.
 *
 * One deliberate difference. An [[Asset Reference]] renders as its **label**, not its raw
 * markdown. The editor leaves `[Q3](../assets/q3.a1b2c3d4.pdf)` visible because the caret has to
 * be able to edit it; a panel that cannot edit it has nothing to gain from showing a content hash.
 * Hyperlinks need no such judgement — hiding their syntax is what the editor already does the
 * moment the caret leaves the line.
 *
 * Pure over the line's text: no DOM, no CodeMirror.
 */

import type { Tree } from '@lezer/common'
import { parser } from '@lezer/markdown'

import { assetNameFromRef, displayNameForRef } from '$lib/storage/fs/asset-store'

import { parseImageLine } from './image-line'
import { markdownLinks } from './markdown-link-target'
import { parseImageDisplaySizeHint } from './view/augmentations/image-display-size'
import { linkPieces } from './view/augmentations/markdown-link-core'
import { scanInlineMath } from './view/augmentations/math-inline-core'
import { editorMarkdownExtensions } from './view/augmentations/scheme-url-autolink'
import { codeRanges, isInCode, wikilinkSegmentsInSource } from './wikilink'

/**
 * The editor's own markdown parser — GFM plus this app's extensions (scheme-url-autolink.ts) — so
 * a url is recognised here exactly where the editor recognises one, `http://localhost:5285/…`
 * included.
 */
export const markdownParser = parser.configure(editorMarkdownExtensions)

/** A style over a run of a line, as the editor applies it (markdown-format.ts). */
export type InlineMark = 'strong' | 'em' | 'code' | 'strike' | 'highlight'

/** The order a part's marks are listed in, whatever order they were written in. */
const MARK_ORDER: readonly InlineMark[] = ['strong', 'em', 'code', 'strike', 'highlight']

/** Syntax node → the mark it applies: the inline half of markdown-format.ts's `STYLE` table. */
const MARK_NODES: Readonly<Record<string, InlineMark>> = {
    StrongEmphasis: 'strong',
    Emphasis: 'em',
    InlineCode: 'code',
    Strikethrough: 'strike',
    Highlight: 'highlight',
}

/** The marker nodes markdown-format.ts hides off the caret's line, the inline ones. */
const MARKER_NODES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HighlightMark'])

/** One run of a line: a stretch of plain text, or a construct that renders as something. */
type InlinePartBody =
    | { kind: 'text'; text: string }
    /** A `[[…]]`, brackets and all — as the editor shows it. `concept` is what a click opens. */
    | { kind: 'wikilink'; text: string; concept: string }
    /** An external hyperlink: `text` is what to show, `href` what to open (already vetted). */
    | { kind: 'link'; text: string; href: string }
    /** A [[File Link]]: `text` is what to show, `path` the native path a click copies. */
    | { kind: 'file-link'; text: string; path: string }
    /** A reference to a file in this graph: `text` is its label, `ref` what the actions act on. */
    | { kind: 'asset'; text: string; ref: string }
    /** A picture: an asset reference or a remote url, with the alt text's display-size hint read. */
    | { kind: 'image'; alt: string; url: string; maxWidth?: number; maxHeight?: number }
    /** Inline math: `text` is the source, `$` and all, shown until (or unless) `tex` renders. */
    | { kind: 'math'; text: string; tex: string }

/** A run of a line, with the marks over it, when there are any. */
export type InlinePart = InlinePartBody & { marks?: readonly InlineMark[] }

/** A claimed span of the line and what it renders as; `null` is markdown syntax, shown as nothing. */
interface Claim {
    from: number
    to: number
    part: InlinePartBody | null
}

/**
 * Every [[Asset Reference]] on the line, image syntax included. This is the same rule
 * `asset-link.ts` applies: a target that names a file under `assets/` is an asset reference
 * whichever bracket shape it was written in, and one inside code is not a reference at all.
 */
function assetClaims(text: string): Claim[] {
    const ranges = codeRanges(text)
    const claims: Claim[] = []
    for (const link of markdownLinks(text)) {
        if (isInCode(ranges, link.from, link.to)) continue
        if (assetNameFromRef(link.target) === null) continue
        // An image's label carries the display-size hint, which is a rendering instruction rather
        // than part of the name; a link's does not, and `[Q3|300](…)` means a label with a pipe.
        const label = link.bang === '!' ? parseImageDisplaySizeHint(link.label).cleanAlt : link.label
        claims.push({
            from: link.from,
            to: link.to,
            // An empty label would render as nothing to click. The file's own name is the honest
            // stand-in, and it is what the download hands over anyway.
            part: { kind: 'asset', text: label.trim() || displayNameForRef(link.target), ref: link.target },
        })
    }
    return claims
}

/**
 * Every hyperlink on the line, plus the syntax each one hides — `linkPieces`' own answer, asked
 * with no active line, because a surface with no caret always wants the rendered form.
 */
function hyperlinkClaims(text: string, tree: Tree): Claim[] {
    const pieces = linkPieces({
        tree,
        sliceDoc: (from, to) => text.slice(from, to),
        from: 0,
        to: text.length,
        isActiveLine: () => false,
    })
    return pieces.map((piece) => {
        const label = text.slice(piece.from, piece.to)
        switch (piece.kind) {
            case 'link':
                return { from: piece.from, to: piece.to, part: { kind: 'link' as const, text: label, href: piece.href } }
            case 'file-link':
                return { from: piece.from, to: piece.to, part: { kind: 'file-link' as const, text: label, path: piece.path } }
            default:
                return { from: piece.from, to: piece.to, part: null }
        }
    })
}

function wikilinkClaims(text: string): Claim[] {
    return wikilinkSegmentsInSource(text).map((segment) => ({
        from: segment.start,
        to: segment.end,
        part: {
            kind: 'wikilink' as const,
            text: text.slice(segment.start, segment.end),
            concept: segment.wikilink.concept,
        },
    }))
}

/** Every inline math span on the line: the editor's scanner, which already passes over inline code. */
function mathClaims(text: string): Claim[] {
    if (!text.includes('$')) return []
    return scanInlineMath(text).map((span) => ({
        from: span.from,
        to: span.to,
        part: { kind: 'math' as const, text: text.slice(span.from, span.to), tex: span.tex },
    }))
}

/** A part and the stretch of the line it came from. */
interface Placed {
    from: number
    to: number
    part: InlinePartBody
}

/** The line's mark spans and the marker ranges hidden with them, off the syntax tree. */
function markSpans(tree: Tree): { marks: { from: number; to: number; mark: InlineMark }[]; hidden: [number, number][] } {
    const marks: { from: number; to: number; mark: InlineMark }[] = []
    const hidden: [number, number][] = []
    tree.iterate({
        enter(node) {
            const mark = MARK_NODES[node.name]
            if (mark) marks.push({ from: node.from, to: node.to, mark })
            // A `CodeMark` also fences a code block; only inline code's backticks are hidden.
            else if (MARKER_NODES.has(node.name) && (node.name !== 'CodeMark' || node.node.parent?.name === 'InlineCode')) {
                hidden.push([node.from, node.to])
            }
        },
    })
    return { marks, hidden }
}

/**
 * The parts with the marks applied. A text part is cut where a mark or a hidden marker starts or
 * ends, its marker pieces dropped and each remaining piece given the marks over it. A construct
 * (a link, an asset, math) is one thing: it takes the marks that cover it whole, and markers
 * inside it are left to it.
 */
function applyMarks(text: string, placed: Placed[], tree: Tree): InlinePart[] {
    const { marks, hidden } = markSpans(tree)
    if (marks.length === 0) return placed.map((p) => p.part)
    const marksOver = (from: number, to: number): InlineMark[] =>
        MARK_ORDER.filter((mark) => marks.some((span) => span.mark === mark && span.from <= from && to <= span.to))
    const withMarks = (part: InlinePartBody, over: InlineMark[]): InlinePart => (over.length > 0 ? { ...part, marks: over } : part)
    const out: InlinePart[] = []
    for (const { from, to, part } of placed) {
        if (part.kind !== 'text') {
            out.push(withMarks(part, marksOver(from, to)))
            continue
        }
        const cuts = new Set([from, to])
        for (const span of marks) for (const edge of [span.from, span.to]) if (edge > from && edge < to) cuts.add(edge)
        for (const [a, b] of hidden) for (const edge of [a, b]) if (edge > from && edge < to) cuts.add(edge)
        const edges = [...cuts].sort((a, b) => a - b)
        for (let k = 0; k + 1 < edges.length; k++) {
            const [a, b] = [edges[k], edges[k + 1]]
            if (hidden.some(([h0, h1]) => h0 <= a && b <= h1)) continue
            const over = marksOver(a, b)
            const previous = out[out.length - 1]
            // Pieces cut apart by an edge that changed nothing (a marker's far side) join again.
            if (previous?.kind === 'text' && (previous.marks ?? []).join() === over.join()) {
                out[out.length - 1] = withMarks({ kind: 'text', text: previous.text + text.slice(a, b) }, over)
            } else {
                out.push(withMarks({ kind: 'text', text: text.slice(a, b) }, over))
            }
        }
    }
    return out
}

function scan(text: string): InlinePart[] {
    // A line whose only content is one image IS the picture — the same judgement the editor's
    // embed makes (image-line.ts), so a bullet holding nothing but a diagram shows the diagram.
    // An image written mid-sentence is not an image line, here as in the editor: it falls through
    // to the asset claim below and renders as a link to the file.
    const image = parseImageLine(text)
    if (image) {
        const parts: InlinePart[] = []
        // Normally nothing: the panel's labels arrive with their bullet marker already stripped.
        const marker = text.slice(0, image.imageStart)
        if (marker) parts.push({ kind: 'text', text: marker })
        const { cleanAlt, maxWidth, maxHeight } = parseImageDisplaySizeHint(image.alt)
        parts.push({ kind: 'image', alt: cleanAlt, url: image.url, maxWidth, maxHeight })
        return parts
    }

    const tree = markdownParser.parse(text)
    const claims = [...assetClaims(text), ...hyperlinkClaims(text, tree), ...wikilinkClaims(text), ...mathClaims(text)]
    // Document order, widest first, so a construct written inside another — a wikilink in a
    // hyperlink's label — loses to the one enclosing it rather than splitting it in half.
    claims.sort((a, b) => a.from - b.from || b.to - a.to)

    const placed: Placed[] = []
    let pos = 0
    const pushTextUpTo = (to: number) => {
        if (to > pos) placed.push({ from: pos, to, part: { kind: 'text', text: text.slice(pos, to) } })
    }
    for (const claim of claims) {
        if (claim.from < pos) continue // inside a claim already taken
        pushTextUpTo(claim.from)
        if (claim.part) placed.push({ from: claim.from, to: claim.to, part: claim.part })
        pos = claim.to
    }
    pushTextUpTo(text.length)
    return applyMarks(text, placed, tree)
}

/**
 * Reading a line costs a markdown parse plus three scans, and the Backlinks panel re-renders
 * every one of its lines whenever the graph index updates — which is after every edit. So results
 * are remembered against the text, which is all they depend on. Cleared wholesale rather than
 * evicted one at a time: the cost being avoided is per-render, not per-line, and a graph does not
 * hold enough distinct reference lines for the difference to matter.
 */
const CACHE_LIMIT = 500
const cache = new Map<string, InlinePart[]>()

/**
 * The parts of `text`, in document order. The returned array is shared between callers and must
 * not be mutated.
 */
export function inlineParts(text: string): InlinePart[] {
    const remembered = cache.get(text)
    if (remembered) return remembered
    const parts = scan(text)
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(text, parts)
    return parts
}
