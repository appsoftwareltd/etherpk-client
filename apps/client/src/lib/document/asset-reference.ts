/**
 * Where an [[Asset Reference]] sits in a line, and what removing it should take out.
 *
 * The rule, one sentence: **the line goes when the reference is all the line holds; otherwise
 * only the reference goes.** A standalone image, a bullet whose sole content is the asset, and
 * a checked task holding nothing but a PDF link are all "all the line holds" — what is left
 * behind after the span is cut is at most a marker and whitespace, and a bare `- ` is debris
 * rather than content. A reference written mid-sentence loses only its own span, so the prose
 * closes up around it.
 *
 * That is the same judgement `parseImageLine` makes for rendering ("a line whose only content
 * is one markdown image"), widened to cover non-image references, which render as links and so
 * were never image lines.
 *
 * Pure over the line's text: no CodeMirror, no DOM. The caller turns a cut into a transaction
 * and heals the outline afterwards, exactly as a multi-line cut does (ADR 0021).
 */

import { markdownLinks } from './markdown-link-target'

/** What is left of a line once a reference is cut out: a bullet or task marker is not content. */
const MARKER_ONLY = /^\s*(?:-\s*(?:\[[ xX]\]\s*)?)?$/

export interface AssetReferenceSpan {
    /** Offset of the reference within the line, `[from, to)`. Includes the leading `!` of an image. */
    from: number
    to: number
}

/** Every reference to `ref` on `lineText`, in document order. */
export function allAssetReferences(lineText: string, ref: string): AssetReferenceSpan[] {
    const spans: AssetReferenceSpan[] = []
    for (const link of markdownLinks(lineText)) {
        if (link.target === ref) spans.push({ from: link.from, to: link.to })
    }
    return spans
}

/**
 * The span of the reference to `ref` in `lineText`, or `null` when the line holds none. When a
 * line holds the same reference twice, `occurrence` picks which — the augmentations know which
 * one was clicked, and removing the wrong one would look like nothing happened.
 */
export function findAssetReference(lineText: string, ref: string, occurrence = 0): AssetReferenceSpan | null {
    return allAssetReferences(lineText, ref)[occurrence] ?? null
}

export interface AssetReferenceCut {
    /** Line-relative offsets of the text to remove. */
    from: number
    to: number
    /** True when the whole line goes, newline included — the reference was all it held. */
    wholeLine: boolean
}

/**
 * What to remove for the reference occupying `[from, to)` of `lineText`. `wholeLine` reports the
 * caller's obligation: take the line's terminator too, and heal the outline after.
 */
export function assetReferenceCut(lineText: string, span: AssetReferenceSpan): AssetReferenceCut {
    const remainder = lineText.slice(0, span.from) + lineText.slice(span.to)
    if (MARKER_ONLY.test(remainder)) return { from: 0, to: lineText.length, wholeLine: true }
    return { ...span, wholeLine: false }
}
