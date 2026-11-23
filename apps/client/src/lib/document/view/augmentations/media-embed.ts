/**
 * Augmentation: draw an audio or video player under a **media line**, a line whose only content
 * is `![alt](../assets/clip.webm)` over a recording in the graph's files (`media-line.ts`,
 * [[2026-11-18 Audio And Video Players]]). A pure decoration over unaltered markdown (ADR 0001).
 *
 * The line itself is left as it is: the asset-link augmentation shows it as the link to the file,
 * with download, open in a tab and delete, and reveals its markdown while the caret is on it. The
 * player is a block widget **below** the line, there in both states. So the player is never
 * rebuilt when the caret enters or leaves the line, which would stop a recording that is playing,
 * and a file the browser cannot play still has its link above the player's notice.
 *
 * Nothing is read until play is pressed (`media/media-player.ts`), so a document with many
 * recordings opens as fast as one with none.
 *
 * A video fills the text column, since a small one is hard to watch. A display-size hint
 * (`![clip|480](…)`, image-display-size.ts) is its greatest width, and the handle on its picture's
 * corner writes one ({@link attachResizeHandle}). A change of width alone keeps the player, so a
 * video that is playing plays on. An audio player has no picture to size, and keeps its one width.
 *
 * A media line a fold or a part editor hides has no player. The widget sits after its line's end,
 * so a replacement that ends there would leave it standing: hidden lines are left out here. A
 * folded bullet that is itself a media line keeps its player, after the fold.
 *
 * The widget keeps CodeMirror's height map true (ADR 0022's height-integrity rule): its spacing
 * from the line above is **padding, never margin**, a video's picture has one fixed shape, and an
 * unrendered player is estimated from what the last one of its kind measured. A player whose height
 * changes by itself (a notice appearing, a resize put back, a column of another width) is drawn
 * again through {@link playersResized}, since CodeMirror skips measuring a document shorter than its
 * pane when only a widget in it grew.
 */

import { type EditorState, type Extension, type Range, StateEffect, StateField, type Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { type ResolvedAsset, displayNameForRef } from '#lib/storage/fs/asset-store.js'

import { type MediaKind, parseMediaLine } from '../../media-line'
import { analysisFor } from '../analysis/editor-analysis'
import { type MediaPlayer, createMediaPlayer } from '../media/media-player'
import { lineShownIn, shownRangeIn } from '../shown-range'
import { BLOCK_WIDGET_SPACING, blockWidgetIndent } from './content-clamp'
import { displayMaxWidth, parseImageDisplaySizeHint } from './image-display-size'
import { type FoldRange, allFolds } from './outline-folds'
import { attachResizeHandle, displayWidthChange, resizeHandleTheme } from './resize-handle'

export interface MediaEmbedOptions {
    /** Resolve an [[Asset Reference]] to its bytes, name and type. Null: the graph has no such file. */
    resolveAsset: (ref: string) => Promise<ResolvedAsset | null>
}

/** Space between the line's own text and the player under it. */
const SPACE_ABOVE = '0.75em'

/** The narrowest (rem) the handle sizes a video to: the player's own least width (media-player.css). */
const MIN_VIDEO_WIDTH_REM = 15

/** {@link MIN_VIDEO_WIDTH_REM} in px, at the browser's text size. */
const minVideoWidth = () => MIN_VIDEO_WIDTH_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16)

/** The player each widget root holds, so a root CodeMirror drops lets go of its media element. */
const players = new WeakMap<HTMLElement, MediaPlayer>()

/** What the last drawn player of each kind measured, which an unrendered one is estimated from. */
const measured: {
    audio: number
    /** A video's column, and the height of its root without the picture's. Null before one is drawn. */
    video: { column: number; rows: number } | null
} = { audio: -1, video: null }

/** How much taller than wide a video's picture is (media-player.css). */
const PICTURE_SHAPE = 9 / 16

