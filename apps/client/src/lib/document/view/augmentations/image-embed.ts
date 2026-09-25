/**
 * Augmentation: render a **standalone image** — a line whose only content is
 * `![alt](url)` — as an inline `<img>`. The alt-text display-size hint (`![alt|300](url)`;
 * see {@link parseImageDisplaySizeHint}) is a **maximum**: the image scales down to fit within it
 * (preserving aspect ratio) but a smaller image is never enlarged. Clicking the image
 * reveals its raw markdown and **pins it open** for editing — it stays revealed (judged by
 * the line you *click*, via the DOM) so repositioning the caret with the mouse can't collapse
 * it; it collapses again when you click another line or navigate away with the keyboard. A
 * pure decoration over unaltered markdown (ADR 0001).
 *
 * The widget keeps CodeMirror's height map true (ADR 0022's height-integrity rule): its vertical
 * spacing is **padding, never margin**, because CM measures a block widget by its border box and
 * a margin is invisible height that shifts the click mapping of every line below (about 13px per
 * image, accumulating down a document until a click at the end of a line lands on the line
 * below); and when the decoded `<img>` replaces its placeholder the widget redraws itself through
 * a state effect ({@link imageDecoded}), since CM ignores mutations inside widget subtrees and would
 * otherwise keep the placeholder's height until the next transaction or scroll.
 * See tests-client/block-widget-height-map.test.ts.
 *
 * Caret placement on a revealed image line uses the browser's own hit-test ({@link posFromPoint})
 * against the markdown's text row: the revealed line reserves the image's height, and a click in
 * the empty space below the text lands by its X. See tests-client/image-caret.test.ts.
 *
 * The `src` comes from the injected `resolveAsset`: remote (`http(s):`/`data:`/`blob:`)
 * urls are used directly, asset references (`../assets/x.png`) are resolved to an object
 * URL through the active {@link AssetStore}. Retina auto-halving is deferred (DESIGN.md).
 *
 * Because that `src` arrives asynchronously (a synced asset is downloaded and decrypted first),
 * the `<img>` is kept OUT of the DOM until it has decoded: the browser would otherwise paint it
 * with no usable source — Chrome's broken-image icon and the alt text — every time the widget is
 * built, including each collapse of the raw markdown. A tinted placeholder with a spinner holds the
 * spot instead (`.cm-md-image--loading`), sized to the image's remembered footprint when there is
 * one so the swap-in does not move the layout. See tests-client/image-loading.test.ts.
 */

import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { type ResolvedAsset, assetNameFromRef } from '$lib/storage/fs/asset-store'

import { assetTargetAt, attachAssetContextMenu, buildAssetActions } from './asset-actions'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, hangWidthForPos } from './content-clamp'
import { parseImageDisplaySizeHint } from './image-display-size'
import { isDirectImageUrl } from './image-target'
import { pinReveal, pinnedRevealField, pinnedRevealFrom, revealInputsChanged, revealedLines } from './reveal-policy'
import { isBulletImageLine, isImageLine, parseImageLine } from '../../image-line'
import { analysisFor } from '../analysis/editor-analysis'
import { uploadingImagesField } from '../uploading-images'

/**
 * The height (px) reserved for the image line currently being edited, snapshotted when the line is
 * first revealed and **held by line number** until the caret leaves — so editing the size hint
 * (`|800` → `|300`) doesn't make the reserved space jump around mid-edit; it updates only once the
 * markdown is collapsed and the image re-renders.
 */
const frozenHeightField = StateField.define<{ line: number; size: ImageSize | null } | null>({
    create: () => null,
    update(value, tr) {
        const line = revealedImageLine(tr.state)
        if (line === null) return null
        if (value && value.line === line) return value // hold the snapshot while editing the same line
        return { line, size: reservedSizeFor(tr.state.doc.line(line).text) }
    },
})

/** The 1-based line number of the image line currently revealed for editing (pinned, else the caret line). */
function revealedImageLine(state: EditorState): number | null {
    const pinned = pinnedRevealFrom(state) // pinned-kind reveal (reveal-policy.ts)
    const n = pinned !== null ? state.doc.lineAt(pinned).number : state.doc.lineAt(state.selection.main.head).number
    const text = state.doc.line(n).text
    return isImageLine(text) ? n : null
}

export interface ImageEmbedOptions {
    /** Resolve an [[Asset Reference]] to its bytes, name and type; `null` ⇒ render a broken-image
     *  affordance. The widget needs more than the url: the overlay's download names the file. */
    resolveAsset: (ref: string) => Promise<ResolvedAsset | null>
}

/** How far the action overlay is inset from the image's top-right corner. */
const OVERLAY_INSET = 6

