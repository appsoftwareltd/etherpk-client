/**
 * Augmentation: render a **standalone image** — a line whose only content is
 * `![alt](url)` — as an inline `<img>`. The alt-text display-size hint (`![alt|300](url)`;
 * see {@link parseImageDisplaySizeHint}) is a **maximum**: the image scales down to fit within it
 * (preserving aspect ratio) but a smaller image is never enlarged. Clicking the image puts the
 * caret on its line, which reveals its raw markdown for editing (the line kind of reveal-policy.ts);
 * a click anywhere on that line places the caret on it too (judged by the line you *click*, via the
 * DOM), so repositioning the caret with the mouse cannot collapse it. It collapses again as soon as
 * the caret is on another line, however it got there. A pure decoration over unaltered markdown
 * (ADR 0001).
 *
 * A finger or a pen has no hover to show the picture's controls first, so its tap **selects** the
 * picture instead of revealing it (image-select.ts): the actions and the resize handle show, with
 * **Edit as text** among them, which is the mouse's click. The keyboard stays as it was.
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
 * against the markdown's text rows ({@link textRowY}): the revealed line reserves the image's
 * height, and a click in the empty space below the text lands on the last row by its X. It is a
 * pointer selection style ({@link imageLineSelection}), so a drag, a double click and Shift+click
 * select as on any line, and a touch is the browser's own. A click on the rendered image puts the
 * caret at the end of the markdown ({@link imageClickCaret}). See tests-client/image-caret.test.ts.
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
 *
 * A resolve that fails in a way that passes (`AssetUnavailableError`: the connection, or a server
 * failing for a moment) turns the spinner into "Image not loaded. Retrying…" in the same box and
 * asks again (`asset-load-retry.ts`); any other failure shows the broken state.
 */

import { EditorSelection, type EditorState, type Extension, Facet, findClusterBreak, type Range, StateEffect, StateField, type TransactionSpec } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, type MouseSelectionStyle, WidgetType } from '@codemirror/view'

import { AssetUnavailableError, type ResolvedAsset, assetNameFromRef, displayNameForRef } from '#lib/storage/fs/asset-store.js'

import { assetTargetAt, attachAssetContextMenu, buildAssetActions } from './asset-actions'
import { loadAssetWithRetry } from './asset-load-retry'
import { withinClickSlop } from './click-slop'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, blockWidgetIndent, proseTextInset } from './content-clamp'
import { displayMaxWidth, parseImageDisplaySizeHint } from './image-display-size'
import { type ImageFootprint, activeImageFootprints, persistableImageUrl } from './image-footprints'
import { isDirectImageUrl } from './image-target'
import { imageDeselectSpec, imageTapSpec, isRenderedImageLine, selectedImageField, selectedImageLine } from './image-select'
import { actionButtonTheme, buildActionCluster } from './inline-actions'
import { HANDLE_INSIDE_MIN, MIN_DISPLAY_WIDTH, attachResizeHandle, displayWidthChange, resizeHandleTheme } from './resize-handle'
import { isProtectedDocumentFacet } from './protected-document'
import { lineRevealed, revealInputsChanged, revealedLines } from './reveal-policy'
import { isBulletImageLine, isImageLine, parseImageLine } from '../../image-line'
import { analysisFor } from '../analysis/editor-analysis'
import { keyboardStaysFor } from '../keyboard-hold'
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

/**
 * The 1-based line number of the image line currently revealed for editing: the caret's, if it is one
 * and the reveal policy shows it. A part editor without the keyboard has its caret on a line it does
 * not reveal (reveal-policy.ts); no snapshot is taken then, so the one taken when it is revealed holds
 * the picture's height as drawn, not whatever was known before the picture had drawn at all.
 */
function revealedImageLine(state: EditorState): number | null {
    const n = state.doc.lineAt(state.selection.main.head).number
    const text = state.doc.line(n).text
    return isImageLine(text) && lineRevealed(state, n) ? n : null
}

export interface ImageEmbedOptions {
    /** Resolve an [[Asset Reference]] to its bytes, name and type; `null` ⇒ render a broken-image
     *  affordance. The widget needs more than the url: the overlay's download names the file. */
    resolveAsset: (ref: string) => Promise<ResolvedAsset | null>
    /**
     * Whether a picture at an address on the network may load. Without it every such picture
     * loads, as in a graph. A [[Plain Folder]] gives one: its pictures wait for the person's word.
     */
    remote?: RemoteImagePolicy
}

/**
 * The say over pictures fetched from the network (`http:` and `https:` addresses). A picture
 * embedded in the text (`data:`) or held by the page (`blob:`) is not one.
 */
export interface RemoteImagePolicy {
    allowed(): boolean
    /** The person asked for remote pictures to load. */
    allow(): void
    /** Told when the answer changes. Returns an unsubscribe. */
    onChange(listener: () => void): () => void
}

const remoteImagePolicy = Facet.define<RemoteImagePolicy, RemoteImagePolicy | null>({ combine: (policies) => policies[0] ?? null })

const NETWORK_ADDRESS = /^https?:/i

/** The host a picture would be fetched from, for the sentence that says it was not. */
function hostOf(url: string): string {
    try {
        return new URL(url.trim()).host
    } catch {
        return 'the network'
    }
}

/** How far the action overlay is inset from the image's top-right corner. */
const OVERLAY_INSET = 6

/**
 * The first of a selected picture's actions: show its markdown, as a mouse's click on it does. A
 * tap selects the picture, so this is how a finger gets to the text. The label is an Extension
 * Fence's for the same thing.
 */
const EDIT_AS_TEXT = { command: 'edit-as-text', icon: 'rename', label: 'Edit as text' }

/**
 * Whether the press under way in an editor is a finger's or a pen's, which a tap on a picture
 * selects where a mouse's click reveals. Set from `pointerdown`, which comes before the `mousedown`
 * a tap makes.
 */
const fingerPress = new WeakMap<EditorView, boolean>()

/**
 * Whether a touch starting on `target` leaves the keyboard as it is: one on a shown picture, its
 * resize handle or one of its actions. Its tap places no caret. Edit as text does, so that one is
 * the browser's own.
 */