/** A player's height changed with no transaction: the players are drawn again, so CodeMirror measures them. */
const playersResized = StateEffect.define<null>()

/** The room (px) inside a player's root, between its paddings: the width a video with no hint takes. */
function columnWidth(root: HTMLElement): number {
    const style = getComputedStyle(root)
    return root.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
}

/** Draw the players of `view` again, so CodeMirror measures them. */
function redrawPlayers(view: EditorView): void {
    if (!view.dom.isConnected) return
    view.dispatch({ effects: playersResized.of(null) })
    // Run the measure now: asking for a line reads what is measured. Left to the next frame, its scroll
    // correction would move the text from under a pointer.
    view.lineBlockAtHeight(0)
}

/** The height each watched player last had, by its widget's root, and what stops the watch. */
const watched = new WeakMap<HTMLElement, { player: MediaPlayer; height: number; stop(): void }>()

/** One observer for each editor, so players that change together are one redraw. */
const observers = new WeakMap<EditorView, ResizeObserver>()

/** Note the height of `root` for the estimate of the next one. True when it changed after the first. */
function noteHeight(root: HTMLElement): boolean {
    const watch = watched.get(root)
    const height = root.getBoundingClientRect().height
    // Full screen takes the player out of the page. During a drag the picture follows the pointer,
    // and CodeMirror is told once it ends.
    if (!watch || height === 0 || document.fullscreenElement === watch.player.element || root.querySelector('.cm-md-resizing')) return false
    const { stage } = watch.player
    if (stage === null) measured.audio = height
    else measured.video = { column: columnWidth(root), rows: height - stage.getBoundingClientRect().height }
    const changed = watch.height !== 0 && Math.abs(watch.height - height) > 0.5
    watch.height = height
    return changed
}

/**
 * Tell CodeMirror when the height of `root`, a widget of `view`, changes. At once, in the observer:
 * CodeMirror answers a press from its height map, having run any measure that is due, and after a
 * change of the pane's width it asks for its own a moment later. A sidebar that opens as a graph
 * loads changes a video's height by its column, and a press in that moment would land a line off.
 */
function watchHeight(view: EditorView, root: HTMLElement, player: MediaPlayer): void {
    let observer = observers.get(view)
    if (!observer) {
        observer = new ResizeObserver((entries) => {
            // Every one is noted, whichever of them changed.
            const changed = entries.filter((entry) => noteHeight(entry.target as HTMLElement))
            if (changed.length > 0) redrawPlayers(view)
        })
        observers.set(view, observer)
    }
    const watching = observer
    watching.observe(root)
    const watch = { player, height: 0, stop: () => watching.unobserve(root) }
    watched.set(root, watch)
    // The height CodeMirror itself first measures, which a change before the observer's first look is
    // seen against: as a graph opens, the column is set in the frame the player is drawn in.
    view.requestMeasure({
        read: () => {
            if (watch.height === 0) watch.height = root.getBoundingClientRect().height
        },
    })
}

class MediaWidget extends WidgetType {
    constructor(
        readonly url: string,
        readonly kind: MediaKind,
        /** A video's display-size hint: its greatest width in px. Null with no hint, and for audio. */
        readonly maxWidth: number | null,
        /** Where its line's text starts (`blockWidgetIndent`). Null at column 0. */
        readonly indent: string | null,
        readonly resolveAsset: MediaEmbedOptions['resolveAsset'],
        /** How many times the players were drawn again for a change of height (`playersResized`). */
        readonly redraw: number,
    ) {
        super()
    }

    // The alt text is not the widget's: editing a label must not stop a recording that is playing.
    eq(other: MediaWidget): boolean {
        return this.url === other.url && this.kind === other.kind && this.maxWidth === other.maxWidth && this.indent === other.indent && this.redraw === other.redraw
    }

    get estimatedHeight(): number {
        if (this.kind === 'audio') return measured.audio
        if (measured.video === null) return -1
        const { column, rows } = measured.video
        return Math.min(column, Math.max(minVideoWidth(), this.maxWidth ?? column)) * PICTURE_SHAPE + rows
    }