/**
 * The document position under a screen point, via the browser's own hit-testing (real DOM
 * layout): the caller aims it at the markdown's text row inside a revealed image line, whose
 * reserved height leaves empty space below the text, so a click anywhere in that space lands by
 * its X. Clamped to `[from, to]`; falls back to `from` when the point hits nothing usable.
 */
function posFromPoint(view: EditorView, x: number, y: number, from: number, to: number): number {
    const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null
    }
    let node: Node | undefined
    let offset = 0
    const caret = doc.caretPositionFromPoint?.(x, y)
    if (caret) {
        node = caret.offsetNode
        offset = caret.offset
    } else {
        const range = doc.caretRangeFromPoint?.(x, y)
        if (range) {
            node = range.startContainer
            offset = range.startOffset
        }
    }
    if (!node) return from
    try {
        const pos = view.posAtDOM(node, offset)
        return Math.max(from, Math.min(pos, to))
    } catch {
        return from
    }
}

/**
 * Last rendered footprint of images (px), keyed by ref + size hint. Module-level so it survives
 * decoration rebuilds: when the caret reveals an image's raw markdown, we reserve this size on the
 * line so the tall image's space isn't collapsed — stopping the page from jumping up and back down.
 * `height` is the **full vertical footprint including the wrap's spacing** so the reserved line is
 * exactly as tall as the rendered image (reserving only the content height shrinks the line on reveal
 * and pulls the document below it up); `width` is the rendered `<img>` width, used to size the
 * reveal placeholder tint to the image rather than the full editor width.
 */
interface ImageSize {
    width: number
    height: number
    /** The rendered image's left offset from its line's left edge (px) — so the reveal placeholder lands
     *  exactly where the image sat, instead of a `ch`-derived guess that drifts with the font. */
    left: number
}
const imageSizes = new Map<string, ImageSize>()
export function imageKey(url: string, maxWidth?: number, maxHeight?: number): string {
    return `${url}|${maxWidth ?? ''}|${maxHeight ?? ''}`
}

/**
 * How many times each image (by {@link imageKey}) has had its decoded `<img>` swapped into a widget.
 * The swap changes the widget's height behind CodeMirror's height map: mutations inside a widget
 * subtree are exempt from its observer, so the map keeps the placeholder's height and every line
 * below the image maps clicks to the wrong line until something else makes CM measure again. So
 * the widget bumps this and dispatches {@link imageDecoded}; the field rebuilds, the new widget
 * differs from the old only in this number (`updateDOM` keeps the picture in place), and CM,
 * seeing a changed block decoration, measures the visible blocks again (the render-coordinator
 * shape ADR 0022 prescribes). `requestMeasure()` alone is not enough: CM skips the content
 * measure unless something it tracks changed, and a document shorter than its pane keeps the
 * content box at the pane's height however tall the image grows inside it.
 */
const decodeGenerations = new Map<string, number>()
export const imageDecoded = StateEffect.define<string>()

/** One more decode of the image `key` names; the {@link imageDecoded} dispatched after it redraws the widget. */
export function markImageDecoded(key: string): void {
    decodeGenerations.set(key, (decodeGenerations.get(key) ?? 0) + 1)
}

class ImageWidget extends WidgetType {
    constructor(
        readonly url: string,
        readonly alt: string,
        /** Maximum display width in px (the image scales down to fit, never up). */
        readonly maxWidth: number | undefined,
        /** Maximum display height in px. */
        readonly maxHeight: number | undefined,
        readonly resolveAsset: (ref: string) => Promise<ResolvedAsset | null>,
        /** Content-column clamp in characters (ADR 0020) — pads the widget to align inside a bullet. */
        readonly hangWidth: number,
        /** Inline variant: the image is a bullet's sole content (`- ![…]`), rendered after the marker. */
        readonly inline = false,
        /** A [[Remote Image]] a Rich Paste is still storing: a notice over the picture says so (`uploading-images.ts`). */
        readonly uploading = false,
        /** See {@link decodeGenerations}: differs from the previous widget's once its picture has decoded. */
        readonly decodeGeneration = 0,
    ) {
        super()
    }

    eq(other: ImageWidget): boolean {
        return (
            this.url === other.url &&
            this.alt === other.alt &&
            this.maxWidth === other.maxWidth &&
            this.maxHeight === other.maxHeight &&
            this.hangWidth === other.hangWidth &&
            this.inline === other.inline &&
            this.uploading === other.uploading &&
            this.decodeGeneration === other.decodeGeneration
        )
    }

