/**
 * Augmentation: help while editing [[Frontmatter]] (ADR 0108) - the block tidied into the EtherPK
 * style when a person finishes editing it, and its problems marked where they are.
 *
 * **When.** Both happen when an editing episode in the block ends (the caret leaves it, the editor
 * loses focus, or the editor goes away; `frontmatter-episode.ts`), the same moment a Frontmatter
 * Proposal is made, and never per keystroke: a half-typed line is not a problem yet, and text must
 * not move under the caret. Once problems are showing they follow the typing, so a fix clears its
 * mark at once. A document that opens with a broken block shows its problems straight away, and
 * so does text the store writes into the editor (a file read, a write-back): nobody is typing it.
 *
 * **Tidy.** The restyle is an undo step of its own: Mod-z straight after it puts the block back
 * as it was typed, and the next Mod-z takes the typing. (It cannot join the typing's step: the
 * caret leaving the block is what ends the episode, and CodeMirror's history closes a step once
 * its selection has moved.) It never changes what the block says (`tidyFrontmatter`), and a block
 * that does not parse is left alone. It carries no user event: it is not the person's editing, so
 * it opens no episode of its own and asks the Frontmatter Proposal nothing.
 *
 * **Problems.** Each problem line gets a wavy underline, red for an error and amber for a warning,
 * and the opening line carries a note: the first problem in words, how many more, and a button
 * that puts the caret on its line. What counts as a problem is `frontmatter-problems.ts`, which
 * reads the publishing keys with the publisher's own code.
 */

