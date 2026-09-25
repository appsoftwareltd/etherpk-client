/**
 * Where [[Spell Check]] applies, as pure functions over an editor state.
 *
 * EtherPK's checker (ADR 0095) is offered prose and nothing else. Syntax, code, names and metadata
 * are left out, because an underline there is noise and a suggestion there would corrupt the
 * construct: a fenced code block, inline code, a wikilink (a concept name is fixed by renaming the
 * page), a link or image target, an image's size hint, an asset link (its right-click menu is the
 * asset's own, so a spelling menu could not also live there), a task's tag run, inline maths and
 * the frontmatter. The rules are Editor Content Rules → Spell check.
 *
 * Every range comes from a parse the editor already runs: the shared analysis for fences,
 * frontmatter and wikilinks, the markdown syntax tree for inline code, urls, images, HTML entities
 * and emphasis markers, the asset-link augmentation's own scan, and the task-tag and inline-maths
 * grammars. Nothing is re-derived here.
 *
 * "Code" is the editor's own model of it: backtick fences (`fencedBlocks`) and inline code. Not the
 * analysis's `codeRanges`, which is Lezer's wider reading: it takes a deeply indented bullet under
 * a heading for an indented code block, and raw HTML and comments for code, where Editor Content
 * Rules keeps HTML as prose.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, StateEffect, StateField } from '@codemirror/state'

import { checkableWords, type WordRange } from '../../spelling/words'
import { taskTagRun } from '../../task-tags'
import { analysisFor } from '../analysis/editor-analysis'
import { isOwnEditing } from '../own-editing'
import { assetLinkSpans } from './asset-link'
import { parseImageDisplaySizeHint } from './image-display-size'
import { parseInlineLink } from './markdown-link-core'
import { scanInlineMath } from './math-inline-core'
import { isProtectedDocumentFacet } from './protected-fence'

export interface ExcludedSpan {
    from: number
    to: number
}

export interface SpellCheckExclusions {
    /** 1-based numbers of the lines excluded whole: fenced code blocks and the frontmatter. */
    lines: number[]
    /** Sorted, disjoint ranges excluded within the other lines. */
    spans: ExcludedSpan[]
}

/**
 * Carries {@link userEditedField} into an editor that replaced one the user had edited in. A
 * DocumentView remounts its editor inside the same tab: a [[Draft]] promoted by its first
 * keystroke, a document protected or unprotected, a Draft superseded by a real page. `typing` when
 * the user was in the editor it replaced, as they are when their typing promotes a Draft.
 */
export const carryUserEdited = StateEffect.define<{ typing: boolean }>()

/**
 * Whether the user has edited in this editor. [[Spell Check]] waits for it: a document opened to
 * be read shows no underlines. A change counts when it is the user's own editing
 * ({@link isOwnEditing}: typing, a paste, a drop, a deletion, a line move, undo); a collaborator's
 * change, an external write, a file read landing and a caret move that tidied a line do not. Nor do
 * the outliner commands that dispatch with no user event (Enter on a bullet, Shift+Enter, Tab,
 * Shift+Tab, Toggle task): the next character typed starts it. It lasts as long as the editor and
 * is carried across a remount, so closing the tab or reloading starts quiet again, and so does
 * switching tabs on a phone, whose presenter rebuilds the View it shows.
 *
 * State, not the view plugin's own field, so a remount can read it from the outgoing editor
 * after that editor is destroyed.
 */
export const userEditedField = StateField.define<boolean>({
    create: () => false,
    update: (edited, tr) =>
        edited ||
        tr.effects.some((effect) => effect.is(carryUserEdited)) ||
        (tr.docChanged && isOwnEditing(tr)),
})

/** False in an editor without {@link userEditedField}, as in one the user has not touched. */
export function userHasEdited(state: EditorState): boolean {
    return state.field(userEditedField, false) ?? false
}

/**
 * Whether this editor's text is checked now: the device preference, once the user has edited in
 * this tab ({@link userEditedField}), and never a [[Protected Document]], locked or unlocked, so
 * none of its words can reach the shared [[Graph Dictionary]].
 */
export function spellCheckApplies(state: EditorState, enabled: boolean): boolean {
    return enabled && userHasEdited(state) && !state.facet(isProtectedDocumentFacet)()
}