    /**
     * The remembered footprint, so the height map is near the truth from the moment a block widget is
     * (re)built rather than one line tall until the next measure (the rendered fence does the same).
     * The bullet variant is an inline box, whose line CM measures whole.
     */
    get estimatedHeight(): number {
        if (this.inline) return -1
        return imageSizes.get(imageKey(this.url, this.maxWidth, this.maxHeight))?.height ?? -1
    }

    /** The widget apart from its notice, stamped on the DOM so a notice change updates in place. */
    private identity(): string {
        return [this.url, this.alt, this.maxWidth, this.maxHeight, this.hangWidth, this.inline].join('\u0000')
    }

    /**
     * A notice appearing or clearing, or the decode generation moving on, is the only difference between
     * two widgets of the same identity, and updating in place keeps the picture where it is; anything
     * else rebuilds the widget, which would otherwise reload the picture through its placeholder.
     */
    updateDOM(dom: HTMLElement): boolean {
        if (dom.dataset.imageIdentity !== this.identity()) return false
        // The notice sits in the positioned box: the root itself for a bullet image, its child for a block image.
        const wrap = dom.classList.contains('cm-md-image') ? dom : (dom.querySelector<HTMLElement>('.cm-md-image') ?? dom)
        const notice = wrap.querySelector('.cm-md-image-uploading')
        if (this.uploading && !notice) wrap.appendChild(this.buildUploadingNotice())
        else if (!this.uploading && notice) notice.remove()
        return true
    }

    toDOM(view: EditorView): HTMLElement {
        // The positioned box the picture and its overlays share. A block image wraps it in a root that
        // carries the spacing from the lines around it as padding (BLOCK_WIDGET_SPACING), so the overlays'
        // insets stay measured from the picture's corner; the bullet variant is an inline box inside its
        // line and needs no root of its own.
        const wrap = document.createElement('div')
        wrap.className = this.inline ? 'cm-md-image cm-md-image--inline' : 'cm-md-image'
        const root = this.inline ? wrap : document.createElement('div')
        if (root !== wrap) {
            root.className = 'cm-md-image-block'
            root.appendChild(wrap)
        }
        root.setAttribute('data-augmentation', 'image')
        root.dataset.imageIdentity = this.identity()
        // Inline images sit right after the bullet marker (the marker stays real text); block images
        // carry the content-column clamp padding so they align under the bullet.
        if (!this.inline && this.hangWidth > 0) wrap.style.paddingLeft = `${this.hangWidth}ch`

        // The `<img>` is created detached and only enters the wrap once it has decoded (or failed).
        // Setting `src` on a detached image still fetches it, so nothing is lost by waiting — but an
        // attached image with no usable source paints as the broken-image icon plus the alt text.
        const img = document.createElement('img')
        img.alt = this.alt
        // The hint is a *maximum*: cap with max-width/max-height and leave width/height auto,
        // so the image scales down to fit (keeping its aspect ratio) but is never upscaled.
        // Width is also capped to the editor (min with 100%) so a large hint can't overflow.
        if (this.maxWidth !== undefined) img.style.maxWidth = `min(${this.maxWidth}px, 100%)`
        if (this.maxHeight !== undefined) img.style.maxHeight = `${this.maxHeight}px`

        const placeholder = wrap.appendChild(this.buildPlaceholder())
        // Over the placeholder and the picture alike: the notice is about the upload, not the decode.
        if (this.uploading) wrap.appendChild(this.buildUploadingNotice())

        // `reveal` / `fail` are the only exits from the loading state; whichever fires first wins,
        // and the other becomes a no-op (decode() and the load/error events overlap in when they fire).
        let settled = false
        const show = (canDownload: boolean) => {
            placeholder.remove()
            wrap.appendChild(img)
            this.addActions(view, wrap, img, canDownload)
            // The swap changed the widget's height behind CodeMirror's height map; redraw through the
            // state so CM measures again (see `decodeGenerations`). A widget torn down while the picture
            // was in flight (its line revealed, its pane closed) is not in the document and has nothing
            // to redraw.
            if (!root.isConnected) return
            const key = imageKey(this.url, this.maxWidth, this.maxHeight)
            markImageDecoded(key)
            view.dispatch({ effects: imageDecoded.of(key) })
        }
        const reveal = () => {
            if (settled) return
            settled = true
            show(true)
            this.recordFootprint(root, img)
        }
        const fail = () => {
            if (settled) return
            settled = true
            wrap.classList.add('cm-md-image--broken')
            // The image is still appended: with no usable source the browser renders its alt text,
            // which is the broken affordance's label (a bare dashed box says nothing). The overlay
            // still appears, minus download — a dead reference is exactly what trash is for.
            show(false)
        }
        img.addEventListener('error', fail)

        // "Ready" means DECODED, not merely loaded: `load` fires when the bytes are in, but appending
        // the element then can still cost a blank frame while a large image decodes. `decode()` waits
        // for the pixels; the `load` event is the fallback for when decode() rejects for a reason other
        // than a broken image (an unsupported pre-decode, the element being swapped) — a genuinely
        // broken image fires `error` instead and never gets a `naturalWidth`, so it stays failed.
        let decodeRejected = false
        const canDecode = typeof img.decode === 'function'
        img.addEventListener('load', () => {
            if (!canDecode || decodeRejected) reveal()
        })
        const start = (src: string) => {
            img.src = src
            if (!canDecode) return
            img.decode().then(reveal, () => {
                decodeRejected = true
                if (img.complete && img.naturalWidth > 0) reveal()
            })
        }
        if (isDirectImageUrl(this.url)) {
            start(this.url)
        } else {
            void this.resolveAsset(this.url).then((resolved) => {
                if (resolved) start(resolved.url)
                else fail()
            })
        }
        return root
    }

