/**
 * Putting a rendered [[Template]] into the editor (ADR 0144, Editor Content Rules → Inserting a
 * Template).
 *
 * A Template lands as a paste of its text does: the paste rules (ADR 0089, `paste-clamp.ts`) place
 * it, so a Template and a pasted outline can never land differently. The text is prepared the way a
 * [[Rich Paste]] prepares its outline (`rich-paste.ts`): onto an empty bullet as it is, so its first
 * block takes the bullet, and after a line break onto a block or a line that already has text, so an
 * outline nests under that block or starts a line of its own.
 *
 * `{{cursor}}` travels through the paste rules as one private-use character the Template does not
 * already hold. The rules move whole lines and their indentation and never the text inside a line,
 * so the character comes out where the author put it, and it is taken out of the same change: the
 * editor never holds it, and the Template is one undo step. A character on a fence's delimiter line
 * would stop the line reading as a fence, so a cursor there is dropped and the caret ends after the
 * Template, as it does when there is none.
 */

import { isolateHistory } from '@codemirror/commands'
import { EditorState, type Transaction } from '@codemirror/state'

import { type FencedBlockRange, fencedBlocks } from '../fenced-code'
import { contentStart, isBulletLine } from '../outliner'
import type { RenderedTemplate } from '../templates/template-variables'
import { editorHistory } from './editor-history'
import { blockPasteTarget, pasteClamp, TEMPLATE_PASTE_USER_EVENT } from './paste-clamp'

/**
 * The user event a Template's insert carries: the person's own input (`isOwnEditing`), so it writes
 * a [[Draft]] and every guard judges it, but no paste, since the paste rules have placed it already.
 */
export const TEMPLATE_USER_EVENT = 'input.template'