function touchKeepsKeyboard(target: Element): boolean {
    const widget = target.closest<HTMLElement>('[data-augmentation="image"]')
    return widget !== null && pictures.has(widget) && target.closest(`[data-image-action="${EDIT_AS_TEXT.command}"]`) === null
}

/**
 * The document position under a screen point, via the browser's own hit-testing (real DOM
 * layout): the caller aims it at one of the markdown's text rows inside a revealed image line, whose
 * reserved height leaves empty space below the text, so a click anywhere in that space lands by
 * its X. The text row can be out of sight while the click is not: scrolled above the pane, or
 * under the app's own chrome. The hit test then lands outside `lineEl`, and the column is found
 * by X among the line's own characters instead ({@link domAtPoint}). Clamped to `[from, to]`; falls
 * back to `from` when neither finds a place.
 */
function posFromPoint(view: EditorView, lineEl: Element, x: number, y: number, from: number, to: number): number {
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
    if (!node || !lineEl.contains(node)) {
        const located = domAtPoint(lineEl, x, y)
        if (!located) return from
        node = located.node
        offset = located.offset
    }
    try {
        const pos = view.posAtDOM(node, offset)
        return Math.max(from, Math.min(pos, to))
    } catch {
        return from
    }
}

/**
 * The place between characters of `lineEl` nearest to the screen point (`x`, `y`), measured from the
 * characters' own boxes, so it needs no hit test: on the row nearest `y` (a wrapped line has
 * several), the character edge nearest `x`. Null when the line has no text.
 */
function domAtPoint(lineEl: Element, x: number, y: number): { node: Text; offset: number } | null {
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let best: { node: Text; offset: number; rowDistance: number; distance: number } | null = null
    for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
        // By grapheme, as CodeMirror's own scan steps, so the caret never lands inside an emoji or
        // between a letter and its combining mark.
        for (let i = 0, next: number; i < text.length; i = next) {
            next = findClusterBreak(text.data, i)
            range.setStart(text, i)
            range.setEnd(text, next)
            const box = range.getBoundingClientRect()
            if (box.width === 0 && box.height === 0) continue
            // The row first, then the column: a character on the nearest row beats a nearer one above or below.
            const rowDistance = Math.max(0, box.top - y, y - box.bottom)
            // Before this character when `x` is in its left half, after it when in its right half.
            const offset = x < (box.left + box.right) / 2 ? i : next
            const distance = Math.min(Math.abs(x - box.left), Math.abs(x - box.right))
            if (!best || rowDistance < best.rowDistance || (rowDistance === best.rowDistance && distance < best.distance)) {
                best = { node: text, offset, rowDistance, distance }
            }
        }
    }
    return best && { node: best.node, offset: best.offset }
}

/**
 * The Y at which to hit-test a click on a revealed image line. The line holds the picture's height
 * open, so its markdown is a few rows at the top (more than one when it wraps) and the rest is empty
 * space: a click on the rows is tested where it is, and a click above or below them on the row
 * nearest it, which for the space below is the last row. Aiming every click at the first row left
 * the later rows of a wrapped line, and with them the end of the markdown, out of reach.
 */
function textRowY(view: EditorView, from: number, to: number, y: number): number {
    const first = view.coordsAtPos(from, 1)
    const last = view.coordsAtPos(to, -1)
    if (!first || !last) return y
    if (y < first.top) return (first.top + first.bottom) / 2
    if (y > last.bottom) return (last.top + last.bottom) / 2
    return y
}

/**
 * What a click on the rendered image at the line starting `lineFrom` dispatches: the caret at the end
 * of its markdown ({@link imageClickCaret}), which reveals the line. Shared with the rule rows, so
 * they drive the same transaction the pointer handler does.
 */
export function imageClickSpec(state: EditorState, lineFrom: number): TransactionSpec {
    return { selection: { anchor: imageClickCaret(state, lineFrom) } }
}

/**
 * Where a click on a rendered image puts the caret: the end of its line's markdown, after the `)`,
 * so what is typed next follows the image and the size hint is a few keys to the left.
 */
export function imageClickCaret(state: EditorState, pos: number): number {
    const line = state.doc.lineAt(pos)
    return line.from + line.text.trimEnd().length
}

/**
 * Last rendered footprint of images (px), keyed by ref + size hint ({@link imageKey}), kept across
 * sessions by the open graph's store ({@link activeImageFootprints}). Kept outside the widgets so it survives decoration rebuilds:
 * when the caret reveals an image's raw markdown, we reserve this size on the line so the tall
 * image's space isn't collapsed — stopping the page from jumping up and back down. And it sizes the
 * height map's estimate and the loading placeholder before a picture has decoded, from the first
 * frame of a session. `height` is the **full vertical footprint including the wrap's spacing** so the
 * reserved line is exactly as tall as the rendered image (reserving only the content height shrinks
 * the line on reveal and pulls the document below it up); `width` is the rendered `<img>` width, used
 * to size the reveal placeholder tint to the image rather than the full editor width.
 */
type ImageSize = ImageFootprint
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

/** How to stop asking for a widget's asset, by the widget's root: called when CodeMirror destroys it. */
const pendingLoads = new WeakMap<HTMLElement, () => void>()

/** The picture in a widget, by the widget's root, once it has decoded and entered the DOM. */
const pictures = new WeakMap<HTMLElement, HTMLImageElement>()