    /**
     * The notice over a picture a Rich Paste is still storing: plain words on a neutral surface at the
     * image's top-left corner (the actions sit top-right), announced as a status. It goes with the widget
     * the moment the source is rewritten or the upload ends (`uploadingImagesField` rebuilds the widget).
     */
    private buildUploadingNotice(): HTMLElement {
        const notice = document.createElement('span')
        notice.className = 'cm-md-image-uploading'
        notice.setAttribute('role', 'status')
        notice.textContent = 'Uploading…'
        if (!this.inline && this.hangWidth > 0) notice.style.left = `calc(${this.hangWidth}ch + ${OVERLAY_INSET}px)`
        return notice
    }

    /**
     * The box that holds the image's place while it resolves and decodes: a tinted panel with a
     * spinner, announced to assistive tech as a status. Sized to the image's LAST rendered footprint
     * when one is remembered (see {@link imageSizes}) so the real image drops into exactly the same
     * space — the case that matters most is collapsing the raw markdown, which rebuilds the widget
     * for an image that was on screen a moment ago. A first render gets a modest default that
     * cannot overflow the editor (`max-width: 100%` in the theme).
     */
    private buildPlaceholder(): HTMLElement {
        const placeholder = document.createElement('div')
        placeholder.className = 'cm-md-image--loading'
        placeholder.setAttribute('role', 'status')
        placeholder.setAttribute('aria-label', 'Loading image')
        placeholder.appendChild(document.createElement('span')).className = 'cm-md-image-spinner'
        const remembered = imageSizes.get(imageKey(this.url, this.maxWidth, this.maxHeight))
        if (remembered) {
            placeholder.style.width = `${remembered.width}px`
            // The remembered height is the widget's full footprint INCLUDING its vertical spacing (see
            // `ImageSize`); the placeholder sits inside the root that carries that spacing (the block
            // root's padding, the bullet variant's top margin), so take it back off — otherwise the held
            // line would be one spacing too tall and jump on swap.
            const spacing = this.inline ? BULLET_BLOCK_DROP : `${BLOCK_WIDGET_SPACING} * 2`
            placeholder.style.height = `calc(${remembered.height}px - ${spacing})`
        } else {
            placeholder.style.width = '12em'
            placeholder.style.minHeight = '3em'
        }
        return placeholder
    }

    /**
     * Remember the rendered footprint so revealing the markdown can reserve the same space (no jump)
     * and tint a placeholder the size of the image — and so the loading placeholder can match it next
     * time. Height is the widget root's rect, which holds the block root's padding, plus any margin
     * the bullet variant keeps (its top drop), so the reserved line matches the image's full footprint
     * exactly; width is the `<img>` box (the root spans the editor for block images, so measure the
     * image itself). Runs once the decoded image is in the widget, so it measures the box the user
     * actually sees. A widget torn down mid-load (`root` detached) measures nothing.
     */
    private recordFootprint(root: HTMLElement, img: HTMLImageElement): void {
        if (!root.isConnected) return
        const cs = getComputedStyle(root)
        const margin = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
        const height = Math.round(root.getBoundingClientRect().height + margin)
        const imgBox = img.getBoundingClientRect()
        const width = Math.round(imgBox.width)
        const lineEl = root.closest('.cm-line')
        const left = lineEl ? Math.round(imgBox.left - lineEl.getBoundingClientRect().left) : 0
        if (height > 0) imageSizes.set(imageKey(this.url, this.maxWidth, this.maxHeight), { width, height, left })
    }

