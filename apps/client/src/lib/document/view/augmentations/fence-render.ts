/**
 * Augmentation host: **rendered fences** (ADR 0022). A complete [[Fenced Code Block]] whose
 * info-string resolves to a registered Augmentation renderer (`mermaid`, `math`, …) collapses
 * to its rendered output while the caret is outside; revealing (any selection touching the
 * block, a click on the widget, or ArrowDown/Up from the adjacent line) shows the ordinary
 * fenced-code editing surface — all clamps, the guard, and the panel apply unchanged. For a
 * `'preview'` renderer (mermaid) the revealed block also carries a live preview panel below
 * the closing fence, re-rendered debounced as the source changes; a `'flip'` renderer (math)
 * just flips. All outliner behaviour lives HERE and in the existing fence machinery — a
 * renderer only ever turns source into DOM (the contract must stay dumb, ADR 0022).
 *
 * Architecture: rendering is ASYNC but widgets are SYNCHRONOUS. A coordinator ViewPlugin
 * schedules `renderer.render()` per fence (debounced while revealed), stores the outcome in
 * {@link fenceRenderResults}, and dispatches {@link renderCompleted}; the decoration field
 * rebuilds and the widgets — whose `eq` carries the result version — are redrawn with the
 * result already in hand. This is load-bearing, not style: CodeMirror ignores DOM mutations
 * inside widget subtrees, so an in-place async swap changes a block widget's height behind
 * the height map's back, and every click below it then lands on the wrong block (the same
 * drift class image-embed.ts fights). A height change that rides a decoration redraw is
 * always measured.
 *
 * Results are owned per editor: each `fenceRenderAugmentation()` call mints a {@link renderOwner}
 * and its coordinator reconciles, sweeps and destroys only entries under that owner, so two
 * panes showing different documents with the same fence on the same line never disturb each
 * other. A widget appends a CLONE of the stored node rather than the node itself - both
 * renderers' output is inert (mermaid under `securityLevel: 'strict'`, KaTeX static markup),
 * so cloning is safe, and it means a redraw in one place can never pull the DOM out of another.
 *
 * Form handling (the five invariants, ADR 0022):
 * - **Form-1** (`- ```info`): an INLINE replace from just after the `- ` marker to the end of
 *   the closing fence — the marker stays real text, so the dot, guide thread and block
 *   identity render exactly as a bullet image's do (image-embed.ts).
 * - **Form-2 / prose**: a BLOCK replace over the fence's full lines; the widget pads itself
 *   to the content column (`hangWidthForPos`).
 * - An unterminated fence never gets here (renderableFences is built on the complete-block
 *   pairing) — a half-typed fence stays plain text.
 * - A `flip` renderer's hard failure falls back to raw source (never a silent empty widget);
 *   a `preview` renderer's failure is a compact clickable error card when collapsed and the
 *   parse error in the preview while editing — never a stale diagram beside edited source.
 */

