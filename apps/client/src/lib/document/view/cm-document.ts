/**
 * Framework-free CodeMirror 6 wiring for a single document.
 *
 * The contract enforces ADR 0010's rule — CodeMirror is not the source of truth:
 * - local edits are pushed out via `onChange` (the caller forwards them to the
 *   backend's EditorDocument.applyChange);
 * - external edits are pushed in via the returned `setExternalText`, which
 *   replaces the doc WITHOUT re-firing `onChange` (no echo loop), using an
 *   annotation to mark the transaction as remote.
 *
 * The Server engine will later replace this body with a Yjs binding
 * (`y-codemirror.next`) behind the same `createDocumentEditor` signature.
 */

import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, type Extension, Facet, Prec, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, drawSelection, dropCursor, keymap } from '@codemirror/view'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

import { getEditorFontSize, onEditorFontSizeChange } from '../editor-font'
import type { TextChange } from '../types'
import { codeHighlighting, markdownWithCodeHighlight } from './augmentations/code-highlight'
import { deleteHeal } from './delete-heal'
import { leaveTidy } from './leave-tidy'
import { collabEditorHistory, editorHistory, joinableUndoStepField, localHistoryExtension } from './editor-history'
import { fenceGuard } from './fence-guard'
import { pasteClamp } from './paste-clamp'
import { outlinerKeymap } from './outliner-keymap'
import { NEW_GROUP_DELAY, undoGrouping } from './undo-grouping'
import { editorAnalysis } from './analysis/editor-analysis'
import { minimalReplacement } from './minimal-replacement'
import { sequentialTextChanges } from './sequential-text-changes'

/** Marks a transaction as externally-originated so it is not echoed back out. */
export const EXTERNAL = Annotation.define<boolean>()

/**
 * Whether this editor is bound to a shared Y.Text. A transaction filter reads it to leave
 * Y-originated transactions alone: y-codemirror dispatches a remote member's change, and the
 * shared undo manager's undo, as ordinary transactions with no user event and no exported
 * annotation to test for (v0.3.5), so "collaborative, and not this user's own editing" is the
 * only way to recognise one.
 */
export const collaborative = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/**
 * Horizontal padding (px) a block selection's rectangles extend beyond the text they cover
 * (selection-layer.ts). A character selection has none, so its ends sit where the caret would.
 * Vertically a rectangle spans the whole line box, whose leading is the padding.
 */
export const SELECTION_PAD = 6

/** The editor content's horizontal padding. */
const CONTENT_PAD_X = '1.25rem'

/**
 * The editor's font size, as a theme of its own that a zoom swaps. The size also lives on the
 * document root as `--editor-font-size` (editor-font.ts), for everything else sized off it, but
 * CodeMirror does not see a change there: it re-measures when its scroller resizes, which a zoom
 * never does. Asking it to measure is not enough either: in a document shorter than the pane the
 * content box keeps its `min-height: 100%`, so CodeMirror finds its height unchanged and skips the
 * lines. Unmeasured, the height map keeps the old line heights, and nothing measured off the text
 * (the clamp's prose metrics, the guide threads) follows the zoom until the next edit. A changed
 * theme is what makes CodeMirror re-measure every line and report a geometry change.
 *
 * One theme per size, kept, so zooming back and forth mounts no new styles.
 */
const fontSizeTheme = new Compartment()
const fontSizeThemes = new Map<number, Extension>()

function themeForFontSize(px: number): Extension {
    let theme = fontSizeThemes.get(px)
    if (!theme) fontSizeThemes.set(px, (theme = EditorView.theme({ '&': { fontSize: `${px}px` } })))
    return theme
}

const followFontSize = ViewPlugin.define((view) => ({
    destroy: onEditorFontSizeChange(() => {
        const theme = themeForFontSize(getEditorFontSize())
        if (fontSizeTheme.get(view.state) !== theme) view.dispatch({ effects: fontSizeTheme.reconfigure(theme) })
    }),
}))

export interface DocumentEditorOptions {
    parent: HTMLElement
    doc: string
    /** Fired for every editor-originated change. */
    onChange: (change: TextChange) => void
    /** Extra extensions (e.g. augmentation decorations). */
    extensions?: Extension[]
    /**
     * Collaborative buffer (Server engine / ADR 0010 gate): the Y.Text becomes the
     * source of truth via y-codemirror.next. CM history is replaced by Y.UndoManager
     * (local-only undo), and `doc` is ignored in favour of the Y.Text's content.
     * When `awareness` is provided, y-codemirror renders remote cursors/selections.
     */
    collab?: { ytext: Y.Text; awareness?: Awareness }
}

export interface DocumentEditor {
    readonly view: EditorView
    /** Reflect an external change (git reload / remote update) without firing onChange. */
    setExternalText(text: string): void
    /**
     * Forget every undo step. For a lock transition on a [[Protected Document]]: the swap between
     * plaintext and fence is not undoable (see `setExternalText`), but the edits made while
     * unlocked are, and their inverses hold plaintext that must not outlive the key. Undo is
     * dispatched past every transaction filter, so the history itself has to go. A no-op in
     * collab mode, whose undo manager never sees a protected document.
     */
    clearHistory(): void
    destroy(): void
}