import { isolateHistory } from '@codemirror/commands'
import { type EditorState, type Extension, type Range, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

import { type FrontmatterProblem, frontmatterProblems } from '$lib/document/frontmatter/frontmatter-problems'
import { tidyFrontmatter } from '$lib/document/frontmatter/frontmatter-yaml'

import { isJournalConcept } from '../../journal-concept'
import { analysisFor } from '../analysis/editor-analysis'
import { EXTERNAL } from '../cm-document'
import { frontmatterHead } from '../frontmatter-text'
import { editorHistory } from '../editor-history'
import { isOwnEditing } from '../own-editing'
import { FrontmatterEpisode } from './frontmatter-episode'

export interface FrontmatterAssistOptions {
    /** The name the document answers to: a journal entry's is its day. Null outside a graph. */
    documentName: () => string | null
}

/** The problems on show, and the kind of document they were judged for. */
export interface ShownProblems {
    kind: 'page' | 'journal'
    problems: FrontmatterProblem[]
}

/** Show these problems (an empty list hides them). */
export const showFrontmatterProblems = StateEffect.define<ShownProblems>()

/** The problems of the block in `state`, for a document of `kind`. */
export function problemsIn(state: EditorState, kind: 'page' | 'journal'): FrontmatterProblem[] {
    const head = frontmatterHead(state)
    return head === null ? [] : frontmatterProblems(head, kind)
}

/**
 * The problems on show. Set by {@link showFrontmatterProblems} when an episode ends; while any
 * are on show they are judged again on every change, so they follow the typing and go when fixed.
 */
export const frontmatterProblemsField = StateField.define<ShownProblems | null>({
    create: () => null,
    update(value, tr) {
        let next = value
        for (const effect of tr.effects) if (effect.is(showFrontmatterProblems)) next = effect.value.problems.length > 0 ? effect.value : null
        // Judged again only when a change reaches the block: typing in the body leaves it as it was.
        const end = analysisFor(tr.startState).frontmatterEnd
        if (next !== null && tr.docChanged && next === value && (end < 0 || tr.changes.touchesRange(0, end + 1))) {
            const problems = problemsIn(tr.state, next.kind)
            next = problems.length > 0 ? { kind: next.kind, problems } : null
        }
        return next
    },
    provide: (field) => EditorView.decorations.compute([field], (state) => problemDecorations(state, state.field(field))),
})

/**
 * The change that restyles the block in `state`, as the smallest replacement, or null when the
 * block is missing, broken or already tidy. A caret outside the replaced text keeps its place; one
 * inside it (the tidy after focus is lost with the caret in the block) moves to its edge.
 */
export function frontmatterTidyChange(state: EditorState): { from: number; to: number; insert: string } | null {
    const head = frontmatterHead(state)
    if (head === null) return null
    const tidied = tidyFrontmatter(head)
    if (tidied === head) return null
    let start = 0
    while (start < head.length && start < tidied.length && head[start] === tidied[start]) start++
    let end = 0
    while (end < head.length - start && end < tidied.length - start && head[head.length - 1 - end] === tidied[tidied.length - 1 - end]) end++
    return { from: start, to: head.length - end, insert: tidied.slice(start, tidied.length - end) }
}

/** The tidy as a transaction: an undo step of its own, on either history. */
export function tidyTransaction(state: EditorState): TransactionSpec | null {
    const change = frontmatterTidyChange(state)
    return change === null ? null : { changes: change, annotations: isolateHistory.of('full') }
}

/** A problem's message, its backtick spans as code. */
function appendMessage(into: HTMLElement, message: string): void {
    message.split('`').forEach((part, i) => {
        if (i % 2 === 1) {
            const code = document.createElement('code')
            code.textContent = part
            into.append(code)
        } else into.append(part)
    })
}

class ProblemNote extends WidgetType {
    constructor(private readonly problems: readonly FrontmatterProblem[]) {
        super()
    }

    eq(other: ProblemNote): boolean {
        return JSON.stringify(other.problems) === JSON.stringify(this.problems)
    }

    toDOM(view: EditorView): HTMLElement {
        const [first] = this.problems
        const note = document.createElement('span')
        note.className = `gk-frontmatter-note gk-frontmatter-note--${first.level}`
        note.setAttribute('data-testid', 'frontmatter-problems')
        note.setAttribute('data-level', first.level)
        note.contentEditable = 'false'
        const text = document.createElement('span')
        text.className = 'gk-frontmatter-note-text'
        text.append(`Line ${first.line + 1}: `)
        appendMessage(text, first.message)
        if (this.problems.length > 1) text.append(` (${this.problems.length - 1} more)`)
        // The whole explanation, for the width the note cannot show.
        note.title = this.problems.map((p) => `Line ${p.line + 1}: ${p.message.replaceAll('`', '')}`).join('\n')
        const go = document.createElement('button')
        go.type = 'button'
        go.className = 'gk-frontmatter-note-action'
        go.textContent = 'Go to line'
        go.setAttribute('data-testid', 'frontmatter-problems-go')
        go.addEventListener('mousedown', (event) => event.preventDefault())
        go.addEventListener('click', (event) => {
            event.preventDefault()
            const line = view.state.doc.line(Math.min(view.state.doc.lines, first.line + 1))
            view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true, userEvent: 'select' })
            view.focus()
        })
        note.append(text, go)
        return note
    }

    /** Real interactive DOM: CodeMirror must not swallow its events. */
    ignoreEvent(): boolean {
        return false
    }
}

function problemDecorations(state: EditorState, shown: ShownProblems | null): DecorationSet {
    if (shown === null) return Decoration.none
    const decos: Range<Decoration>[] = []
    for (const problem of shown.problems) {
        if (problem.line + 1 > state.doc.lines) continue
        decos.push(Decoration.line({ class: `gk-frontmatter-problem gk-frontmatter-problem--${problem.level}` }).range(state.doc.line(problem.line + 1).from))
    }
    decos.push(Decoration.widget({ widget: new ProblemNote(shown.problems), side: 2 }).range(state.doc.line(1).to))
    return Decoration.set(decos, true)
}