    /**
     * The hover overlay: the same actions the trailing cluster on a link shows, pinned to the
     * image's top-right corner. Only for an [[Asset Reference]] — a remote image (`https:`,
     * `data:`, `blob:`) is not stored here, so there is nothing to delete and the browser's own
     * "Save image as" already covers saving it; offering a trash for it would be a lie.
     *
     * The overlay is a **sibling of the image inside the wrap**, positioned from the image's
     * measured box rather than by wrapping the image in a hugging element. A wrapper is the
     * obvious way to do this and it does not work here: the extra shrink-to-fit level makes the
     * image's `max-width: 100%` cyclic, and Chrome resolves that to zero — the picture vanishes
     * (measured; caught by image-bullet.test.ts). A block wrap spans the editor while a narrow
     * image does not, so a `ResizeObserver` keeps `--gk-actions-right` at the gap between the
     * image's right edge and the wrap's, and the overlay sits against that. The bullet variant's
     * wrap already hugs its image, so the gap is simply zero there.
     *
     * The buttons stop their own `mousedown` from propagating, which is what keeps a click on one
     * from also reaching the widget handler below and pinning the raw markdown open behind the
     * dialog.
     */
    private addActions(view: EditorView, wrap: HTMLElement, img: HTMLImageElement, canDownload: boolean): void {
        if (assetNameFromRef(this.url) === null) return
        const resolve = () => assetTargetAt(view, wrap, this.url, 'start')
        const actions = buildAssetActions(view, this.url, resolve, {
            className: 'cm-md-image-actions',
            size: 18,
            canDownload,
        })
        wrap.appendChild(actions)

        const trackImageBox = () => {
            const gap = Math.max(0, wrap.clientWidth - (img.offsetLeft + img.offsetWidth))
            // An overlay wider than its image would cover the picture completely - a 40px-wide
            // image against three icons - leaving nothing to hover, click or read. Put it just
            // BESIDE such an image instead, which a negative offset does (the wrap does not clip).
            const overhangs = actions.offsetWidth + OVERLAY_INSET * 2 > img.offsetWidth
            const right = overhangs ? gap - actions.offsetWidth - OVERLAY_INSET * 2 : gap
            wrap.style.setProperty('--gk-actions-right', `${right}px`)
        }
        trackImageBox()
        // Fires once on observe and again whenever either box reflows, so the overlay never
        // drifts off the picture. BOTH boxes: the gap is the difference between them, and a
        // drawer or split-pane resize widens the block wrap (it spans the editor) while an image
        // narrower than the editor keeps its size - watching the image alone misses that entirely,
        // and the overlay slides off along with the wrap's edge.
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(trackImageBox)
            observer.observe(img)
            observer.observe(wrap)
        }

        // Hover is tracked over the image and the overlay specifically, not over the wrap: a
        // block wrap spans the editor, so keying off it would raise the overlay from anywhere on
        // the row. `pointerover`/`pointerout` rather than enter/leave because these bubble, which
        // is what lets a button - the only part of the overlay that takes pointer events - report
        // for the overlay as a whole.
        const setHovered = (on: boolean) => wrap.classList.toggle('cm-md-image--hovered', on)
        const within = (node: Node | null) => !!node && (img.contains(node) || actions.contains(node))
        wrap.addEventListener('pointerover', (event) => {
            if (within(event.target as Node)) setHovered(true)
        })
        wrap.addEventListener('pointerout', (event) => {
            // Moving between the image and the overlay must not flicker the overlay away.
            if (!within(event.relatedTarget as Node | null)) setHovered(false)
        })

        // Touch has no hover, so the overlay never appears there; a long press on the image
        // raises the same actions through the [[Context Menu]]. Right-click does too on desktop.
        attachAssetContextMenu(view, wrap, resolve)
    }

    ignoreEvent(): boolean {
        return false // let mousedown reach the editor handler (to place the caret)
    }
}

/** The remembered rendered footprint for the image on `lineText`, or null if none known. */
function reservedSizeFor(lineText: string): ImageSize | null {
    const image = parseImageLine(lineText)
    if (!image) return null
    const { maxWidth, maxHeight } = parseImageDisplaySizeHint(image.alt)
    return imageSizes.get(imageKey(image.url, maxWidth, maxHeight)) ?? null
}