    toDOM(view: EditorView): HTMLElement {
        const root = document.createElement('div')
        root.className = 'cm-md-media'
        root.setAttribute('data-augmentation', 'media')
        root.dataset.mediaRef = this.url
        root.dataset.mediaKind = this.kind
        const player = createMediaPlayer({
            kind: this.kind,
            name: displayNameForRef(this.url),
            source: async () => {
                const asset = await this.resolveAsset(this.url)
                return asset ? { url: asset.url, type: asset.type } : null
            },
            // Escape on the player gives the keyboard back to the document.
            onLeave: () => view.focus(),
        })
        players.set(root, player)
        root.appendChild(player.element)
        this.place(root, player)
        // A read-only editor (a theme preview) has nothing to write, so it offers no handle.
        if (player.stage && !view.state.readOnly) this.addResizeHandle(view, root, player.element, player.stage)
        watchHeight(view, root, player)
        return root
    }

    /** Put `root`'s player where this widget's line starts, at this widget's width. */
    private place(root: HTMLElement, player: MediaPlayer): void {
        root.style.paddingLeft = this.indent ?? ''
        const width = String(this.maxWidth ?? '')
        // Only a change: a redraw for another player's height must not undo a drag of this one.
        if (root.dataset.mediaWidth === width) return
        root.dataset.mediaWidth = width
        player.element.style.maxWidth = this.maxWidth === null ? '' : displayMaxWidth(this.maxWidth)
    }

    /**
     * The resize handle on the picture's corner. The picture meets the player's sides, so the corner
     * is where the pointer drags the player's width from, and the bar under it keeps its own buttons.
     */
    private addResizeHandle(view: EditorView, root: HTMLElement, player: HTMLElement, stage: HTMLElement): void {
        attachResizeHandle(view, stage, player, {
            title: 'Drag to resize. Double-click for the full width.',
            limits: () => ({ narrowest: minVideoWidth(), widest: columnWidth(root) }),
            // The column is the width of a video with no hint, and stays the column on a wider screen.
            widestLabel: 'Full width',
            commit: (width) => {
                // The line, found from where the player stands now: CM keeps this DOM across edits above it.
                const line = mediaLineOfPlayer(view.state, view.posAtDOM(root), this.url)
                const spec = line === null ? null : displayWidthChange(view.state, line, this.url, width)
                if (spec) view.dispatch(spec)
            },
            // A cancelled drag puts the height back with no transaction.
            ended: () => redrawPlayers(view),
        })
    }

    /** The same recording at another indent or width keeps its player, so Tab on a clip that is playing, or a resize, does not stop it. */
    updateDOM(dom: HTMLElement): boolean {
        const player = players.get(dom)
        if (!player || dom.dataset.mediaRef !== this.url || dom.dataset.mediaKind !== this.kind) return false
        this.place(dom, player)
        return true
    }

    destroy(dom: HTMLElement): void {
        players.get(dom)?.destroy()
        players.delete(dom)
        watched.get(dom)?.stop()
        watched.delete(dom)
    }

    // Every press and key on the player is the player's: none places the caret or types.
    ignoreEvent(): boolean {
        return true
    }
}

/**
 * Where the player of the media line ending at `lineEnd` goes, or null when the line is hidden.
 *
 * - Inside a fold (the fold starts before the line's end and reaches it): hidden.
 * - The line is a folded bullet (the fold starts at its end): after the fold, since a block widget
 *   placed before the fold's replacement would end the line and leave the placeholder on a row of
 *   its own. If that place is inside an outer fold, the line is hidden with it.
 */
export function mediaWidgetPos(lineEnd: number, folds: readonly FoldRange[]): number | null {
    const hides = (pos: number) => folds.some((fold) => fold.from < pos && pos <= fold.to)
    if (hides(lineEnd)) return null
    const own = folds.find((fold) => fold.from === lineEnd)
    if (!own) return lineEnd
    // An outer fold that hides this one starts before the line's end and reaches it, so it was seen above.
    return own.to
}