/** A line that opens or closes a fenced block, once its indentation and marker are set aside. */
const FENCE_DELIMITER = /^(`{3,}|~{3,})/

/** The editor a Template goes into: a live view, or a headless editor in tests. */
export interface TemplateTarget {
    readonly state: EditorState
    dispatch(tr: Transaction): void
}

/** Insert `rendered` over the selection, as one transaction and one undo step of its own. */
export function insertTemplate(target: TemplateTarget, rendered: RenderedTemplate): void {
    const state = target.state
    // Where the text lands is the paste rules' answer for the Template with no cursor, so a cursor
    // never changes what lands. The change then goes into the editor as the person's own input with
    // the caret already placed, and every other rule judges it there: tidy on leave trims what the
    // caret left, and only that, and the fence guards check it.
    const plain = pasteRulesFor(state, rendered.text)
    const changes: { from: number; to: number; insert: string }[] = []
    plain.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => void changes.push({ from: fromA, to: toA, insert: inserted.toString() }))
    target.dispatch(
        state.update({
            changes,
            selection: { anchor: caretFor(state, rendered, plain) },
            userEvent: TEMPLATE_USER_EVENT,
            // Typing straight after a Template is a step of its own, not part of the Template.
            annotations: isolateHistory.of('after'),
            scrollIntoView: true,
        }),
    )
    // The collaborative history groups by time rather than by the annotation, so it is told too.
    target.state.facet(editorHistory).closeStep?.()
}

/**
 * `text` as the paste rules place it over `state`'s selection (`paste-clamp.ts`), worked out in a
 * state of its own that holds only those rules: the answer is a change, judged by the editor's
 * other rules when it is dispatched.
 */
function pasteRulesFor(state: EditorState, text: string): Transaction {
    const { anchor, head } = state.selection.main
    const probe = EditorState.create({ doc: state.doc, selection: { anchor, head }, extensions: [pasteClamp()] })
    return probe.update(probe.replaceSelection(textToInsert(probe, text)), { userEvent: TEMPLATE_PASTE_USER_EVENT })
}

/**
 * Where the caret goes: the line and column the cursor mark reached when the same Template, with
 * the mark at `{{cursor}}`, went through the paste rules, read on the plain insert. When the two
 * came out with different lines, or there is no cursor, the caret ends after the insert, as after a
 * paste.
 */
function caretFor(state: EditorState, rendered: RenderedTemplate, plain: Transaction): number {
    const end = plain.newSelection.main.head
    const mark = cursorMarkFor(rendered.text)
    const { from, to } = state.selection.main
    const inOutline = blockPasteTarget(state, from, to, rendered.text.includes('\n')) !== null
    const body = withCursorMark(rendered.text, rendered.cursor, mark, inOutline)
    if (mark === '' || !body.includes(mark)) return end
    const marked = pasteRulesFor(state, body)
    // Looked for only in what was inserted: the document around it may hold the same character.
    let at = -1
    marked.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        const found = at < 0 ? marked.newDoc.sliceString(fromB, toB).indexOf(mark) : -1
        if (found >= 0) at = fromB + found
    })
    if (at < 0 || marked.newDoc.lines !== plain.newDoc.lines) return end
    const markedLine = marked.newDoc.lineAt(at)
    const line = plain.newDoc.line(markedLine.number)
    return line.from + Math.min(at - markedLine.from, line.length)
}

/**
 * The text a new, empty document holds once `rendered` is inserted into it, and where its caret
 * goes: the [[Journal Template]]'s starting text for a day's [[Draft]] (ADR 0145), placed by the same
 * rules as `/Template`, so indentation is on the grid and no bullet is left without a parent.
 */
export function templateAsNewText(rendered: RenderedTemplate): RenderedTemplate {
    let state = EditorState.create({ doc: '', extensions: [pasteClamp()] })
    const target: TemplateTarget = {
        get state() {
            return state
        },
        dispatch: (tr) => {
            state = tr.state
        },
    }
    insertTemplate(target, rendered)
    return { text: state.doc.toString(), cursor: rendered.cursor === null ? null : state.selection.main.head }
}

/**
 * The text to paste for `body` at the selection. An outline, or text of more than one line, starts
 * a block or a line of its own unless the caret's bullet or line is empty. One plain line is typed
 * in where the caret is, as a pasted line would be.
 */
function textToInsert(state: EditorState, body: string): string {
    const { from, to } = state.selection.main
    const blocks = body.includes('\n') || isBulletLine(body)
    const target = blockPasteTarget(state, from, to, body.includes('\n'))
    if (target) return target.emptyBullet || target.replacesMarker || !blocks ? body : `\n${body}`
    const line = state.doc.lineAt(from)
    const before = line.text.slice(0, from - line.from)
    return blocks && before.trim() !== '' ? `\n${body}` : body
}

/** A private-use character `text` does not hold, so the mark is never mistaken for the author's. */
function cursorMarkFor(text: string): string {
    for (let code = 0xe000; code <= 0xf8ff; code++) {
        const mark = String.fromCharCode(code)
        if (!text.includes(mark)) return mark
    }
    // 6,400 distinct private-use characters in one Template: the caret goes to the end instead.
    return ''
}

/**
 * `text` with the mark at `cursor`, or `text` alone when there is no cursor, no free mark, or the
 * cursor sits on a fence's delimiter line. The mark is only a probe for where the caret goes (the
 * text that lands is the Template's own), so it is placed where it keeps the lines reading as they
 * do without it:
 *
 * - in a line's indentation or marker it moves to where the line's text starts, since a mark there
 *   would turn `- Tasks` into a line that is no bullet;
 * - on a blank line of code it sits at the fence's column, since a character left of that column
 *   would end the block;
 * - landing in an outline, where the paste rules drop a blank line, a cursor alone on a line goes to
 *   the end of the line above, since a line holding only the mark would be prose, and the bullets
 *   after it would nest under it.
 */
function withCursorMark(text: string, cursor: number | null, mark: string, inOutline: boolean): string {
    if (cursor === null || mark === '') return text
    const code = codeBlockAround(text, cursor)
    if (inOutline && !code) cursor = outOfBlankLine(text, cursor)
    const lineStart = lineStartAt(text, cursor)
    const lineEnd = text.indexOf('\n', cursor)
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
    if (code && line.trim() === '') {
        const pad = ' '.repeat(Math.max(0, code.fenceColumn - line.length))
        return text.slice(0, lineStart) + line + pad + mark + text.slice(lineStart + line.length)
    }
    const start = lineStart + contentStart(line)
    if (FENCE_DELIMITER.test(text.slice(start))) return text
    const at = Math.max(cursor, start)
    return text.slice(0, at) + mark + text.slice(at)
}

/** The fenced block whose code holds the line `cursor` is on, or null. */
function codeBlockAround(text: string, cursor: number): FencedBlockRange | null {
    const index = text.slice(0, cursor).split('\n').length - 1
    return fencedBlocks(text.split('\n')).find((block) => index > block.start && index < block.end) ?? null
}

/** `cursor`, or the end of the nearest line above with text when the cursor's own line is blank. */
function outOfBlankLine(text: string, cursor: number): number {
    const lineStart = lineStartAt(text, cursor)
    const lineBreak = text.indexOf('\n', cursor)
    if (text.slice(lineStart, lineBreak < 0 ? text.length : lineBreak).trim() !== '') return cursor
    // The line break before a line is the end of the line above it; walk up until one has text.
    // `end` only ever falls, so the walk ends; at 0 the line above is empty and there is none higher.
    let end = lineStart - 1
    while (end > 0) {
        const start = lineStartAt(text, end)
        if (text.slice(start, end).trim() !== '') return end
        end = start - 1
    }
    // Nothing above holds text: the cursor stays where the author put it.
    return cursor
}

/**
 * Where the line holding `pos` starts. Not `lastIndexOf('\n', pos - 1) + 1` alone: at 0 that call
 * looks from 0 rather than from before the text, and finds a line break the first line ends with.
 */
function lineStartAt(text: string, pos: number): number {
    return pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
}
