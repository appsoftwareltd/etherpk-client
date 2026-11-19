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
 * A media line a fold or a part editor hides has no player. The widget sits after its line's end,
 * so a replacement that ends there would leave it standing: hidden lines are left out here. A
 * folded bullet that is itself a media line keeps its player, after the fold.
 *
 * The widget keeps CodeMirror's height map true (ADR 0022's height-integrity rule): its spacing
 * from the line above is **padding, never margin**, a video's picture has one fixed shape, each
 * change of height the player can make (a notice appearing, full screen) asks for a measure, and
 * an unrendered player is estimated at the height the last one of its kind measured.
 */

import { type EditorState, type Extension, type Range, StateField, type Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { type ResolvedAsset, displayNameForRef } from '#lib/storage/fs/asset-store.js'

import { type MediaKind, parseMediaLine } from '../../media-line'
import { analysisFor } from '../analysis/editor-analysis'
import { type MediaPlayer, createMediaPlayer } from '../media/media-player'
import { lineShownIn, shownRangeIn } from '../shown-range'
import { BLOCK_WIDGET_SPACING, blockWidgetIndent } from './content-clamp'
import { type FoldRange, allFolds } from './outline-folds'

export interface MediaEmbedOptions {
    /** Resolve an [[Asset Reference]] to its bytes, name and type. Null: the graph has no such file. */
    resolveAsset: (ref: string) => Promise<ResolvedAsset | null>
}

/** Space between the line's own text and the player under it. */
const SPACE_ABOVE = '0.75em'

/** The player each widget root holds, so a root CodeMirror drops lets go of its media element. */
const players = new WeakMap<HTMLElement, MediaPlayer>()

/** The height a player of each kind last measured, which an unrendered one is estimated at. */
const measuredHeight: Record<MediaKind, number> = { audio: -1, video: -1 }

class MediaWidget extends WidgetType {
    constructor(
        readonly url: string,
        readonly kind: MediaKind,
        /** Where its line's text starts (`blockWidgetIndent`). Null at column 0. */
        readonly indent: string | null,
        readonly resolveAsset: MediaEmbedOptions['resolveAsset'],
    ) {
        super()
    }

    // The alt text is not the widget's: editing a label must not stop a recording that is playing.
    eq(other: MediaWidget): boolean {
        return this.url === other.url && this.kind === other.kind && this.indent === other.indent
    }

    get estimatedHeight(): number {
        return measuredHeight[this.kind]
    }

    toDOM(view: EditorView): HTMLElement {
        const root = document.createElement('div')
        root.className = 'cm-md-media'
        root.setAttribute('data-augmentation', 'media')
        root.dataset.mediaRef = this.url
        root.dataset.mediaKind = this.kind
        root.style.paddingLeft = this.indent ?? ''
        const remeasure = () =>
            view.requestMeasure({
                read: () => root.getBoundingClientRect().height,
                write: (height) => {
                    if (height > 0) measuredHeight[this.kind] = height
                },
            })
        const player = createMediaPlayer({
            kind: this.kind,
            name: displayNameForRef(this.url),
            source: async () => {
                const asset = await this.resolveAsset(this.url)
                return asset ? { url: asset.url, type: asset.type } : null
            },
            onResize: remeasure,
            // Escape on the player gives the keyboard back to the document.
            onLeave: () => view.focus(),
        })
        players.set(root, player)
        root.appendChild(player.element)
        remeasure()
        return root
    }

    /** The same recording at another indent keeps its player, so Tab on a clip that is playing does not stop it. */
    updateDOM(dom: HTMLElement): boolean {
        if (dom.dataset.mediaRef !== this.url || dom.dataset.mediaKind !== this.kind) return false
        dom.style.paddingLeft = this.indent ?? ''
        return true
    }

    destroy(dom: HTMLElement): void {
        players.get(dom)?.destroy()
        players.delete(dom)
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
    return folds.some((fold) => fold !== own && fold.from < own.to && own.to <= fold.to) ? null : own.to
}

function buildDecorations(state: EditorState, options: MediaEmbedOptions): DecorationSet {
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
        decos.push(
            Decoration.widget({
                widget: new MediaWidget(media.url, media.media, blockWidgetIndent(state, line.from), options.resolveAsset),
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
})

export function mediaEmbedAugmentation(options: MediaEmbedOptions): Extension {
    const field = StateField.define<DecorationSet>({
        create: (state) => buildDecorations(state, options),
        update: (value, tr) => (inputsChanged(tr) ? buildDecorations(tr.state, options) : value),
        provide: (f) => EditorView.decorations.from(f),
    })
    return [field, theme]
}