/** The positioned box the picture and its overlays share, in a widget's root. */
function wrapOf(root: HTMLElement): HTMLElement {
    return root.classList.contains('cm-md-image') ? root : (root.querySelector<HTMLElement>('.cm-md-image') ?? root)
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
        /** Where its line's text starts (`blockWidgetIndent`): a block image pads itself to it. Null at column 0. */
        readonly indent: string | null,
        /** Inline variant: the image is a bullet's sole content (`- ![…]`), rendered after the marker. */
        readonly inline = false,
        /** A [[Remote Image]] a Rich Paste is still storing: a notice over the picture says so (`uploading-images.ts`). */
        readonly uploading = false,
        /** See {@link decodeGenerations}: differs from the previous widget's once its picture has decoded. */
        readonly decodeGeneration = 0,
        /** A tap selected it (image-select.ts): its controls show, Edit as text among them. */
        readonly selected = false,
    ) {
        super()
    }

    eq(other: ImageWidget): boolean {
        return (
            this.url === other.url &&
            this.alt === other.alt &&
            this.maxWidth === other.maxWidth &&
            this.maxHeight === other.maxHeight &&
            this.indent === other.indent &&
            this.inline === other.inline &&
            this.uploading === other.uploading &&
            this.decodeGeneration === other.decodeGeneration &&
            this.selected === other.selected
        )
    }

    /**
     * The remembered footprint, so the height map is near the truth from the moment a block widget is
     * (re)built rather than one line tall until the next measure (the rendered fence does the same).
     * The bullet variant is an inline box, whose line CM measures whole.
     */
    get estimatedHeight(): number {
        if (this.inline) return -1
        return activeImageFootprints().get(imageKey(this.url, this.maxWidth, this.maxHeight))?.height ?? -1
    }

    /** The widget apart from its notice and its size hint, stamped on the DOM so either changes in place. */
    private identity(): string {
        return [this.url, this.alt, this.indent, this.inline].join('\u0000')
    }

    /** The size hint, stamped on the DOM beside the identity. */
    private sizeStamp(): string {
        return `${this.maxWidth ?? ''}x${this.maxHeight ?? ''}`
    }

    /**
     * The hint is a *maximum*: cap with max-width/max-height and leave width/height auto, so the image
     * scales down to fit (keeping its aspect ratio) but is never upscaled. Width is also capped to the
     * editor (`displayMaxWidth`) so a large hint can't overflow; no hint leaves the theme's 100%.
     */
    private applySize(img: HTMLImageElement): void {
        img.style.maxWidth = this.maxWidth !== undefined ? displayMaxWidth(this.maxWidth) : ''
        img.style.maxHeight = this.maxHeight !== undefined ? `${this.maxHeight}px` : ''
    }

    /**
     * A notice appearing or clearing, the decode generation moving on, a tap selecting or deselecting
     * it, or a shown picture's size hint changing (a drag of the resize handle) is the only difference
     * between two widgets of the same identity, and updating in place keeps the picture where it is;
     * anything else rebuilds the widget, which would otherwise reload the picture through its placeholder.
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        if (dom.dataset.imageIdentity !== this.identity()) return false
        const img = pictures.get(dom)
        const resized = dom.dataset.imageSize !== this.sizeStamp()
        // A picture still loading keeps its placeholder, sized for the hint it was built with: rebuild.
        if (resized && !img) return false
        // The notice sits in the positioned box: the root itself for a bullet image, its child for a block image.
        const wrap = wrapOf(dom)
        const notice = wrap.querySelector('.cm-md-image-uploading')
        if (this.uploading && !notice) wrap.appendChild(this.buildUploadingNotice())
        else if (!this.uploading && notice) notice.remove()
        wrap.classList.toggle('cm-md-image--selected', this.selected)
        if (resized && img) {
            this.applySize(img)
            dom.dataset.imageSize = this.sizeStamp()
            // The footprint at the new size, under the new hint's key, once it is laid out: what a
            // reveal reserves and the next load's placeholder takes.
            requestAnimationFrame(() => this.recordFootprint(view, dom, img))
        }
        return true
    }

    toDOM(view: EditorView): HTMLElement {
        // The positioned box the picture and its overlays share. A block image wraps it in a root that
        // carries the spacing from the lines around it as padding (BLOCK_WIDGET_SPACING), so the overlays'
        // insets stay measured from the picture's corner; the bullet variant is an inline box inside its
        // line and needs no root of its own.
        const wrap = document.createElement('div')
        wrap.className = ['cm-md-image', this.inline && 'cm-md-image--inline', this.selected && 'cm-md-image--selected'].filter(Boolean).join(' ')
        const root = this.inline ? wrap : document.createElement('div')
        if (root !== wrap) {
            root.className = 'cm-md-image-block'
            root.appendChild(wrap)
        }
        root.setAttribute('data-augmentation', 'image')
        root.dataset.imageIdentity = this.identity()
        root.dataset.imageSize = this.sizeStamp()
        // Inline images sit right after the bullet marker (the marker stays real text); a block image
        // starts where its line's text would, under a bullet's text or a prose line's own spaces.
        if (!this.inline && this.indent) wrap.style.paddingLeft = this.indent

        // The `<img>` is created detached and only enters the wrap once it has decoded (or failed).
        // Setting `src` on a detached image still fetches it, so nothing is lost by waiting — but an
        // attached image with no usable source paints as the broken-image icon plus the alt text.
        const img = document.createElement('img')
        img.alt = this.alt
        this.applySize(img)

        const placeholder = wrap.appendChild(this.buildPlaceholder())
        // Over the placeholder and the picture alike: the notice is about the upload, not the decode.
        if (this.uploading) wrap.appendChild(this.buildUploadingNotice())

        // `reveal` / `fail` are the only exits from the loading state; whichever fires first wins,
        // and the other becomes a no-op (decode() and the load/error events overlap in when they fire).
        let settled = false
        const show = (canDownload: boolean, broken: boolean) => {
            placeholder.remove()
            wrap.appendChild(img)
            pictures.set(root, img)
            this.addOverlays(view, root, img, canDownload, broken)
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
            show(true, false)
            this.recordFootprint(view, root, img)
        }
        const fail = () => {
            if (settled) return
            settled = true
            wrap.classList.add('cm-md-image--broken')
            // The image is still appended: with no usable source the browser renders its alt text,
            // which is the broken affordance's label (a bare dashed box says nothing). The overlay
            // still appears, minus download — a dead reference is exactly what trash is for.
            show(false, true)
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
        const held = this.heldBack(view, placeholder, () => start(this.url))
        if (held) pendingLoads.set(root, held)
        else this.fetchPicture(root, placeholder, start, fail)
        return root
    }

    /**
     * A picture on the network waits for the person's word where a policy says so: fetching it
     * tells the address this file was read. Returns what stops the wait, or null to load it now.
     */
    private heldBack(view: EditorView, placeholder: HTMLElement, load: () => void): (() => void) | null {
        // Asked only of a picture that would be fetched from the network.
        const policy = NETWORK_ADDRESS.test(this.url.trim()) ? view.state.facet(remoteImagePolicy) : null
        if (!policy || policy.allowed()) return null
        this.showBlocked(placeholder, policy)
        const off = policy.onChange(() => {
            if (!policy.allowed()) return
            off()
            this.clearBlocked(placeholder)
            load()
        })
        return off
    }

    /** Start the picture from its address, or from the Asset Store when it names an asset. */
    private fetchPicture(root: HTMLElement, placeholder: HTMLElement, start: (url: string) => void, fail: () => void): void {
        if (isDirectImageUrl(this.url)) {
            start(this.url)
            return
        }
        // A synced asset is downloaded first. A failure that may pass (the connection, a server
        // failing for a moment) is not a missing image: the placeholder says so and the resolve
        // is asked again. A damaged file is shown broken, as a missing one is.
        let reported = false
        const cancel = loadAssetWithRetry(() => this.resolveAsset(this.url), {
            resolved: (resolved) => start(resolved.url),
            missing: fail,
            unavailable: (error) => {
                if (!reported) console.warn('[image] could not load an asset; retrying', error)
                reported = true
                this.showUnavailable(placeholder)
            },
            failed: (error) => {
                console.warn('[image] could not read an asset', error)
                fail()
            },
        }, { retryable: (error) => error instanceof AssetUnavailableError })
        pendingLoads.set(root, cancel)
    }

    /** The widget left the document: stop asking for its picture. */
    destroy(dom: HTMLElement): void {
        pendingLoads.get(dom)?.()
        pendingLoads.delete(dom)
    }

    /**
     * A picture on the network that has not been asked for: the placeholder says where it would
     * come from and offers to load remote pictures, in place of a spinner for a fetch that is not
     * happening.
     */
    private showBlocked(placeholder: HTMLElement, policy: RemoteImagePolicy): void {
        placeholder.classList.add('cm-md-image--blocked')
        placeholder.setAttribute('role', 'group')
        placeholder.setAttribute('aria-label', 'Remote image not loaded')
        placeholder.setAttribute('data-testid', 'remote-image-blocked')
        placeholder.style.width = ''
        placeholder.style.height = ''
        placeholder.style.minHeight = ''
        placeholder.replaceChildren()
        const note = placeholder.appendChild(document.createElement('span'))
        note.textContent = `Image from ${hostOf(this.url)} not loaded.`
        const button = placeholder.appendChild(document.createElement('button'))
        button.type = 'button'
        button.className = 'gk-button gk-button--small'
        button.textContent = 'Load remote images in this folder'
        button.setAttribute('data-testid', 'remote-images-load')
        // mousedown, so the press does not first move the caret onto the line and rebuild the widget.
        // And it stops here: a press on the widget otherwise reveals the line's markdown.
        button.addEventListener('mousedown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            policy.allow()
        })
        button.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                policy.allow()
            }
        })
    }

    /** Back to the loading placeholder, once remote pictures are asked for. */
    private clearBlocked(placeholder: HTMLElement): void {
        placeholder.classList.remove('cm-md-image--blocked')
        placeholder.removeAttribute('data-testid')
        placeholder.setAttribute('role', 'status')
        placeholder.setAttribute('aria-label', 'Loading image')
        placeholder.replaceChildren()
        placeholder.appendChild(document.createElement('span')).className = 'cm-md-image-spinner'
        placeholder.style.width = '12em'
        placeholder.style.minHeight = '3em'
    }

    /**
     * The picture could not be fetched and is being asked for again: the placeholder says so instead
     * of spinning with no end. The note sits over the box, out of flow, so the box keeps the height
     * CodeMirror measured it at; a taller one would move the lines below it behind the height map's
     * back (Document Editor.md: block widgets). It stops being a live region: a dropped connection
     * on a page of pictures would otherwise be announced once for every picture.
     */
    private showUnavailable(placeholder: HTMLElement): void {
        if (placeholder.classList.contains('cm-md-image--unavailable')) return
        placeholder.classList.add('cm-md-image--unavailable')
        placeholder.setAttribute('role', 'img')
        placeholder.setAttribute('aria-label', 'Image not loaded. Retrying')
        const note = document.createElement('span')
        note.className = 'cm-md-image-unavailable'
        note.setAttribute('aria-hidden', 'true')
        note.textContent = 'Image not loaded. Retrying…'
        placeholder.replaceChildren(note)
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
        if (!this.inline && this.indent) notice.style.left = `calc(${this.indent} + ${OVERLAY_INSET}px)`
        return notice
    }

    /**
     * The box that holds the image's place while it resolves and decodes: a tinted panel with a
     * spinner, announced to assistive tech as a status. Sized to the image's LAST rendered footprint
     * when one is remembered (see {@link ImageSize}) so the real image drops into exactly the same
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
        const remembered = activeImageFootprints().get(imageKey(this.url, this.maxWidth, this.maxHeight))
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
    private recordFootprint(view: EditorView, root: HTMLElement, img: HTMLImageElement): void {
        if (!root.isConnected) return
        const cs = getComputedStyle(root)
        const margin = (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
        const height = Math.round(root.getBoundingClientRect().height + margin)
        const imgBox = img.getBoundingClientRect()
        const width = Math.round(imgBox.width)
        const lineEl = root.closest('.cm-line')
        const left = lineEl ? Math.round(imgBox.left - lineEl.getBoundingClientRect().left) : 0
        if (height <= 0) return
        // Kept for the next session too, unless the reference is protected text (a [[Protected
        // Document]] must leave no plaintext behind) or cannot outlive this session.
        const persist = persistableImageUrl(this.url) && !view.state.facet(isProtectedDocumentFacet)()
        activeImageFootprints().remember(imageKey(this.url, this.maxWidth, this.maxHeight), { width, height, left }, { persist })
    }

    /**
     * What sits over a shown picture: the actions at its top-right corner ({@link addActions}) and
     * the resize handle at its bottom-right (resize-handle.ts), both raised while a mouse or a
     * hovering pen is over the picture, or once a tap has selected it (image-select.ts). A broken
     * picture has no size to change, so it gets no handle.
     *
     * The overlays are **siblings of the image inside the wrap**, positioned from the image's
     * measured box rather than by wrapping the image in a hugging element. A wrapper is the
     * obvious way to do this and it does not work here: the extra shrink-to-fit level makes the
     * image's `max-width: 100%` cyclic, and Chrome resolves that to zero — the picture vanishes
     * (measured; caught by image-bullet.test.ts). A block wrap spans the editor while a narrow
     * image does not, so a `ResizeObserver` keeps `--gk-image-gap-right` and `--gk-image-gap-bottom`
     * at the gaps between the image's corner and the wrap's, and the overlays sit against those. The
     * bullet variant's wrap already hugs its image, so the right gap is simply zero there.
     */
    private addOverlays(view: EditorView, root: HTMLElement, img: HTMLImageElement, canDownload: boolean, broken: boolean): void {
        const wrap = wrapOf(root)
        const actions = this.addActions(view, root, wrap, canDownload)
        // A read-only editor (a theme preview) has nothing to write, so it offers no handle.
        const handle =
            broken || view.state.readOnly
                ? null
                : attachResizeHandle(view, wrap, img, {
                      title: 'Drag to resize. Double-click for the original size.',
                      // A picture is never enlarged, so a width past its own would write a number it cannot show.
                      limits: () => ({ narrowest: MIN_DISPLAY_WIDTH, widest: Math.min(img.naturalWidth || img.getBoundingClientRect().width, columnWidth(wrap, img)) }),
                      commit: (width) => {
                          // Read the line live from the widget's DOM, as the click handler does: CM reuses
                          // the DOM across edits above it, so an offset kept from building it goes stale.
                          const spec = displayWidthChange(view.state, view.posAtDOM(root), this.url, width)
                          if (spec) view.dispatch(spec)
                      },
                      // A cancelled drag puts the picture's height back with no transaction: redraw, as for a decode.
                      ended: () => {
                          if (!root.isConnected) return
                          const key = imageKeyOn(view.state.doc.lineAt(view.posAtDOM(root)).text)
                          if (key === null) return
                          markImageDecoded(key)
                          view.dispatch({ effects: imageDecoded.of(key) })
                      },
                  })

        const trackImageBox = () => {
            const gap = Math.max(0, wrap.clientWidth - (img.offsetLeft + img.offsetWidth))
            wrap.style.setProperty('--gk-image-gap-right', `${gap}px`)
            wrap.style.setProperty('--gk-image-gap-bottom', `${Math.max(0, wrap.clientHeight - (img.offsetTop + img.offsetHeight))}px`)
            wrap.classList.toggle('cm-md-image--small', Math.min(img.offsetWidth, img.offsetHeight) < HANDLE_INSIDE_MIN)
            wrap.style.setProperty('--gk-actions-right', `${actionsRight(wrap, img, actions, gap)}px`)
        }
        trackImageBox()
        // Fires once on observe and again whenever a box reflows, so the overlays never drift off
        // the picture. The image AND the wrap: the gap is the difference between them, and a
        // drawer or split-pane resize widens the block wrap (it spans the editor) while an image
        // narrower than the editor keeps its size - watching the image alone misses that entirely,
        // and the overlay slides off along with the wrap's edge. And the actions, which grow when a
        // tap selects the picture: Edit as text joins them and each is sized for a finger.
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(trackImageBox)
            observer.observe(img)
            observer.observe(wrap)
            observer.observe(actions)
        }

        // Hover is tracked over the image and the overlays specifically, not over the wrap: a
        // block wrap spans the editor, so keying off it would raise the overlays from anywhere on
        // the row. `pointerover`/`pointerout` rather than enter/leave because these bubble, which
        // is what lets a button - the only part of the actions overlay that takes pointer events -
        // report for the overlay as a whole. A finger is over the picture only while it presses or
        // scrolls, which is no hover: its tap selects the picture instead (image-select.ts).
        const setHovered = (on: boolean) => wrap.classList.toggle('cm-md-image--hovered', on)
        const within = (node: Node | null) => !!node && [img, actions, handle].some((part) => part?.contains(node))
        wrap.addEventListener('pointerover', (event) => {
            if (event.pointerType !== 'touch' && within(event.target as Node)) setHovered(true)
        })
        wrap.addEventListener('pointerout', (event) => {
            // Moving between the image and an overlay must not flicker the overlays away.
            if (!within(event.relatedTarget as Node | null)) setHovered(false)
        })
    }

    /**
     * The actions pinned to the image's top-right corner: Edit as text, which shows only on a picture
     * a tap selected, then the ones the trailing cluster on a link shows. Those are only for an
     * [[Asset Reference]] — a remote image (`https:`, `data:`, `blob:`) is not stored here, so there
     * is nothing to delete and the browser's own "Save image as" already covers saving it; offering
     * a trash for it would be a lie. Such a picture has Edit as text alone, and so no overlay until
     * it is selected.
     *
     * The buttons stop their own `mousedown` from propagating, which is what keeps a click on one
     * from also reaching the widget handler below and revealing the raw markdown behind the
     * dialog.
     */
    private addActions(view: EditorView, root: HTMLElement, wrap: HTMLElement, canDownload: boolean): HTMLElement {
        const isAsset = assetNameFromRef(this.url) !== null
        // The line is read live from the widget's DOM, as every action's target is (asset-actions.ts).
        const edit = buildActionCluster<{ lineFrom: number }>(view, {
            className: 'cm-md-image-edit',
            buttonClass: 'cm-asset-action',
            actionAttr: 'data-image-action',
            name: isAsset ? displayNameForRef(this.url) : this.alt || 'image',
            actions: [EDIT_AS_TEXT],
            size: 18,
            resolveTarget: () => widgetLineFrom(view, root),
            run: (_command, { lineFrom }) => {
                view.dispatch(imageClickSpec(view.state, lineFrom))
                return Promise.resolve(true)
            },
        })
        if (!isAsset) {
            const actions = wrap.appendChild(document.createElement('span'))
            actions.className = 'cm-md-image-actions cm-md-image-actions--edit-only'
            actions.appendChild(edit)
            return actions
        }
        const resolve = () => assetTargetAt(view, wrap, this.url, 'start')
        const actions = buildAssetActions(view, this.url, resolve, {
            className: 'cm-md-image-actions',
            size: 18,
            canDownload,
        })
        actions.prepend(edit)
        wrap.appendChild(actions)
        // A long press on the image raises the same actions through the [[Context Menu]] as well,
        // and right-click does on a desktop.
        attachAssetContextMenu(view, wrap, resolve)
        return actions
    }

    ignoreEvent(event: Event): boolean {
        // The resize handle runs its own gesture; every other event reaches the editor handler
        // (a mousedown places the caret).
        return event.target instanceof Element && event.target.closest('.cm-md-resize-handle') !== null
    }
}