/** Feeds the episode tracker and, when an episode ends, tidies the block and shows its problems. */
function assistPlugin(options: FrontmatterAssistOptions): Extension {
    return ViewPlugin.fromClass(
        class {
            private readonly episode = new FrontmatterEpisode()
            private destroyed = false

            constructor(view: EditorView) {
                // A block that is already broken when the document opens is shown at once.
                queueMicrotask(() => this.show(view))
            }

            update(update: ViewUpdate): void {
                const changes: { from: number; to: number }[] = []
                // Text the store wrote (a file read landing after mount, a write-back) is shown at once
                // unless the person is mid-edit in the block.
                const stored = update.transactions.some((tr) => tr.docChanged && tr.annotation(EXTERNAL) === true)
                for (const tr of update.transactions) {
                    // Undo and redo open no episode here: undoing a tidy must not be tidied straight
                    // back, or Mod-z could never reach the typing before it.
                    if (!tr.docChanged || tr.annotation(EXTERNAL) || !isOwnEditing(tr) || tr.isUserEvent('undo') || tr.isUserEvent('redo')) continue
                    tr.changes.iterChangedRanges((fromA, toA) => changes.push({ from: fromA, to: toA }))
                }
                const ended = this.episode.update({
                    blockEndBefore: analysisFor(update.startState).frontmatterEnd,
                    blockEndAfter: analysisFor(update.state).frontmatterEnd,
                    changes,
                    caret: update.state.selection.main.head,
                    focused: update.view.hasFocus,
                })
                // Dispatched after the update cycle: a view cannot be updated from inside one.
                if (ended) queueMicrotask(() => this.finish(update.view))
                else if (stored && !this.episode.open) queueMicrotask(() => this.show(update.view))
            }

            private kind(): 'page' | 'journal' {
                const name = options.documentName()
                return name !== null && isJournalConcept(name) ? 'journal' : 'page'
            }

            private finish(view: EditorView): void {
                if (this.destroyed || !view.state.facet(EditorView.editable) || view.state.readOnly) return
                const tidy = tidyTransaction(view.state)
                if (tidy) {
                    // A step of its own on the collaborative history too, which would otherwise fold
                    // it into the typing by time: undo behaves the same on every graph.
                    const history = view.state.facet(editorHistory)
                    history.closeStep?.()
                    view.dispatch(tidy)
                    history.closeStep?.()
                }
                this.show(view)
            }

            private show(view: EditorView): void {
                if (this.destroyed) return
                const kind = this.kind()
                const problems = problemsIn(view.state, kind)
                if (problems.length === 0 && view.state.field(frontmatterProblemsField, false) == null) return
                view.dispatch({ effects: showFrontmatterProblems.of({ kind, problems }) })
            }

            destroy(): void {
                this.destroyed = true
            }
        },
    )
}

const theme = EditorView.baseTheme({
    // The mark sits under the text of the line, never on the panel around it.
    '.cm-line.gk-frontmatter-problem': { textDecorationLine: 'underline', textDecorationStyle: 'wavy', textDecorationThickness: '1px', textUnderlineOffset: '3px' },
    '.cm-line.gk-frontmatter-problem--error': { textDecorationColor: 'var(--gk-text-danger, #b91c1c)' },
    '.cm-line.gk-frontmatter-problem--warning': { textDecorationColor: 'var(--gk-text-warning, #92400e)' },
    // The note sits on the opening line after the dimmed `---`, in the prose font, the way the
    // title-mismatch note does, and never changes the row's height or wraps onto a second row.
    '.gk-frontmatter-note': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5em',
        // The rest of the row, as the title-mismatch note takes: the size containment keeps the
        // note's unwrapped text out of the line's width, so it needs a width of its own.
        width: 'calc(100% - 4em)',
        contain: 'inline-size',
        marginLeft: '1em',
        verticalAlign: 'middle',
        fontFamily: 'var(--gk-sans, "Inter", system-ui, sans-serif)',
        // Follows the editor zoom, never below the app's 14px floor for text.
        fontSize: 'max(0.875rem, 0.8em)',
        lineHeight: '1',
        whiteSpace: 'nowrap',
        userSelect: 'none',
    },
    '.gk-frontmatter-note--error': { color: 'var(--gk-text-danger, #b91c1c)' },
    '.gk-frontmatter-note--warning': { color: 'var(--gk-text-warning, #92400e)' },
    '.gk-frontmatter-note-text': { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' },
    '.gk-frontmatter-note-action': {
        flexShrink: '0',
        padding: '0.05em 0.5em',
        borderRadius: '4px',
        border: '1px solid var(--gk-border-soft, rgba(127,127,127,0.45))',
        background: 'transparent',
        color: 'var(--gk-text-default, inherit)',
        cursor: 'pointer',
        font: 'inherit',
    },
})

export function frontmatterAssist(options: FrontmatterAssistOptions): Extension {
    return [frontmatterProblemsField, assistPlugin(options), theme]
}