function buildDecorations(state: EditorState, options: ImageEmbedOptions): DecorationSet {
    const uploading = state.field(uploadingImagesField)
    const active = revealedLines(state) // line-kind reveal (reveal-policy.ts)
    const pinned = pinnedRevealFrom(state)
    const pinnedLine = pinned !== null ? state.doc.lineAt(pinned).number : -1
    const decos: Range<Decoration>[] = []
    for (const imageLine of analysisFor(state).imageLines) {
        const n = imageLine.line
        const line = state.doc.line(n)
        // Reveal raw source while the caret is on the line, or while the image is pinned open — but
        // reserve the image's last rendered height so the line doesn't collapse (no page jump).
        if (active.has(n) || n === pinnedLine) {
            // Hold the frozen snapshot for the line being edited; fall back to the text-derived size
            // for any other revealed image line.
            const frozen = state.field(frozenHeightField)
            const size = frozen && frozen.line === n ? frozen.size : reservedSizeFor(line.text)
            if (size && size.height > 0) {
                // Reserve the image's full height and tint a placeholder the size of the image (painted by
                // `.cm-md-image-reveal::after`) so the held-open space reads as the image rather than an
                // unexplained blank gap. Width, left offset and top offset are the IMAGE's actual rendered
                // footprint (captured on load), so the tint lands exactly where the image sat — left via the
                // measured px (not a `ch` guess that drifts with the font), top via the bullet drop.
                const top = isBulletImageLine(line.text) ? `;--gk-img-top:${BULLET_BLOCK_DROP}` : ''
                const style =
                    `min-height:${size.height}px;--gk-img-w:${size.width}px` +
                    (size.left > 0 ? `;--gk-img-left:${size.left}px` : '') +
                    top
                decos.push(Decoration.line({ attributes: { class: 'cm-md-image-reveal', style } }).range(line.from))
            }
            continue
        }
        const image = parseImageLine(line.text)
        if (!image) continue
        const { cleanAlt, maxWidth, maxHeight } = parseImageDisplaySizeHint(image.alt)
        const decoded = decodeGenerations.get(imageKey(image.url, maxWidth, maxHeight)) ?? 0
        if (image.kind === 'standalone') {
            const hangWidth = hangWidthForPos(state, line.from)
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(image.url, cleanAlt, maxWidth, maxHeight, options.resolveAsset, hangWidth, false, uploading.has(image.url), decoded),
                    block: true,
                }).range(line.from, line.to),
            )
            continue
        }
        // An image that is a bullet's sole content (`- ![…]` / `- [ ] ![…]`): render it INLINE over
        // just the image span, leaving the `- ` marker as real text so the line stays a list item.
        decos.push(
            Decoration.replace({
                widget: new ImageWidget(image.url, cleanAlt, maxWidth, maxHeight, options.resolveAsset, 0, true, uploading.has(image.url), decoded),
                block: false,
            }).range(line.from + image.imageStart, line.to),
        )
    }
    return Decoration.set(decos, true)
}