/** What is left out of checking in `[from, to)`: a viewport slice in the editor, the whole document by default. */
export function spellCheckExclusions(state: EditorState, from = 0, to = state.doc.length): SpellCheckExclusions {
    const { doc } = state
    const analysis = analysisFor(state)
    const firstLine = doc.lineAt(from).number
    const lastLine = doc.lineAt(to).number

    const lines = new Set<number>()
    const excludeLines = (first: number, last: number) => {
        for (let n = Math.max(first, firstLine); n <= Math.min(last, lastLine); n++) lines.add(n)
    }
    if (analysis.frontmatterEnd >= 0) excludeLines(1, doc.lineAt(analysis.frontmatterEnd).number)
    for (const block of analysis.fencedBlocks) excludeLines(block.start + 1, block.end + 1)
    // A just-typed opener is plain text to every fence consumer until the document balances, but
    // the line itself is still fence syntax.
    if (analysis.pendingFence !== null) excludeLines(analysis.pendingFence + 1, analysis.pendingFence + 1)

    const spans: ExcludedSpan[] = []
    const exclude = (spanFrom: number, spanTo: number) => {
        if (spanTo > spanFrom && spanTo > from && spanFrom < to) spans.push({ from: spanFrom, to: spanTo })
    }
    for (const segment of analysis.wikilinks) exclude(segment.start, segment.end)
    for (const link of assetLinkSpans(state)) exclude(link.from, link.to)
    syntaxTree(state).iterate({
        from,
        to,
        enter(node) {
            // Inline code, backticks included, every url the parser finds (a link or image target,
            // an autolink, a bare url, a file link) and an HTML entity (`&nbsp;`).
            if (node.name === 'URL' || node.name === 'InlineCode' || node.name === 'Entity') {
                exclude(node.from, node.to)
            } else if (node.name === 'Image') {
                // The alt text is prose; the `|300` display-size hint at its end is not.
                const image = parseInlineLink(state.sliceDoc(node.from + 1, node.to))
                if (!image) return
                const altFrom = node.from + 2 // past `![`
                exclude(altFrom + parseImageDisplaySizeHint(image.label).cleanAlt.length, altFrom + image.label.length)
            }
        },
    })
    for (let n = firstLine; n <= lastLine; n++) {
        if (lines.has(n)) continue
        const line = doc.line(n)
        const run = taskTagRun(line.text)
        if (run) exclude(line.from + run.from, line.from + run.to)
        for (const maths of scanInlineMath(line.text)) exclude(line.from + maths.from, line.from + maths.to)
    }

    return {
        lines: [...lines].sort((a, b) => a - b),
        spans: merge(spans, from, to).filter((span) => !withinLines(state, span, lines)),
    }
}

/** Sort, join overlapping or touching ranges, and clip them to `[from, to)`. */
function merge(spans: ExcludedSpan[], from: number, to: number): ExcludedSpan[] {
    const sorted = spans
        .map((span) => ({ from: Math.max(span.from, from), to: Math.min(span.to, to) }))
        .sort((a, b) => a.from - b.from)
    const out: ExcludedSpan[] = []
    for (const span of sorted) {
        const last = out[out.length - 1]
        if (last && span.from <= last.to) last.to = Math.max(last.to, span.to)
        else out.push(span)
    }
    return out
}

/** Whether every line the span touches is already excluded whole: the span would add nothing. */
function withinLines(state: EditorState, span: ExcludedSpan, lines: ReadonlySet<number>): boolean {
    const last = state.doc.lineAt(span.to).number
    for (let n = state.doc.lineAt(span.from).number; n <= last; n++) if (!lines.has(n)) return false
    return true
}

/** Whole lines covering `ranges`, sorted and merged: what a scan reads, whatever splits the view. */
function wholeLines(state: EditorState, ranges: readonly { from: number; to: number }[]): { from: number; to: number }[] {
    const widened = ranges
        .map((r) => ({ from: state.doc.lineAt(r.from).from, to: state.doc.lineAt(r.to).to }))
        .sort((a, b) => a.from - b.from)
    const out: { from: number; to: number }[] = []
    for (const range of widened) {
        const last = out[out.length - 1]
        if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to)
        else out.push({ ...range })
    }
    return out
}

/**
 * The words [[Spell Check]] asks about in the lines touching `[from, to)`, always whole lines:
 * CodeMirror splits its visible ranges mid-line (at a collapsed inline formula), and exclusions
 * clipped to half a line would let the other half's code and wikilinks through. Prose only:
 * excluded lines are skipped, excluded spans are blanked out (so offsets hold), emphasis markers
 * are blanked (`_italic_` would otherwise read as one `_`-joined identifier, which the word
 * rules skip), and what is left goes through the word rules (`spelling/words.ts`). Offsets are
 * into the document.
 */