/**
 * The collaborative editor's undo: a Y.UndoManager over the buffer, held to CodeMirror history's
 * grouping rule so that only adjacent typing joins one undo step. The manager's own rule is time
 * alone (`captureTimeout`), which merged a burst of edits in different places into one Mod-z.
 */
function collabHistory(collab: NonNullable<DocumentEditorOptions['collab']>): Extension {
    // One group delay for both: the manager's own capture window and the grouping rule's.
    const undoManager = new Y.UndoManager(collab.ytext, { captureTimeout: NEW_GROUP_DELAY })
    return [
        undoGrouping(undoManager),
        yCollab(collab.ytext, collab.awareness ?? null, { undoManager }),
        // So a surface holding only a view (the Command Bar's undo / redo buttons) runs this
        // manager's undo, not CodeMirror history's (editor-history.ts).
        editorHistory.of(collabEditorHistory(undoManager)),
        // The same "is the last step still the paste's" rule as the local history (ADR 0090).
        joinableUndoStepField,
    ]
}

export function createDocumentEditor(options: DocumentEditorOptions): DocumentEditor {
    const { parent, doc, onChange, extensions = [], collab } = options
    const historyCompartment = new Compartment()

    // Collab mode: suppresses the onChange echo while setExternalText routes a replace
    // through the Y.Text. y-codemirror.next does NOT export its ySyncAnnotation (v0.3.5),
    // but its Y-observer → view.dispatch is synchronous (dist y-sync, `_observer`), so a
    // re-entrancy flag covers Phase 1's only remote source. Real network updates (Phase 3)
    // flow through the same sync-engine call sites, which hold the same flag.
    let applyingExternal = false

    const updateListener = EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        if (applyingExternal) return // Y-originated remote change, don't echo
        if (update.transactions.some((t) => t.annotation(EXTERNAL))) return // external, don't echo
        // A single transaction can carry several changes (a wrap key, a format toggle, a
        // multi-caret edit). `applyChange` takes one at a time and every store splices as it goes, so
        // each change is expressed against the text the ones before it leave (sequential-text-changes.ts).
        for (const change of sequentialTextChanges(update.changes)) onChange(change)
    })

    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: collab ? collab.ytext.toString() : doc,
            extensions: [
                // Collab mode: the Y.Text is the buffer; Y.UndoManager scopes undo to local
                // edits (a co-editor's keystrokes are never undone by your Mod-z). The grouping
                // plugin goes FIRST: it must see each edit before yCollab's sync plugin pushes it
                // into the Y.Text, so an edit that should open a new undo step does (undo-grouping.ts).
                collab ? collabHistory(collab) : historyCompartment.of(localHistoryExtension()),
                collaborative.of(Boolean(collab)),
                // A visible caret and selection. Without drawSelection() a custom
                // CM6 setup shows no cursor; this renders `.cm-cursor`, themed below.
                drawSelection(),
                dropCursor(),
                // Outliner block-ops (Tab/Enter/move/fold/…) intercept before the
                // defaults — Dual Mode Editor.md → Keyboard scheme.
                Prec.high(outlinerKeymap()),
                keymap.of([...defaultKeymap, ...(collab ? yUndoManagerKeymap : historyKeymap)]),
                markdownWithCodeHighlight(),
                codeHighlighting(),
                // Transaction filters run LAST-registered first, so the paste clamp sits after the fence
                // guard: a paste is clamped before the guard sees it, and the guard then only re-pads what
                // is left. The other way round the guard's corrections make the paste a multi-change
                // transaction the clamp leaves alone (paste-clamp.test.ts pins this).
                // The tidy on leave is registered first of all, so it judges the transaction after every
                // other filter has clamped, healed and guarded it (leave-tidy.ts).
                leaveTidy(),
                fenceGuard(),
                pasteClamp(),
                // A cut, or a within-line delete that takes a bullet's marker, heals the survivors. The
                // caret clamp (in `extensions`, registered later) runs BEFORE it, so the heal places
                // its own caret when its change would swallow it (delete-heal.ts).
                deleteHeal(),
                editorAnalysis(),
                EditorView.lineWrapping,
                fontSizeTheme.of(themeForFontSize(getEditorFontSize())),
                followFontSize,
                EditorView.theme({
                    // The font size is `fontSizeTheme`, above: the persisted editor-font preference
                    // (editor-font.ts), swapped on every zoom so every open editor follows it live.
                    '&': { height: '100%' },
                    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--gk-text-default, #111)' },
                    // The selection highlight is drawn by selection-layer.ts (one padded, full-height
                    // rectangle per selected line); drawSelection keeps only the caret.
                    // Prose uses the site's sans font (CodeMirror's base theme forces monospace
                    // otherwise); code lines opt back into the mono token via their own classes.
                    // Padding gives the whole pane breathing room so text isn't flush to the edges.
                    '.cm-content': {
                        caretColor: 'var(--gk-text-default, #111)',
                        fontFamily: 'var(--gk-sans, "Inter", system-ui, sans-serif)',
                        // Airier rows (Logseq-like) — more vertical breathing room for outliner text.
                        lineHeight: '1.7',
                        // The row pitch as a length, for anything that must be exactly one row tall
                        // without relying on in-flow text (the clamp's lifted-prefix strut).
                        '--gk-line-pitch': 'calc(var(--editor-font-size, 1rem) * 1.7)',
                        padding: `0.75rem ${CONTENT_PAD_X}`,
                    },
                    // The remote-caret name tag (y-codemirror.next). Its base theme sets `serif`, so
                    // without the font it is the one serif element in the app; and it inherits the
                    // outliner's hang-indent `text-indent` from the .cm-line (content-clamp.ts), which
                    // slid the name left of its own background — reset, as fence-render does.
                    '.cm-ySelectionInfo': {
                        fontFamily: 'var(--gk-sans, "Inter", system-ui, sans-serif)',
                        textIndent: '0',
                        // Dark on the pastel presence palette (presence-identity.ts) in both themes;
                        // the base theme's white assumed a saturated background.
                        color: '#1e293b',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        // Lifted to clear the added padding (the base theme's -1.05em assumes none).
                        top: '-1.35em',
                    },
                    // The middle lines of a remote multi-line selection carry y-codemirror's line
                    // decoration, whose base theme gives the line a 4px left margin: those lines, dots
                    // and all, sat 4px right of the lines above and below the remote selection, and
                    // the first line of the tree looked misaligned. Only the margin is reset: this
                    // rule outranks the base themes, so a padding reset here would also flatten the
                    // block-quote panel's top and bottom padding on a quoted line inside the selection
                    // (markdown-format.ts). The base theme's own `padding: 0` loses to the quote and
                    // `.cm-line` rules on specificity and order, so the line keeps the geometry the
                    // clamp and the quote gave it; the tint alone marks the selection.
                    '.cm-line.cm-yLineSelection': { margin: '0' },
                    // Snap the line pitch to whole pixels. 1.7 × 16px is 27.2px, so consecutive lines start
                    // at different sub-pixel offsets (.2, .4, .6, .8, 0) and anything small drawn on them,
                    // the bullet dots above all, rasterises differently line by line: rounder here, flatter
                    // and lighter there, which reads as dots of different sizes. round() keeps the ratio and
                    // lands every line on the pixel grid; browsers without it keep the unrounded value above.
                    '@supports (line-height: round(1px, 1px))': {
                        '.cm-content': {
                            lineHeight: 'round(calc(var(--editor-font-size, 1rem) * 1.7), 1px)',
                            '--gk-line-pitch': 'round(calc(var(--editor-font-size, 1rem) * 1.7), 1px)',
                        },
                    },
                    // Drop CodeMirror's default 6px `.cm-line` left padding so plain prose and headings
                    // start at the content edge — the same x as a top-level bullet's marker/dot. Bullet,
                    // continuation, and code lines all carry their own inline padding and are unaffected.
                    '.cm-line': { padding: '0 2px 0 0' },
                }),
                updateListener,
                ...extensions,
            ],
        }),
    })

    return {
        view,
        setExternalText(text) {
            // The change and nothing more (ADR 0066): a whole-document replace threw the caret
            // to the end for a rewrite that touched one link, and on a synced graph it did not
            // cover anything typed concurrently, which then survived at the wrong place.
            const change = minimalReplacement(view.state.doc.toString(), text)
            if (!change) return
            if (collab) {
                // Through the Y.Text; the binding delivers it to CM synchronously, inside the
                // flag window, so onChange stays silent. Origin EXTERNAL keeps it OUT of
                // Y.UndoManager (default trackedOrigins is {null}): external content must not
                // be locally undoable — without this, captureTimeout merges the replace with
                // subsequent typing and one Ctrl+Z rewinds through it.
                const ytext = collab.ytext
                applyingExternal = true
                try {
                    ytext.doc!.transact(() => {
                        ytext.delete(change.from, change.to - change.from)
                        ytext.insert(change.from, change.insert)
                    }, EXTERNAL)
                } finally {
                    applyingExternal = false
                }
                return
            }
            // Out of the undo history, as the collab branch keeps its swap out of the undo
            // manager: external content must not be locally undoable. For a Protected Document
            // the swap is the fence replacing the plaintext on lock, and its inverse would hand
            // the plaintext back to anyone pressing Mod-z at the locked document - and on past
            // every transaction filter, which undo skips.
            view.dispatch({
                changes: change,
                annotations: [EXTERNAL.of(true), Transaction.addToHistory.of(false)],
            })
        },
        clearHistory() {
            if (collab) return
            // Dropping the extension discards its state field; putting it back creates a fresh one.
            view.dispatch({ effects: historyCompartment.reconfigure([]) })
            view.dispatch({ effects: historyCompartment.reconfigure(localHistoryExtension()) })
        },
        destroy() {
            view.destroy()
        },
    }
}