import { type EditorState, type Extension, Prec, type Range, StateField, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

import { BLOCK_WIDGET_SPACING,hangWidthForPos } from './content-clamp'
import {
    type DispatchedFence,
    type FenceRenderResult,
    fenceRenderResults,
    fenceResultKey,
    isDark,
    renderCompleted,
    renderedSizes,
    renderedThemePlugin,
    renderKey,
    renderOwner,
    rendererCollapsedFences,
    rendererDispatchedFences,
    themeTick,
    trackRenderCoordinator,
} from './rendered-common'

/** Matches the bullet image's drop (image-embed.ts BULLET_IMAGE_DROP) so a form-1 widget sits
 *  just below the row top and the dot reads as the block's top-left corner. */
const BULLET_DROP = '0.35em'

/** Debounce for the live preview re-render while the source is edited. */
const PREVIEW_DEBOUNCE_MS = 200

/** Mints the per-editor {@link renderOwner}; 0 is reserved for "no owner". */
let ownerSeq = 0

function errorCard(info: string, message: string): HTMLElement {
    const card = document.createElement('div')
    card.className = 'gk-rendered-error'
    card.textContent = `⚠ ${info} won't render`
    if (message) card.title = message.split('\n', 1)[0]
    return card
}

/** The collapsed rendered widget. Synchronous: displays the coordinator's stored result. */
class RenderedWidget extends WidgetType {
    constructor(
        readonly fence: DispatchedFence,
        /** The editor whose stored result this widget shows ({@link renderOwner}). */
        readonly owner: number,
        /** Result version at build time — a completed render changes it, forcing a redraw. */
        readonly version: number,
        readonly dark: boolean,
        /** Content-column pad (ch) for the block form; 0 for the inline (form-1) variant. */
        readonly hangWidth: number,
    ) {
        super()
    }

    eq(other: RenderedWidget): boolean {
        return (
            this.owner === other.owner &&
            this.fence.info === other.fence.info &&
            this.fence.source === other.fence.source &&
            this.version === other.version &&
            this.dark === other.dark &&
            this.hangWidth === other.hangWidth &&
            this.fence.bulletOpener === other.fence.bulletOpener
        )
    }

    get estimatedHeight(): number {
        return renderedSizes.get(renderKey(this.fence.info, this.fence.source, this.dark)) ?? -1
    }

    toDOM(): HTMLElement {
        const f = this.fence
        const wrap = document.createElement(f.bulletOpener ? 'span' : 'div')
        wrap.className = f.bulletOpener ? 'gk-rendered gk-rendered--inline' : 'gk-rendered gk-rendered--block'
        wrap.setAttribute('data-augmentation', 'rendered')
        wrap.setAttribute('data-render-info', f.info)
        if (!f.bulletOpener && this.hangWidth > 0) wrap.style.paddingLeft = `${this.hangWidth}ch`
        const entry = fenceRenderResults.get(fenceResultKey(this.owner, f.info, f.start))
        const key = renderKey(f.info, f.source, this.dark)
        if (entry && entry.source === f.source && entry.node) {
            // A clone, never the stored node: appending the node itself would pull it out of
            // wherever it was last drawn (the preview panel, or a widget CodeMirror still holds).
            wrap.appendChild(entry.node.cloneNode(true))
            // Record the real footprint once laid out, so the next re-create reserves it.
            requestAnimationFrame(() => {
                if (!wrap.isConnected) return
                const height = Math.round(wrap.getBoundingClientRect().height)
                if (height > 0) renderedSizes.set(key, height)
            })
        } else if (entry && entry.source === f.source && entry.error !== null) {
            // Only 'preview' renderers reach here collapsed-with-error (a failed 'flip' fence
            // is excluded from collapsing entirely — raw source is its fallback).
            wrap.appendChild(errorCard(f.info, entry.error))
        } else {
            // Still rendering: reserve the last known footprint so the page doesn't jump.
            const known = renderedSizes.get(key)
            if (known) wrap.style.minHeight = `${known}px`
        }
        return wrap
    }

    ignoreEvent(): boolean {
        return false // let mousedown reach the editor handler (click reveals)
    }
}

/** The live preview panel under a revealed 'preview' fence. Synchronous, like RenderedWidget. */
class PreviewWidget extends WidgetType {
    constructor(
        readonly fence: DispatchedFence,
        readonly owner: number,
        readonly version: number,
        readonly dark: boolean,
    ) {
        super()
    }

    eq(other: PreviewWidget): boolean {
        return (
            this.owner === other.owner &&
            this.fence.info === other.fence.info &&
            this.fence.start === other.fence.start &&
            this.version === other.version &&
            this.dark === other.dark &&
            this.fence.fenceColumn === other.fence.fenceColumn
        )
    }

    toDOM(): HTMLElement {
        const f = this.fence
        // Outer = padded spacer (all vertical footprint inside the measured rect — see the
        // height-integrity rule on the theme); inner = the visible panel.
        const wrap = document.createElement('div')
        wrap.className = 'gk-rendered-preview'
        if (f.fenceColumn > 0) wrap.style.paddingLeft = `${f.fenceColumn}ch`
        const panel = wrap.appendChild(document.createElement('div'))
        panel.className = 'gk-rendered-preview-panel'
        const entry = fenceRenderResults.get(fenceResultKey(this.owner, f.info, f.start))
        if (entry?.error !== null && entry?.error !== undefined) {
            // Never a stale diagram beside edited source: the error replaces the render.
            const message = document.createElement('div')
            message.className = 'gk-rendered-preview-error'
            message.textContent = entry.error
            panel.appendChild(message)
        } else if (entry?.node) {
            // The previous node stays visible during the debounce (deliberately no source check
            // here, or live preview would flash) - as a clone, so the collapsed widget that may
            // still hold this result elsewhere keeps its own copy.
            panel.appendChild(entry.node.cloneNode(true))
        }
        return wrap
    }

    ignoreEvent(): boolean {
        return true // the preview is inert output; clicks in it shouldn't move the caret
    }
}

function buildDecorations(state: EditorState): DecorationSet {
    const dark = isDark()
    const owner = state.facet(renderOwner)
    const collapsedStarts = new Set(rendererCollapsedFences(state).map((f) => f.start))
    const decos: Range<Decoration>[] = []
    for (const f of rendererDispatchedFences(state)) {
        const openerLine = state.doc.line(f.start + 1)
        const entry = fenceRenderResults.get(fenceResultKey(owner, f.info, f.start))
        const version = entry && entry.source === f.source ? entry.version : -1
        if (collapsedStarts.has(f.start)) {
            if (f.bulletOpener) {
                // Inline collapse: the `[indent]- ` marker stays real text (dot + thread render as usual).
                const widget = new RenderedWidget(f, owner, version, dark, 0)
                decos.push(Decoration.replace({ widget }).range(openerLine.from + f.fenceColumn, f.blockTo))
            } else {
                const widget = new RenderedWidget(f, owner, version, dark, hangWidthForPos(state, openerLine.from))
                decos.push(Decoration.replace({ widget, block: true }).range(f.blockFrom, f.blockTo))
            }
        } else if (f.revealed && f.renderer.editing === 'preview') {
            // Revealed 'preview' block: the source is the editing surface; the render rides below it.
            const widget = new PreviewWidget(f, owner, entry?.version ?? -1, dark)
            decos.push(Decoration.widget({ widget, block: true, side: 1 }).range(f.blockTo))
        }
    }
    return Decoration.set(decos, true)
}

/**
 * What the coordinator needs of its editor: the current state and a way to dispatch the
 * {@link renderCompleted} effect. An `EditorView` satisfies it; the Node tier drives one over a
 * headless state instead (fence-render.test.ts), which is why the coordinator is a plain class
 * and the ViewPlugin below is only its mount.
 */
export interface RenderCoordinatorHost {
    readonly state: EditorState
    dispatch(spec: TransactionSpec): void
}

/** The parts of a `ViewUpdate` the coordinator reads. */
export type RenderCoordinatorUpdate = Pick<ViewUpdate, 'docChanged' | 'selectionSet' | 'transactions'>

/**
 * The render coordinator: keeps its editor's entries in {@link fenceRenderResults} in step with
 * the document. For every dispatched fence whose stored result is missing or stale
 * (source/theme changed) it schedules `renderer.render()` - immediately for a fresh fence,
 * debounced while the fence is revealed (live typing) - and dispatches {@link renderCompleted}
 * when the outcome lands, so the field redraws the widgets with the result. Entries for fences
 * that no longer exist are swept (their pending timers cancelled). Everything it touches is
 * keyed by its own {@link renderOwner}: another pane's entries are invisible to it.
 */
export class FenceRenderCoordinator {
    readonly owner: number
    private readonly untrack: () => void

    constructor(readonly view: RenderCoordinatorHost) {
        this.owner = view.state.facet(renderOwner)
        this.reconcile()
        // Tracked only once the first reconcile has succeeded: a coordinator whose constructor
        // threw is dropped by CodeMirror without a destroy(), and must not stay registered.
        this.untrack = trackRenderCoordinator(this)
    }

    update(update: RenderCoordinatorUpdate): void {
        const ticked = update.transactions.some((tr) => tr.effects.some((e) => e.is(themeTick)))
        if (update.docChanged || ticked || update.selectionSet) this.reconcile()
    }

    reconcile(): void {
        const { state } = this.view
        const dark = isDark()
        const seen = new Set<string>()
        for (const f of rendererDispatchedFences(state)) {
            const key = fenceResultKey(this.owner, f.info, f.start)
            seen.add(key)
            const entry = fenceRenderResults.get(key)
            if (entry && entry.source === f.source && entry.dark === dark) continue
            this.schedule(key, f, dark, entry !== undefined && f.revealed ? PREVIEW_DEBOUNCE_MS : 0)
        }
        this.sweep(seen)
    }

    /**
     * The caches were cleared ({@link clearRenderCaches}): drop this pane's rendered nodes and
     * render every fence it shows again, at once. The entries themselves stay, version and all,
     * which is what keeps the on-screen widgets in place until the fresh results redraw them.
     * A render that was already in flight is superseded (its request id is bumped), so nothing
     * rendered before the clear can land afterwards. A stored error stays: a failed `flip`
     * fence is what keeps that fence uncollapsed (rendered-common.ts), and the retry overwrites
     * it either way.
     */
    refresh(): void {
        const { state } = this.view
        const dark = isDark()
        const seen = new Set<string>()
        for (const f of rendererDispatchedFences(state)) {
            const key = fenceResultKey(this.owner, f.info, f.start)
            seen.add(key)
            const entry = fenceRenderResults.get(key)
            if (entry) {
                entry.node = null
                entry.reqSeq++
            }
            this.schedule(key, f, dark, 0)
        }
        this.sweep(seen)
    }

    /** Drop this pane's entries for fences that are no longer in its document. */
    private sweep(seen: ReadonlySet<string>): void {
        for (const [key, entry] of fenceRenderResults) {
            if (entry.owner !== this.owner || seen.has(key)) continue
            if (entry.pending !== null) clearTimeout(entry.pending)
            fenceRenderResults.delete(key)
        }
    }

    private schedule(key: string, f: DispatchedFence, dark: boolean, delay: number): void {
        let entry = fenceRenderResults.get(key)
        if (!entry) {
            entry = {
                owner: this.owner,
                source: f.source,
                dark,
                version: 0,
                node: null,
                error: null,
                pending: null,
                reqSeq: 0,
            }
            fenceRenderResults.set(key, entry)
        }
        // Keep the previous node visible during the debounce; record the target source now
        // so reconcile() doesn't re-schedule every update.
        entry.source = f.source
        entry.dark = dark
        if (entry.pending !== null) clearTimeout(entry.pending)
        const target: FenceRenderResult = entry
        entry.pending = setTimeout(() => {
            target.pending = null
            const seq = ++target.reqSeq
            // Superseded by a later request, by edited source, or by the entry having been
            // cleared (a lock) or destroyed (a closed pane) while the render was in flight: a
            // late result must never land, and never put a cleared entry back.
            const stale = () =>
                target.reqSeq !== seq || target.source !== f.source || fenceRenderResults.get(key) !== target
            f.renderer
                .render(f.source, { dark })
                .then((node) => {
                    if (stale()) return
                    target.node = node
                    target.error = null
                    this.complete(target)
                })
                .catch((error: unknown) => {
                    if (stale()) return
                    target.node = null
                    target.error = error instanceof Error ? error.message : String(error)
                    this.complete(target)
                })
        }, delay)
    }

    private complete(entry: FenceRenderResult): void {
        entry.version++
        try {
            this.view.dispatch({ effects: renderCompleted.of(null) })
        } catch {
            // The view was destroyed while the render was in flight - nothing to redraw.
        }
    }

    /** The editor is gone: cancel this pane's pending renders and drop its results. */
    destroy(): void {
        this.untrack()
        for (const [key, entry] of fenceRenderResults) {
            if (entry.owner !== this.owner) continue
            if (entry.pending !== null) clearTimeout(entry.pending)
            entry.pending = null
            fenceRenderResults.delete(key)
        }
    }
}

const renderCoordinator = ViewPlugin.define((view) => new FenceRenderCoordinator(view))

/**
 * ArrowDown/Up from the line adjacent to a collapsed BLOCK-form widget (prose / form-2): CM's
 * vertical motion skips a block replace entirely, so step the caret INTO the fence instead —
 * landing inside reveals it (invariant 4). Form-1 needs no handler: ArrowDown lands on the
 * opener line and the caret clamp snaps to the fence column, which touches the replace range.
 */
function arrowIntoCollapsed(dir: 1 | -1) {
    return (view: EditorView): boolean => {
        const { state } = view
        const sel = state.selection.main
        if (!sel.empty) return false
        const caretLine = state.doc.lineAt(sel.head).number // 1-based
        for (const f of rendererCollapsedFences(state)) {
            if (f.bulletOpener) continue
            // Down from the line above the opener → opener's content start; up from the line
            // below the closer → the closer line's end.
            if (dir === 1 && caretLine === f.start) {
                const target = state.doc.line(f.start + 1).from + f.fenceColumn
                view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: 'select' })
                return true
            }
            if (dir === -1 && caretLine === f.end + 2) {
                view.dispatch({ selection: { anchor: f.blockTo }, scrollIntoView: true, userEvent: 'select' })
                return true
            }
        }
        return false
    }
}