/**
 * Where the line starts whose player, a recording at `url`, stands at `pos`: {@link mediaWidgetPos}
 * the other way round. The player of a folded bullet stands at the end of another line. Null when no
 * line has its player there (the document changed meanwhile).
 */
export function mediaLineOfPlayer(state: EditorState, pos: number, url: string): number | null {
    const { lines, mediaLines } = analysisFor(state)
    const folds = allFolds(state)
    for (const n of mediaLines) {
        if (parseMediaLine(lines[n - 1])?.url !== url) continue
        const line = state.doc.line(n)
        if (mediaWidgetPos(line.to, folds) === pos) return line.from
    }
    return null
}

function buildDecorations(state: EditorState, options: MediaEmbedOptions, redraw: number): DecorationSet {
    const { lines, mediaLines } = analysisFor(state)
    if (mediaLines.length === 0) return Decoration.none
    // A part editor (shown-range.ts) that shows nothing has no players to draw.
    if (shownRangeIn(state) === null) return Decoration.none
    const folds = allFolds(state)
    const decos: Range<Decoration>[] = []
    for (const n of mediaLines) {
        const media = parseMediaLine(lines[n - 1])
        if (!media) continue
        if (!lineShownIn(state, n)) continue
        const line = state.doc.line(n)
        const pos = mediaWidgetPos(line.to, folds)
        if (pos === null) continue
        const maxWidth = media.media === 'video' ? (parseImageDisplaySizeHint(media.alt).maxWidth ?? null) : null
        decos.push(
            Decoration.widget({
                widget: new MediaWidget(media.url, media.media, maxWidth, blockWidgetIndent(state, line.from), options.resolveAsset, redraw),
                block: true,
                side: 1,
            }).range(pos),
        )
    }
    return Decoration.set(decos, true)
}

/** Whether a transaction changed what decides the players: the text, the folds, or the run a part editor shows. */
function inputsChanged(tr: Transaction): boolean {
    if (tr.docChanged || shownRangeIn(tr.startState) !== shownRangeIn(tr.state)) return true
    const before = allFolds(tr.startState)
    const after = allFolds(tr.state)
    return before.length !== after.length || before.some((fold, i) => fold.from !== after[i].from || fold.to !== after[i].to)
}

const theme = EditorView.baseTheme({
    // Padding, never margin: CodeMirror measures a block widget by its border box.
    '.cm-md-media': { padding: `${SPACE_ABOVE} 0 ${BLOCK_WIDGET_SPACING}`, boxSizing: 'border-box' },
    '.cm-md-media .gk-media:hover .cm-md-resize-handle': { opacity: '1', pointerEvents: 'auto' },
    // Where the handle always shows (a phone), it is off the picture while the video plays.
    '@media (hover: none)': {
        '.cm-md-media .gk-media[data-state="playing"] .cm-md-resize-handle': { opacity: '0', pointerEvents: 'none' },
    },
    // Full screen has one width.
    '.gk-media--fullscreen .cm-md-resize-handle': { display: 'none' },
})

export function mediaEmbedAugmentation(options: MediaEmbedOptions): Extension {
    const field = StateField.define<{ players: DecorationSet; redraw: number }>({
        create: (state) => ({ players: buildDecorations(state, options, 0), redraw: 0 }),
        update: (value, tr) => {
            const resized = tr.effects.some((effect) => effect.is(playersResized))
            if (!resized && !inputsChanged(tr)) return value
            const redraw = value.redraw + (resized ? 1 : 0)
            return { players: buildDecorations(tr.state, options, redraw), redraw }
        },
        provide: (f) => EditorView.decorations.from(f, (value) => value.players),
    })
    return [field, theme, resizeHandleTheme]
}
