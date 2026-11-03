/**
 * A drawing in a document: what the extension draws over each ` ```excalidraw.drawing ` fence, in
 * the Client's editor frame (`frame: 'editor'`), which draws the toolbar and the menu round it.
 *
 * - **In the document**, a drawing is a picture until it is clicked (or Enter is pressed on it),
 *   which asks the Client to edit it (`setEditing`), and then a live editor in its place. The frame
 *   draws Done, Full window, Open in tab, Edit as text and Delete above it, and a menu with Edit as
 *   text and Delete over the picture. The Client edits one drawing at a time and stops editing on a
 *   press outside it, other than on Excalidraw's own dialogs and menus in the page's body (`owns`).
 *   Before it stops, or runs an action, it has the editor write what it holds (`flush`).
 * - **In a tab or over the window** (the Client hosts the same widget there), it is a live editor
 *   filling the space.
 * - **On a phone**, or where the document cannot be written, it is only ever a picture. A tap opens
 *   it over the whole window, where it can be zoomed.
 * - **A share link from excalidraw.com** in the drawing is a card offering to import it
 *   (`share-link.ts`). Nothing is fetched until the person presses it.
 * - **Shapes written by hand** (skeletons, `format.ts`) are converted once Excalidraw has loaded and,
 *   where the document can be written, written back as full elements (`scene.ts`).
 *
 * The picture is Excalidraw's own SVG export (`picture.ts`). Everything is built with the DOM and
 * React, never written as HTML. The import card's button and link carry the Client's control classes
 * (`gk-button`, `gk-link`), so they are drawn as EtherPK's own.
 */
import type { FenceContext, FenceInfo, FenceWidget, MountedFence } from '@appsoftwareltd/etherpk-extension-api'

import { mountLiveEditor, type LiveEditor } from './editor'
import { type Drawing, drawingAlt, drawingBounds, planSkeletonWrite, readDrawing } from './format'
import { type ExcalidrawKit, loadExcalidraw } from './load'
import { drawingSvg } from './picture'
import { convertSkeletons, skeletonKey } from './scene'
import { fetchSharedDrawing, ImportError, planImport, shareLinkIn } from './share-link'

export interface DrawingServices {
    /** True while the desktop presenter shows, where drawings are edited. */
    isDesktop(): boolean
    /** Tell the person something the page does not show, such as images left out of an import. */
    notify(message: string): void
}

/** The live editor's height in the document. The frame adds its toolbar's above it. */
const EDITOR_HEIGHT = 520
const PICTURE_MIN = 120
const PICTURE_MAX = 480
const EMPTY_HEIGHT = 120
const IMPORT_HEIGHT = 148
const PADDING = 32
/** How long an import runs before its button says so, so a quick one does not flash. */
const BUSY_DELAY = 200

/** The document column's width, as last measured by any drawing in it, for heights asked before one is drawn. */
let column = 680
/** Numbers for the ids that tie a card to its title. */
let ids = 0

/** A drawing's height in the document: the editor's while it is edited, an import card's, else its picture's at the column's width. */
export function drawingHeight(info: Pick<FenceInfo, 'body' | 'editing'>, width = column): number {
    if (shareLinkIn(info.body)) return IMPORT_HEIGHT
    if (info.editing) return EDITOR_HEIGHT
    // Shapes written by hand count too: they are drawn once converted.
    const drawing = readDrawing(info.body)
    const bounds = drawingBounds([...drawing.elements, ...drawing.skeletons])
    if (!bounds) return EMPTY_HEIGHT
    const scale = Math.min(1, (width - PADDING) / (bounds.width + PADDING))
    return Math.round(Math.min(PICTURE_MAX, Math.max(PICTURE_MIN, (bounds.height + PADDING) * scale)))
}

/**
 * Whether a node in the page is Excalidraw's own, or inside it: its dialogs, menus and pickers,
 * which it puts in the page's body, outside the widget. Their elements carry the `excalidraw` class.
 */
export function excalidrawOwns(node: Node): boolean {
    // Read by its node type rather than `instanceof`, so it holds for a node of any window.
    for (let at: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement; at; at = at.parentElement) {
        if (/\bexcalidraw\b/.test(at.getAttribute('class') ?? '')) return true
    }
    return false
}