/** The fence containing `pos`, among the currently-dispatched set. */
function fenceAt(state: EditorState, pos: number): DispatchedFence | null {
    for (const f of rendererDispatchedFences(state)) {
        if (pos >= f.blockFrom && pos <= f.blockTo) return f
    }
    return null
}

const pointer = EditorView.domEventHandlers({
    mousedown(event, view) {
        const target = event.target as HTMLElement | null
        // Clicking the rendered output: reveal by placing the caret at the fence source start.
        // Resolve the fence LIVE from the widget's DOM position — never a stored offset (CM
        // reuses widget DOM across edits; see image-embed.ts).
        const widgetEl = target?.closest('[data-augmentation="rendered"]')
        if (widgetEl) {
            event.preventDefault()
            const f = fenceAt(view.state, view.posAtDOM(widgetEl))
            if (!f) return false
            const anchor = view.state.doc.line(f.start + 1).from + f.fenceColumn
            view.dispatch({ selection: { anchor }, scrollIntoView: true })
            view.focus()
            return true
        }
        // A click BESIDE a collapsed form-1 widget lands on its (diagram-tall) line — CM's
        // coordinate model drifts there exactly as it does beside a tall bullet image
        // (image-embed.ts), so never let it fall through: reveal with the caret at the
        // fence source start instead.
        const lineEl = target?.closest('.cm-line')
        if (!lineEl) return false
        const line = view.state.doc.lineAt(view.posAtDOM(lineEl, 0))
        for (const f of rendererCollapsedFences(view.state)) {
            if (f.bulletOpener && f.start + 1 === line.number) {
                event.preventDefault()
                view.dispatch({ selection: { anchor: line.from + f.fenceColumn }, scrollIntoView: true })
                view.focus()
                return true
            }
        }
        return false
    },
})