export function spellingCandidates(state: EditorState, from = 0, to = state.doc.length): WordRange[] {
    const lineFrom = state.doc.lineAt(from).from
    const lineTo = state.doc.lineAt(to).to
    const { lines, spans } = spellCheckExclusions(state, lineFrom, lineTo)
    const excludedLines = new Set(lines)
    const markers: ExcludedSpan[] = []
    syntaxTree(state).iterate({
        from: lineFrom,
        to: lineTo,
        enter(node) {
            if (node.name === 'EmphasisMark') markers.push({ from: node.from, to: node.to })
        },
    })
    const blank = merge([...spans, ...markers], lineFrom, lineTo)
    const out: WordRange[] = []
    const last = state.doc.lineAt(lineTo).number
    let cursor = 0
    for (let n = state.doc.lineAt(lineFrom).number; n <= last; n++) {
        const line = state.doc.line(n)
        if (excludedLines.has(n)) continue
        // The blank ranges are sorted: skip those ending before this line, blank those overlapping it.
        while (cursor < blank.length && blank[cursor].to <= line.from) cursor++
        let text = line.text
        for (let i = cursor; i < blank.length && blank[i].from < line.to; i++) {
            const a = Math.max(blank[i].from, line.from) - line.from
            const b = Math.min(blank[i].to, line.to) - line.from
            text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b)
        }
        for (const word of checkableWords(text)) out.push({ from: line.from + word.from, to: line.from + word.to, word: word.word })
    }
    return out
}

export interface SpellingScan {
    /** The words to underline. */
    misspelt: WordRange[]
    /** Words with no verdict yet, each once: what to ask the spell service about. */
    unknown: string[]
}

/**
 * What the spelling augmentation draws over `ranges` (the visible ranges, widened to whole lines
 * and merged, so a line split by the view is read once): the misspelt words, and the words still
 * to ask about. `typingAt` is the caret while the user is typing into a word
 * ({@link nextTypingAt}); that word is left alone until the caret leaves it, so a half-typed word
 * never flashes red. A word already flagged is not left alone merely because the caret returns
 * to it.
 */
export function scanSpelling(
    state: EditorState,
    ranges: readonly { from: number; to: number }[],
    verdict: (word: string) => boolean | undefined,
    typingAt: number | null,
): SpellingScan {
    const misspelt: WordRange[] = []
    const unknown = new Set<string>()
    for (const range of wholeLines(state, ranges)) {
        for (const word of spellingCandidates(state, range.from, range.to)) {
            if (typingAt !== null && word.from <= typingAt && typingAt <= word.to) continue
            const correct = verdict(word.word)
            if (correct === undefined) unknown.add(word.word)
            else if (!correct) misspelt.push(word)
        }
    }
    return { misspelt, unknown: [...unknown] }
}

/** What one editor update says about typing, as {@link nextTypingAt} reads it. */
export interface TypingUpdate {
    docChanged: boolean
    /** A transaction the user typed or deleted with (`input.type`, `delete`). */
    typed: boolean
    /** A transaction with any user event: the user did something. */
    userEdit: boolean
    /** A remount carried the user's typing into this editor ({@link carryUserEdited}). */
    carriedTyping: boolean
    /** The selection was set without an edit (an arrow key, a click, the outliner's Home). */
    selectionSet: boolean
    /** The editor lost focus. */
    focusLost: boolean
    caret: { empty: boolean; head: number }
    /** Map a position through the update's changes. */
    mapPos: (pos: number) => number
}

/**
 * Where the caret is typing after an update, or null when no word is being typed: what keeps a
 * half-typed word from being underlined (ADR 0095).
 *
 * The user typing or deleting starts it at the caret. Anything else the user does ends it, so the
 * word is judged then: Enter, a paste, a caret move by any means, leaving the editor. A change that
 * came from elsewhere (a collaborator, an external write: no user event) neither starts nor ends
 * it; the position moves with the text, so the word under the caret stays unjudged. An editor that
 * took over from one the user was typing in starts at the caret: a Draft's first keystroke
 * promotes it and rebuilds the editor, and the word being typed carries on in the new one.
 */
export function nextTypingAt(previous: number | null, update: TypingUpdate): number | null {
    if (update.focusLost) return null
    if (update.carriedTyping) return update.caret.empty ? update.caret.head : null
    if (update.docChanged) {
        if (update.typed) return update.caret.empty ? update.caret.head : null
        if (update.userEdit || previous === null) return null
        // No user event: a collaborator's change or an external write carries the caret along with
        // the text, so typing goes on. An editor command that dispatches without one (the outliner's
        // Enter) puts the caret somewhere else, and the word it left is done.
        const moved = update.mapPos(previous)
        return update.caret.empty && update.caret.head === moved ? moved : null
    }
    if (previous === null || !update.selectionSet) return previous
    // However it was dispatched (the outliner handles Home with no `select` event), a caret that
    // moved has left the word; one set back where it was has not.
    return update.caret.empty && update.caret.head === previous ? previous : null
}