/** What the person is told when images were left out of a drawing brought in from excalidraw.com. */
export function imagesLeftOut(count: number, how: 'pasted' | 'imported'): string {
    return `The drawing was ${how} without its ${count === 1 ? 'image' : `${count} images`}. Drawings in EtherPK hold no images.`
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

function button(className: string, text: string, onClick: () => void, testId?: string): HTMLButtonElement {
    const node = element('button', className, text)
    node.type = 'button'
    if (testId) node.dataset.testid = testId
    node.addEventListener('click', onClick)
    return node
}

export function createDrawingWidget(services: DrawingServices): FenceWidget {
    return {
        height: (info) => drawingHeight(info),
        mount(host, initial): MountedFence {
            let context = initial
            let editor: LiveEditor | null = null
            let destroyed = false
            /** Bumped by each draw, so a picture or an editor arriving for an earlier one is dropped. */
            let drawn = 0
            /** The editor takes the keyboard when it starts: the person asked for it, here or by `takeFocus`. */
            let focusNext = false
            const root = element('div', 'excalidraw-drawing')
            root.dataset.presentation = context.presentation
            host.append(root)

            const editable = () => context.writable && services.isDesktop()
            const fills = () => context.presentation !== 'inline'
            /** Whether the drawing should be its live editor now: in a tab or the window, or edited in the document. */
            const wantsEditor = () => editable() && !shareLinkIn(context.body) && (fills() || context.editing === true)
            const live = () => root.classList.contains('excalidraw-drawing--live')

            const kit = () => loadExcalidraw()

            /** Ask the Client to edit the drawing in the document; the editor follows in an update. */
            const askToEdit = () => {
                focusNext = true
                context.setEditing?.(true)
            }

            /**
             * The drawing to show, with any shapes written by hand converted. Where the document can be
             * written, the conversions are written back in their place; the new body arrives in an
             * update, which draws again from full elements.
             */
            const converted = (loaded: ExcalidrawKit, drawing: Drawing): Pick<Drawing, 'header' | 'elements'> => {
                if (drawing.skeletons.length === 0) return drawing
                const conversion = convertSkeletons(loaded, drawing.skeletons)
                if (context.writable && conversion.converted.size > 0) {
                    const edits = planSkeletonWrite(context.body, (skeleton) => conversion.converted.has(skeletonKey(skeleton)), conversion.elements)
                    // Only together with taking the skeletons out, so a write can never add the elements twice.
                    if (edits.some((edit) => edit.kind !== 'insert')) context.edit(edits)
                }
                return { header: drawing.header, elements: [...drawing.elements, ...conversion.elements] }
            }

            const showPicture = async (target: HTMLElement, zoomable: boolean) => {
                const ticket = ++drawn
                const drawing = readDrawing(context.body)
                if (drawing.elements.length === 0 && drawing.skeletons.length === 0) {
                    target.replaceChildren(element('p', 'excalidraw-drawing-empty', editable() ? 'An empty drawing. Click to draw.' : 'An empty drawing.'))
                    return
                }
                target.setAttribute('aria-busy', 'true')
                try {
                    const loaded = await kit()
                    if (ticket !== drawn || destroyed) return
                    const shown = converted(loaded, drawing)
                    const svg = await drawingSvg(loaded, shown)
                    if (ticket !== drawn || destroyed) return
                    svg.classList.add('excalidraw-drawing-svg')
                    svg.setAttribute('role', 'img')
                    svg.setAttribute('aria-label', drawingAlt(shown.elements))
                    if (zoomable) svg.classList.add('excalidraw-drawing-svg--zoomable')
                    target.replaceChildren(svg)
                } catch (error) {
                    console.error('[excalidraw] the picture could not be drawn', error)
                    if (ticket === drawn) target.replaceChildren(element('p', 'excalidraw-drawing-empty', "This drawing couldn't be shown."))
                } finally {
                    target.removeAttribute('aria-busy')
                }
            }

            /** A share link in the drawing: a card that imports it when pressed. */
            const drawImportCard = () => {
                const found = shareLinkIn(context.body)
                if (!found) return
                const card = element('div', 'excalidraw-drawing-import')
                card.dataset.testid = 'excalidraw-import'
                const title = element('p', 'excalidraw-drawing-import-title', 'A drawing shared from excalidraw.com')
                title.id = `excalidraw-drawing-import-${++ids}`
                card.setAttribute('role', 'group')
                card.setAttribute('aria-labelledby', title.id)
                const status = element('p', 'excalidraw-drawing-import-note')
                status.setAttribute('role', 'status')
                const actions = element('div', 'excalidraw-drawing-import-actions')
                const open = element('a', 'gk-link', 'Open on excalidraw.com')
                open.href = found.link
                open.target = '_blank'
                open.rel = 'noopener noreferrer'
                if (context.writable) {
                    status.textContent = 'Pressing import fetches the drawing from excalidraw.com and writes it into this document.'
                    const label = 'Import this drawing from excalidraw.com'
                    let importing = false
                    const run = button('gk-button gk-button--primary', label, () => {
                        if (importing) return
                        importing = true
                        run.setAttribute('aria-busy', 'true')
                        const busy = setTimeout(() => {
                            run.textContent = 'Importing…'
                        }, BUSY_DELAY)
                        const settle = () => {
                            clearTimeout(busy)
                            importing = false
                            run.removeAttribute('aria-busy')
                            run.textContent = label
                        }
                        fetchSharedDrawing(found).then(
                            (shared) => {
                                settle()
                                if (destroyed) return
                                if (!context.edit(planImport(context.body, shared))) {
                                    status.textContent = 'The drawing changed while it was fetched. Press import again.'
                                    return
                                }
                                if (shared.skippedImages > 0) services.notify(imagesLeftOut(shared.skippedImages, 'imported'))
                            },
                            (error: unknown) => {
                                settle()
                                if (destroyed) return
                                status.textContent = error instanceof ImportError ? error.message : "The drawing couldn't be imported. Try again."
                                if (!(error instanceof ImportError)) console.error('[excalidraw] the import failed', error)
                            },
                        )
                    }, 'excalidraw-import-button')
                    actions.append(run)
                } else {
                    status.textContent = 'Open this document where it can be edited to import the drawing.'
                }
                actions.append(open)
                card.append(title, status, actions)
                root.append(card)
            }

            /** The drawing as its picture: in the document, or filling a phone's window. */
            const drawPicture = () => {
                editor?.destroy()
                editor = null
                drawn++
                root.replaceChildren()
                root.classList.remove('excalidraw-drawing--live')
                if (shareLinkIn(context.body)) {
                    drawImportCard()
                    return
                }
                if (fills()) {
                    // A tab or the window on a phone: the picture, which pinch zoom enlarges.
                    const frame = element('div', 'excalidraw-drawing-zoom')
                    root.append(frame)
                    void showPicture(frame, true)
                    return
                }
                const picture = element('button', 'excalidraw-drawing-picture')
                picture.type = 'button'
                picture.dataset.testid = 'excalidraw-picture'
                picture.setAttribute('aria-label', editable() ? 'Drawing. Press to edit it.' : 'Drawing. Press to see it bigger.')
                picture.addEventListener('click', () => (editable() ? askToEdit() : context.openWindow()))
                root.append(picture)
                void showPicture(picture, false)
            }

            /** The drawing live: in its place in the document, or filling a tab or the window. */
            const drawEditor = () => {
                const focus = focusNext
                focusNext = false
                root.replaceChildren()
                root.classList.add('excalidraw-drawing--live')
                const canvas = element('div', 'excalidraw-drawing-editor')
                canvas.dataset.testid = 'excalidraw-editor'
                root.append(canvas)
                const ticket = ++drawn
                kit().then(
                    (loaded: ExcalidrawKit) => {
                        if (ticket !== drawn || destroyed) return
                        // Shapes written by hand are written back first; they reach the editor in the update that follows.
                        converted(loaded, readDrawing(context.body))
                        if (ticket !== drawn || destroyed) return
                        editor = mountLiveEditor(loaded, canvas, context, { autoFocus: focus })
                    },
                    (error: unknown) => {
                        console.error('[excalidraw] the editor could not load', error)
                        if (ticket === drawn) canvas.replaceChildren(element('p', 'excalidraw-drawing-empty', "Excalidraw couldn't load. Check your connection, then try again."))
                    },
                )
            }

            // The column's width, for the picture's height: a change measures every drawing again.
            const observer =
                typeof ResizeObserver === 'undefined' || fills()
                    ? null
                    : new ResizeObserver((entries) => {
                          const width = Math.round(entries[0]?.contentRect.width ?? 0)
                          if (width > 0 && Math.abs(width - column) >= 8) {
                              column = width
                              context.resized()
                          }
                      })
            observer?.observe(host)

            // A drawing just put in at the caret, and one opened in a tab or the window, takes the keyboard.
            const takesFocus = context.takeFocus() || fills()
            focusNext = takesFocus
            if (wantsEditor()) drawEditor()
            else drawPicture()
            // One just put in is edited at once: the Client tells this widget so in an update.
            if (takesFocus && !fills() && editable() && !shareLinkIn(context.body)) context.setEditing?.(true)
            else focusNext = false

            return {
                update(next: FenceContext) {
                    const before = context
                    context = next
                    root.dataset.presentation = next.presentation
                    if (live()) {
                        // Live and no longer to be (editing stopped, or the document can no longer be
                        // written): back to the picture, saved. Otherwise the editor takes the change,
                        // or, still loading, mounts with it.
                        if (!wantsEditor()) drawPicture()
                        else editor?.update(next)
                        return
                    }
                    if (wantsEditor()) {
                        drawEditor()
                        return
                    }
                    const changed = before.writable !== next.writable || before.body.length !== next.body.length || before.body.some((line, i) => line !== next.body[i])
                    if (changed) drawPicture()
                },
                flush: () => editor?.flush(),
                owns: excalidrawOwns,
                destroy() {
                    destroyed = true
                    observer?.disconnect()
                    editor?.destroy()
                    editor = null
                    root.remove()
                },
            }
        },
    }
}