const theme = EditorView.baseTheme({
    // The rendered block's spacing from the lines around it, as padding, and a formatting context of
    // its own so KaTeX's `.katex-display` margin cannot collapse through (BLOCK_WIDGET_SPACING says why).
    '.gk-rendered--block': { padding: `${BLOCK_WIDGET_SPACING} 0`, display: 'flow-root' },
    // Rendered output must not inherit the editor's text layout: a form-1 widget sits INSIDE
    // a .cm-line carrying the outliner hang-indent pair, whose large negative `text-indent`
    // inherits into mermaid's foreignObject HTML labels and shoves their text out of the
    // nodes (empty boxes). Same for pre-wrap whitespace.
    '.gk-rendered': { textIndent: '0', whiteSpace: 'normal' },
    // Form-1: sits right after the real `- ` marker, dropped like a bullet image so the dot
    // reads as the block's top-left corner.
    '.gk-rendered--inline': { display: 'inline-block', verticalAlign: 'top', margin: `${BULLET_DROP} 0 0` },
    '.gk-mermaid svg': { maxWidth: '100%', height: 'auto' },
    '.gk-math--block': { margin: '0.2em 0' },
    '.gk-rendered-error': {
        display: 'inline-block',
        padding: '0.3em 0.7em',
        borderRadius: '5px',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        color: 'var(--gk-code-invalid, #d00)',
        cursor: 'pointer',
        fontSize: '0.9em',
    },
    // Outer spacer: vertical spacing as PADDING (height-integrity rule above); the visible
    // panel is the inner element.
    '.gk-rendered-preview': { padding: '0.2em 0 0.4em', display: 'flow-root' },
    '.gk-rendered-preview-panel': {
        padding: '0.5em 0.7em',
        borderRadius: '5px',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
    },
    '.gk-rendered-preview-error': {
        color: 'var(--gk-code-invalid, #d00)',
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: '0.85em',
        whiteSpace: 'pre-wrap',
    },
})

/** The rendered-fence augmentation (ADR 0022). Mounted in DocumentView alongside the others. */
export function fenceRenderAugmentation(): Extension {
    // One owner per mounted editor: the field, the widgets and the coordinator all read it back
    // out of the state, so every result this editor stores is its own.
    const owner = renderOwner.of(++ownerSeq)
    // Block widgets must come from the state (CM needs them before measuring heights).
    const field = StateField.define<DecorationSet>({
        create: (state) => buildDecorations(state),
        update(deco, tr) {
            const ticked = tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted))
            if (tr.docChanged || tr.selection || ticked) return buildDecorations(tr.state)
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })

    const arrows = Prec.high(
        keymap.of([
            { key: 'ArrowDown', run: arrowIntoCollapsed(1) },
            { key: 'ArrowUp', run: arrowIntoCollapsed(-1) },
        ]),
    )

    return [owner, field, renderCoordinator, arrows, pointer, renderedThemePlugin(), theme]
}