const theme = EditorView.baseTheme({
    // `relative` so the action overlay can be positioned against the wrap. It carries no
    // width of its own, so nothing about the image's layout changes.
    '.cm-md-image': { position: 'relative' },
    // The block image's root: its spacing from the lines around it, as padding (BLOCK_WIDGET_SPACING says
    // why). The bullet variant is an inline box inside its line, whose line box already holds its margin.
    '.cm-md-image-block': { padding: `${BLOCK_WIDGET_SPACING} 0` },
    // The line holding an image open while its markdown is edited: tint a placeholder the size of the
    // image so the reserved space reads as the image, not a blank gap. The `::after` box is sized to
    // the image (`--gk-img-w` wide, full reserved height, offset by `--gk-img-left` for bullets) and
    // sits behind the markdown text. Theme-neutral translucent fill (matches the fenced-code panel) so
    // it contrasts lightly over any surface. `::after` avoids the clamp's `::before` (content-clamp.ts).
    // `isolate` makes the line its own stacking context so the `z-index:-1` tint stays behind this
    // line's text but in front of the editor surface — never the selection layer or sibling lines.
    '.cm-md-image-reveal': { position: 'relative', isolation: 'isolate' },
    '.cm-md-image-reveal::after': {
        content: '""',
        position: 'absolute',
        left: 'var(--gk-img-left, 0)',
        top: 'var(--gk-img-top, 0)',
        bottom: '0',
        width: 'var(--gk-img-w, 100%)',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        borderRadius: '3px',
        pointerEvents: 'none',
        zIndex: '-1',
    },
    // Inline variant (image as a bullet's content): sits right after the marker. A small top margin drops
    // it a little below the line's top so the bullet dot reads as the block's top-left corner (and the
    // image isn't flush against the row above) — matching the form-1 fenced-code block's feel.
    '.cm-md-image--inline': { display: 'inline-block', verticalAlign: 'top', margin: `${BULLET_BLOCK_DROP} 0 0` },
    '.cm-md-image img': { maxWidth: '100%', height: 'auto', borderRadius: '3px' },
    // The Rich Paste notice: monotone (dark surface, light text, no accent) so it reads over any picture
    // and says nothing but its words; not interactive, so the pointer falls through to the image.
    '.cm-md-image-uploading': {
        position: 'absolute',
        top: `${OVERLAY_INSET}px`,
        left: `${OVERLAY_INSET}px`,
        padding: '2px 8px',
        borderRadius: '4px',
        fontSize: '14px',
        lineHeight: '1.4',
        background: 'rgba(32, 32, 32, 0.78)',
        color: '#fff',
        pointerEvents: 'none',
    },
    // The overlay: pinned top-right, invisible until the pointer is over the image (or a button
    // has keyboard focus, so it is reachable by tab). It sits ON the image, so it carries its own
    // surface rather than borrowing the page's - an icon over a photograph is otherwise unreadable.
    '.cm-md-image-actions': {
        position: 'absolute',
        top: `${OVERLAY_INSET}px`,
        // `--gk-actions-right` is the gap between the image's right edge and the wrap's, measured
        // from the live image (see addActions). Zero is the right answer for a wrap that already
        // hugs its image, which is what makes it a safe default.
        right: `calc(var(--gk-actions-right, 0px) + ${OVERLAY_INSET}px)`,
        display: 'flex',
        gap: '2px',
        padding: '2px',
        borderRadius: '5px',
        background: 'var(--gk-surface-1, rgba(255,255,255,0.92))',
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.12))',
        boxShadow: 'var(--gk-shadow, 0 1px 3px rgba(0,0,0,0.25))',
        opacity: '0',
        transition: 'opacity 120ms ease',
        // The CONTAINER never takes pointer events, only its buttons do. An overlay is easily
        // wider than the image it sits on (a 40px-wide image, three icons), and a container that
        // swallowed the pointer would make such an image impossible to hover or click through -
        // it would disappear under its own controls.
        pointerEvents: 'none',
    },
    '.cm-md-image--hovered .cm-md-image-actions, .cm-md-image-actions:focus-within': { opacity: '1' },
    '.cm-md-image--hovered .cm-asset-action, .cm-md-image-actions:focus-within .cm-asset-action': {
        pointerEvents: 'auto',
    },
    // Touch: no hover to reveal the overlay, and a tap belongs to the editor (it opens the raw
    // markdown). The Context Menu, raised by long press, is the route there - so hide the
    // overlay outright rather than leaving a permanently invisible tap target over the image.
    '@media (hover: none)': {
        '.cm-md-image-actions': { display: 'none' },
    },
    // A broken image has no intrinsic size, so these minimums are what keep the overlay's corner
    // on screen - leaving the trash clickable on exactly the reference a user most wants to
    // clear. Wide enough that the actions and the alt text can both be seen.
    '.cm-md-image--broken': {
        outline: '1px dashed var(--gk-border-soft, rgba(0,0,0,0.3))',
        minHeight: '1.5em',
        minWidth: '10em',
    },
    // The loading placeholder: the same theme-neutral tint as the reveal box (so "image being fetched"
    // and "image held open for editing" read as the same kind of space), a spinner centred in it. Its
    // width/height come inline from the widget (remembered footprint or the default); `max-width:100%`
    // keeps a remembered width from a wider window from overflowing this one. `overflow:hidden` lets
    // a footprint smaller than the spinner (a tiny image) still hold its exact size.
    '.cm-md-image--loading': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        maxWidth: '100%',
        overflow: 'hidden',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        borderRadius: '3px',
    },
    '.cm-md-image-spinner': {
        width: '1em',
        height: '1em',
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: '2px solid rgba(127,127,127,0.25)',
        borderTopColor: 'rgba(127,127,127,0.8)',
        animation: 'cm-md-image-spin 0.9s linear infinite',
    },
    '@keyframes cm-md-image-spin': { to: { transform: 'rotate(360deg)' } },
    // Reduced motion: the ring stays but does not rotate; a slow opacity pulse says "busy"
    // instead. Opacity is not spatial motion, which is what the preference suppresses, and a
    // static dot (the first fallback) read as nothing at all - a user asked whether it was
    // broken. GNOME's "animations off" lands here too, so this state is common on Linux.
    '@keyframes cm-md-image-pulse': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
    '@media (prefers-reduced-motion: reduce)': {
        '.cm-md-image-spinner': {
            animation: 'cm-md-image-pulse 1.6s ease-in-out infinite',
        },
        '.cm-md-image-actions': { transition: 'none' },
    },
})