/** The width (px) the picture may take: from its left edge to the right of its line's text column. */
function columnWidth(wrap: HTMLElement, img: HTMLImageElement): number {
    const column = wrap.closest('.cm-line') ?? wrap
    const right = column.getBoundingClientRect().right - (parseFloat(getComputedStyle(column).paddingRight) || 0)
    return right - img.getBoundingClientRect().left
}

/**
 * Where the line of the image widget `root` starts now, or null when the widget has left the
 * document. Read live from the DOM, never from an offset kept when the widget was built: CodeMirror
 * reuses a widget's DOM across edits above it (its `eq` ignores position).
 */
function widgetLineFrom(view: EditorView, root: Element): { lineFrom: number } | null {
    try {
        return { lineFrom: view.state.doc.lineAt(view.posAtDOM(root)).from }
    } catch {
        return null
    }
}

/**
 * `--gk-actions-right` for a picture's actions: how far their right edge sits from the wrap's,
 * before the inset. Over the picture's top-right corner when they fit on it. An overlay wider than
 * its image would cover the picture completely - a 40px-wide image against three icons - leaving
 * nothing to hover, click or read, so it goes just BESIDE such an image instead, which a negative
 * offset does (the wrap does not clip). Where the column has no room beside it (a small picture on
 * a phone, whose selected actions are six finger-sized buttons), the actions start at the picture's
 * left edge and run over it, and no further right than the column's own edge (a picture deep in an
 * outline), so every one of them stays on the screen.
 */
function actionsRight(wrap: HTMLElement, img: HTMLImageElement, actions: HTMLElement, gap: number): number {
    const width = actions.offsetWidth + OVERLAY_INSET * 2
    if (width <= img.offsetWidth) return gap
    // A bullet image's wrap hugs it, so the room beside it is its line's.
    const room = columnWidth(wrap, img) - img.getBoundingClientRect().width
    return room >= width ? gap - width : Math.max(gap + img.offsetWidth - width, gap - room)
}

/** The remembered rendered footprint for the image on `lineText`, or null if none known. */
function reservedSizeFor(lineText: string): ImageSize | null {
    const key = imageKeyOn(lineText)
    return key === null ? null : (activeImageFootprints().get(key) ?? null)
}

/** The key of the image on `lineText` at the size it asks for, or null when it holds none. */
function imageKeyOn(lineText: string): string | null {
    const image = parseImageLine(lineText)
    if (!image) return null
    const { maxWidth, maxHeight } = parseImageDisplaySizeHint(image.alt)
    return imageKey(image.url, maxWidth, maxHeight)
}

/** The markdown of an image line held open at the picture's height, as a mark (see its use). */
const revealedImageSource = Decoration.mark({ class: 'cm-md-image-source' })

/**
 * Forget the footprints of every picture `text` shows, in the open graph's store and in storage, now:
 * the text is becoming a [[Protected Document]]'s, and a footprint stored while it was not protected
 * would keep its references in plaintext (image-footprints.ts).
 */