/** The inline image augmentation (Dual Mode Editor.md). */
export function imageEmbedAugmentation(options: ImageEmbedOptions): Extension {
    // Block widgets must come from the state (CM needs them before measuring heights).
    const imageField = StateField.define<DecorationSet>({
        create: (state) => buildDecorations(state, options),
        update(deco, tr) {
            if (revealInputsChanged(tr)) return buildDecorations(tr.state, options)
            // A notice appearing or clearing is a new widget for that image (the set is fresh on every change).
            if (tr.startState.field(uploadingImagesField) !== tr.state.field(uploadingImagesField)) return buildDecorations(tr.state, options)
            // A picture decoded: the widget for it must change so CM measures its new height (decodeGenerations).
            if (tr.effects.some((e) => e.is(imageDecoded))) return buildDecorations(tr.state, options)
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })

    const pointer = EditorView.domEventHandlers({
        mousedown(event, view) {
            // Primary button only. A right-click is asking for the [[Context Menu]], and pinning
            // the raw markdown open would destroy the very widget the menu is being raised on -
            // the image would vanish and no menu would appear (caught by asset-actions.test.ts).
            if (event.button !== 0) return false
            const target = event.target as HTMLElement | null
            // Clicking the rendered image: reveal + pin it, with the caret at the start of the line.
            // (There is no character under the pointer to map the click onto: the picture stands in
            // for the whole line. Clicking the revealed markdown below positions precisely.)
            //
            // Resolve the line LIVE from the widget's DOM position — never a stored offset. CM reuses a
            // widget's DOM across edits (its `eq` ignores position), so any offset baked into the element
            // when it was created goes stale the moment text above it changes; reading it back then pins
            // the wrong line and the image appears unclickable. `posAtDOM` always reflects the current doc.
            const widget = target?.closest('[data-augmentation="image"]')
            if (widget) {
                event.preventDefault()
                const lineFrom = view.state.doc.lineAt(view.posAtDOM(widget)).from
                view.dispatch({ selection: { anchor: lineFrom }, effects: pinReveal.of(lineFrom) })
                view.focus()
                return true
            }
            // Clicking the revealed markdown (or anywhere else): keep the pin in step — pin the image
            // line you click into so repositioning within it can't collapse it, clear it when you
            // click onto a different line. A gap click (no line element) leaves the pin untouched.
            const lineEl = target?.closest('.cm-line')
            if (!lineEl) return false
            const line = view.state.doc.lineAt(view.posAtDOM(lineEl, 0))
            // A line that renders an image — standalone OR a bullet's inline image (`- ![…]`). For a
            // bullet-image the line box is as tall as the image, so a click *beside* the image must NOT
            // fall through to CodeMirror's coordinate mapping, which has no text row under the pointer to
            // land on — we pin + hit-test the text row instead.
            const isImage = isImageLine(line.text)
            const nextPin = isImage ? line.from : null
            const effects = nextPin !== pinnedRevealFrom(view.state) ? [pinReveal.of(nextPin)] : []
            if (isImage) {
                // Place the caret via the browser's hit-test at the markdown's text row, not CodeMirror's
                // coord model over the click's own Y, which may lie in the reserved space below the text.
                // Clicking anywhere on the revealed markdown lands the caret under the pointer.
                //
                // KNOWN LIMITATION — no mouse drag-select / double-click word-select on an image's
                // markdown line. Preventing the default mousedown is what lets us override CM's wrong
                // caret placement, but it also suppresses CM's native pointer selection, so you can't
                // drag to select (or double-click a word) within `![alt|w](…)`. Workaround: click to
                // position, then Shift+Arrow to extend. If this is reported as a bug, the fix is to
                // place the caret here without killing native selection — e.g. only intervene when
                // CM's hit-test actually disagrees with the browser's, or implement drag handling
                // ourselves. See tests-client/image-caret.test.ts for the positioning regression.
                event.preventDefault()
                // Hit-test the markdown *text row*, not the raw click Y. The revealed line reserves the
                // image's height (so the page doesn't jump), leaving an empty gap below the text; a click
                // in that gap should still place the caret in the markdown by its X, not fall to line-end.
                const rowCoords = view.coordsAtPos(line.from)
                const hitY = rowCoords ? (rowCoords.top + rowCoords.bottom) / 2 : event.clientY
                const pos = posFromPoint(view, event.clientX, hitY, line.from, line.to)
                view.dispatch({ selection: { anchor: pos }, effects })
                view.focus()
                return true
            }
            if (effects.length) view.dispatch({ effects })
            return false // let CodeMirror place the caret normally
        },
    })

    // Field order matters: pinned → frozen-height (reads pinned) → uploading → imageField (reads all three).
    return [pinnedRevealField, frozenHeightField, uploadingImagesField, imageField, pointer, theme]
}