export function forgetImageFootprintsIn(text: string): void {
    const urls = new Set<string>()
    for (const line of text.split('\n')) {
        const image = parseImageLine(line)
        if (image) urls.add(image.url)
    }
    const store = activeImageFootprints()
    store.forgetImages(urls)
    store.flush()
}

function buildDecorations(state: EditorState, options: ImageEmbedOptions): DecorationSet {
    const uploading = state.field(uploadingImagesField)
    const active = revealedLines(state) // line-kind reveal (reveal-policy.ts)
    const selected = selectedImageLine(state)
    const decos: Range<Decoration>[] = []
    for (const imageLine of analysisFor(state).imageLines) {
        const n = imageLine.line
        const line = state.doc.line(n)
        // Reveal raw source while the caret is on the line, but reserve the image's last rendered
        // height so the line doesn't collapse (no page jump).
        if (active.has(n)) {
            // Hold the frozen snapshot for the line being edited; fall back to the text-derived size
            // for any other revealed image line.
            const frozen = state.field(frozenHeightField)
            const size = frozen && frozen.line === n ? frozen.size : reservedSizeFor(line.text)
            if (size && size.height > 0) {
                // Reserve the image's full height and tint a placeholder the size of the image (painted by
                // `.cm-md-image-reveal::after`) so the held-open space reads as the image rather than an
                // unexplained blank gap. Width, left offset and top offset are the IMAGE's actual rendered
                // footprint, so the tint lands exactly where the image sat: a bullet image's left is the px
                // captured on load (it sat after the marker, in the line), a block image's is where its
                // line's text starts, which is where it started; the top is the bullet drop.
                const bullet = isBulletImageLine(line.text)
                const top = bullet ? `;--gk-img-top:${BULLET_BLOCK_DROP}` : ''
                const left = bullet ? (size.left > 0 ? `${size.left}px` : null) : proseTextInset(state, line.from)
                const style = `min-height:${size.height}px;--gk-img-w:${size.width}px` + (left ? `;--gk-img-left:${left}` : '') + top
                decos.push(Decoration.line({ attributes: { class: 'cm-md-image-reveal', style } }).range(line.from))
                // The held line is as tall as the picture, so its markdown must not be plain text that
                // CodeMirror could take as its row-height sample (ADR 0022). A bullet's is marked already.
                const textFrom = line.from + (line.text.length - line.text.trimStart().length)
                if (!bullet && textFrom < line.to) decos.push(revealedImageSource.range(textFrom, line.to))
            }
            continue
        }
        const image = parseImageLine(line.text)
        if (!image) continue
        const { cleanAlt, maxWidth, maxHeight } = parseImageDisplaySizeHint(image.alt)
        const decoded = decodeGenerations.get(imageKey(image.url, maxWidth, maxHeight)) ?? 0
        if (image.kind === 'standalone') {
            const indent = blockWidgetIndent(state, line.from)
            decos.push(
                Decoration.replace({
                    widget: new ImageWidget(image.url, cleanAlt, maxWidth, maxHeight, options.resolveAsset, indent, false, uploading.has(image.url), decoded, selected === n),
                    block: true,
                }).range(line.from, line.to),
            )
            continue
        }
        // An image that is a bullet's sole content (`- ![…]` / `- [ ] ![…]`): render it INLINE over
        // just the image span, leaving the `- ` marker as real text so the line stays a list item.
        decos.push(
            Decoration.replace({
                widget: new ImageWidget(image.url, cleanAlt, maxWidth, maxHeight, options.resolveAsset, null, true, uploading.has(image.url), decoded, selected === n),
                block: false,
            }).range(line.from + image.imageStart, line.to),
        )
    }
    return Decoration.set(decos, true)
}

/**
 * The place in the document under a press or a drag, when the pointer is on an image line outside
 * its picture: the line's revealed markdown, the space the line holds open below it, or beside a
 * rendered bullet image. Null anywhere else, which is CodeMirror's to place.
 *
 * Found by the browser's hit test at the markdown's *text rows* ({@link textRowY}), not CodeMirror's
 * coordinate model over the pointer's own Y. The revealed line reserves the image's height (so the
 * page doesn't jump), leaving an empty gap below the text: a press in that gap still lands in the
 * markdown by its X, not at the line's end, and a bullet image's line box is as tall as its image,
 * with no text row under a press beside it. When the row is out of sight, {@link posFromPoint}
 * measures the row's characters against the X instead.
 */
function imageLinePos(view: EditorView, event: MouseEvent): number | null {
    const target = event.target instanceof Element ? event.target : null
    if (!target || target.closest('[data-augmentation="image"]')) return null
    const lineEl = target.closest('.cm-line')
    if (!lineEl || !view.contentDOM.contains(lineEl)) return null
    const line = view.state.doc.lineAt(view.posAtDOM(lineEl, 0))
    // The lines the embed renders, by the analysis: a line of code that reads as an image is CodeMirror's.
    if (!isRenderedImageLine(view.state, line.number)) return null
    const hitY = textRowY(view, line.from, imageClickCaret(view.state, line.from), event.clientY)
    return posFromPoint(view, lineEl, event.clientX, hitY, line.from, line.to)
}

/**
 * What a click selects at `pos`, as CodeMirror's own gesture does: the place itself, for a double
 * click the run of like characters there (a word, or the punctuation between two), and for a
 * triple click the line with its break.
 */
function clickRange(state: EditorState, pos: number, clicks: number): { from: number; to: number } {
    if (clicks < 2) return { from: pos, to: pos }
    const line = state.doc.lineAt(pos)
    if (clicks > 2) return { from: line.from, to: Math.min(state.doc.length, line.to + 1) }
    if (line.length === 0) return { from: pos, to: pos }
    // The character after the place, or the one before it at the line's end, and its neighbours of the same kind.
    const categorize = state.charCategorizer(pos)
    const text = line.text
    let from = pos - line.from
    let to = from
    if (from === line.length) from = findClusterBreak(text, from, false)
    else to = findClusterBreak(text, to)
    const kind = categorize(text.slice(from, to))
    for (let prev: number; from > 0 && categorize(text.slice((prev = findClusterBreak(text, from, false)), from)) === kind; ) from = prev
    for (let next: number; to < line.length && categorize(text.slice(to, (next = findClusterBreak(text, to)))) === kind; ) to = next
    return { from: line.from + from, to: line.from + to }
}

/**
 * The selection of a pointer gesture that was pressed at `anchor` with `clicks` clicks and is now at
 * `head`. The press's end stays put and the pointer's follows it, by whole words after a double
 * click and whole lines after a triple one. With `extend` (Shift held) the selection the gesture
 * started from, `before`, reaches to the pointer instead.
 */
export function imageLineGesture(state: EditorState, anchor: number, head: number, clicks: number, extend?: EditorSelection): EditorSelection {
    const to = clickRange(state, head, clicks)
    if (extend) return extend.replaceRange(extend.main.extend(to.from, to.to))
    const from = clickRange(state, anchor, clicks)
    return head < anchor ? EditorSelection.single(from.to, to.from) : EditorSelection.single(from.from, to.to)
}

/**
 * The pointer gesture that starts on an image line at `anchor`: CodeMirror's own (a drag selects, a
 * double click takes a word and a triple one the line, Shift extends), with each place on an image
 * line found by {@link imageLinePos}. The press may reveal the line, which moves the text under the
 * pointer (beside a bullet's picture, the markdown takes the picture's place), so it stays a click
 * until the pointer has moved a click's reach away (click-slop.ts). CodeMirror takes no pointer
 * selection style for a press within two seconds of a touch, so a finger's tap, long press and
 * selection handles on the markdown are the browser's own.
 */
function imageLineSelection(view: EditorView, start: MouseEvent, anchor: number): MouseSelectionStyle {
    let before = view.state.selection
    return {
        update(update) {
            if (!update.docChanged) return
            anchor = update.changes.mapPos(anchor)
            before = before.map(update.changes)
        },
        get(event, extend) {
            const head = withinClickSlop(start, event) ? anchor : (imageLinePos(view, event) ?? view.posAtCoords({ x: event.clientX, y: event.clientY }, false))
            return imageLineGesture(view.state, anchor, head, start.detail, extend ? before : undefined)
        },
    }
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
    // The overlay: pinned top-right, invisible until the pointer is over the image, a tap has
    // selected it, or a button has keyboard focus, so it is reachable by tab. It sits ON the image,
    // so it carries its own surface rather than borrowing the page's - an icon over a photograph is
    // otherwise unreadable.
    '.cm-md-image-actions': {
        position: 'absolute',
        top: `${OVERLAY_INSET}px`,
        // `--gk-actions-right` is the gap between the image's right edge and the wrap's, measured
        // from the live image (see addOverlays). Zero is the right answer for a wrap that already
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
    '.cm-md-image--hovered .cm-md-image-actions, .cm-md-image--selected .cm-md-image-actions, .cm-md-image-actions:focus-within': { opacity: '1' },
    '.cm-md-image--hovered .cm-md-resize-handle, .cm-md-image--selected .cm-md-resize-handle': { opacity: '1', pointerEvents: 'auto' },
    // The shared handle always shows where there is no hover, as a video's must. A picture's waits
    // with its actions for the tap that selects it.
    '@media (hover: none)': {
        '.cm-md-image:not(.cm-md-image--selected) .cm-md-resize-handle': { opacity: '0', pointerEvents: 'none' },
    },
    // Outside a small picture's corner, overlapping it by 4px so the pointer passes straight onto it.
    '.cm-md-image--small .cm-md-resize-handle': {
        right: 'calc(var(--gk-image-gap-right, 0px) - 20px)',
        bottom: 'calc(var(--gk-image-gap-bottom, 0px) - 20px)',
    },
    '.cm-md-image--hovered .cm-asset-action, .cm-md-image--selected .cm-asset-action, .cm-md-image-actions:focus-within .cm-asset-action': {
        pointerEvents: 'auto',
    },
    // A picture a tap selected: no hover showed its actions first, so the tap does, each button big
    // enough for a finger (36px), with Edit as text ahead of them, which is how a finger gets to the
    // markdown. Only the buttons take touches - they stop their own mousedown, so a tap on one never
    // selects or reveals - and a tap anywhere else on the image still belongs to the editor. Long
    // press still raises the asset's actions as a Context Menu.
    '.cm-md-image--selected .cm-md-image-actions .cm-asset-action': { minWidth: '36px', minHeight: '36px' },
    // Edit as text is the selected picture's alone: a mouse's click on the picture already does it.
    '.cm-md-image-edit': { display: 'none' },
    '.cm-md-image--selected .cm-md-image-edit': { display: 'contents' },
    // A picture that is no asset has no other action, so nothing to show until it is selected.
    '.cm-md-image:not(.cm-md-image--selected) .cm-md-image-actions--edit-only': { display: 'none' },
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
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        maxWidth: '100%',
        overflow: 'hidden',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        borderRadius: '3px',
    },
    // A remote picture not asked for: a row in a frame of its own, the sentence and the button
    // that loads them. Chrome inside the text keeps to 14px whatever the editor's zoom.
    '.cm-md-image--blocked': {
        justifyContent: 'flex-start',
        flexWrap: 'wrap',
        gap: '0.5em 0.75em',
        padding: '0.5em 0.75em',
        background: 'transparent',
        border: '1px dashed var(--gk-border-strong)',
        borderRadius: '8px',
        color: 'var(--gk-text-muted)',
        fontSize: 'max(0.875rem, 0.85em)',
        lineHeight: '1.4',
    },
    // A resolve that will be tried again: the note covers the placeholder without adding to its
    // height, at a line height that lets two lines sit in the default box.
    '.cm-md-image-unavailable': {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 0.5em',
        textAlign: 'center',
        lineHeight: '1.4',
        overflow: 'hidden',
        color: 'var(--gk-text-muted, #737373)',
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
            // A tap selected a picture or put its controls away: that widget changes in place.
            if (tr.startState.field(selectedImageField) !== tr.state.field(selectedImageField)) return buildDecorations(tr.state, options)
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })

    const pointer = EditorView.domEventHandlers({
        mousedown(event, view) {
            // Primary button only. A right-click is asking for the [[Context Menu]], and revealing
            // the raw markdown would destroy the very widget the menu is being raised on -
            // the image would vanish and no menu would appear (caught by asset-actions.test.ts).
            if (event.button !== 0) return false
            // A press on the rendered image. One on its line outside it (the revealed markdown, or
            // beside a bullet's image) is a pointer selection (`imageLinePointer` below).
            //
            // Resolve the line LIVE from the widget's DOM position — never a stored offset. CM reuses a
            // widget's DOM across edits (its `eq` ignores position), so any offset baked into the element
            // when it was created goes stale the moment text above it changes; reading it back then reveals
            // the wrong line and the image appears unclickable. `posAtDOM` always reflects the current doc.
            const widget = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-augmentation="image"]')
            const line = widget && widgetLineFrom(view, widget)
            if (!widget || !line) return false
            event.preventDefault()
            // A finger's or a pen's tap on a shown picture selects it, or deselects the selected one:
            // its controls come and go, the caret stays, and so does the keyboard. A picture still
            // loading has no controls to show, so the tap is a click.
            if (fingerPress.get(view) && pictures.has(widget)) {
                view.dispatch(imageTapSpec(view.state, line.lineFrom))
                return true
            }
            // A click reveals it, with the caret at the end of the markdown ({@link imageClickCaret}).
            // There is no character under the pointer to map the click onto: the picture stands in
            // for the whole line. Clicking the revealed markdown positions precisely.
            view.dispatch(imageClickSpec(view.state, line.lineFrom))
            view.focus()
            return true
        },
    })

    // Observers, so they hear a press whichever augmentation's handler takes it.
    const presses = EditorView.domEventObservers({
        pointerdown(event, view) {
            fingerPress.set(view, event.pointerType !== 'mouse')
        },
        mousedown(event, view) {
            // A press anywhere but on the selected picture puts its controls away. On it, the handler
            // above does (a second tap), and a press on one of its controls never gets this far.
            const selected = selectedImageLine(view.state)
            if (selected === null) return
            const widget = (event.target as Element | null)?.closest?.('[data-augmentation="image"]')
            const line = widget && widgetLineFrom(view, widget)
            if (line && view.state.doc.lineAt(line.lineFrom).number === selected) return
            view.dispatch(imageDeselectSpec())
        },
    })

    // A press on an image line outside its picture: the revealed markdown, or beside a rendered
    // bullet image. CodeMirror's own gesture, started and followed through the browser's hit test.
    const imageLinePointer = EditorView.mouseSelectionStyle.of((view, event) => {
        if (event.button !== 0) return null
        const anchor = imageLinePos(view, event)
        return anchor === null ? null : imageLineSelection(view, event, anchor)
    })

    // Field order matters: frozen-height → uploading → selected → imageField (reads all three).
    return [
        frozenHeightField,
        uploadingImagesField,
        selectedImageField,
        imageField,
        pointer,
        presses,
        keyboardStaysFor(touchKeepsKeyboard),
        imageLinePointer,
        theme,
        // The overlay's buttons are the asset cluster's. Asked for here too, as an editor with no
        // asset links (a Plain Folder's) still draws Edit as text on its pictures.
        actionButtonTheme('cm-asset-action'),
        resizeHandleTheme,
        options.remote ? remoteImagePolicy.of(options.remote) : [],
    ]
}
