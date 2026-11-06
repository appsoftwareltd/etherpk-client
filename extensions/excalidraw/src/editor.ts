/**
 * A live Excalidraw editor over one drawing, saving as the person draws:
 *
 * - **What is written.** Only the lines of elements whose version changed, the lines of those the
 *   person deleted removed and new ones added (`planWrite`), as one change (`context.edit` with a
 *   list), at most every half second while drawing and at once when a stroke ends. The scene is read
 *   with its deleted elements, since a deletion is the only thing that removes a line: an element
 *   Excalidraw never loaded keeps its line.
 * - **Changes from elsewhere** (another device, another view of the drawing) arrive as a new body.
 *   They are merged into what is on screen with the drawing as last read (`mergeDrawing`), and
 *   anything newer here is written back on the next save.
 * - **Text being typed, and a shape being drawn,** are Excalidraw's alone until they are finished:
 *   nothing is saved while text is typed, and a change from elsewhere waits for the edit to end.
 *   Excalidraw types into the element it holds, so a scene replaced under it (`updateScene` puts
 *   new copies of every element) left the typing going to an element no longer drawn: its box stayed
 *   at its first measure, cutting off the letters, and the text was dropped when it was finished.
 * - **Undo.** Mod+Z and Mod+Y are Excalidraw's own while it has the keyboard: its fence is registered
 *   with `keepsHistory`.
 * - **Images** arrive by Excalidraw's own routes, its toolbar, a paste or a drop, and show at once. Each
 *   is stored as an Asset of the graph, and its line is written once that is done, with the reference
 *   (`elementsToSave`), so another device never reads an image nothing can find. One that cannot be
 *   stored leaves the canvas and the person is told why. Leaving the page while one is being stored
 *   asks first, and a drawing closed meanwhile still gets its line, from the scene as it closed. An
 *   image pasted with a reference this graph cannot read is stored here from the bytes it came with.
 *
 * Excalidraw's features that reach other services are off: links to its site and social pages,
 * library publishing, web embeds and AI.
 */
import type { FenceContext } from '@appsoftwareltd/etherpk-extension-api'

import { drawingImageName } from './drawing-image'
import { applyEdits, type DrawingHeader, type ElementRecord, elementsToSave, imageAssets, imagesToKeep, mergeDrawing, newDrawingId, planWrite, readDrawing, sameBody } from './format'
import { type DrawingImages, fileDigest, imageFile, type ImageFile, nameOfImage } from './images'
import type { ExcalidrawKit } from './load'
import { restoreScene } from './scene'

/** How long a run of changes waits before it is written, while the person is still drawing. */
const SAVE_DELAY = 500

export interface LiveEditor {
    /** The fence changed (its body, whether it can be written). */
    update(context: FenceContext): void
    /** Write whatever is not yet written, now. */
    flush(): void
    destroy(): void
}

let instances = 0

export interface LiveEditorOptions {
    autoFocus: boolean
    images: DrawingImages
    notify(message: string): void
    /** The fence as it is now, which outlives this editor: an image still being stored when it closes is written through it. */
    current(): FenceContext
}

export function mountLiveEditor(kit: ExcalidrawKit, element: HTMLElement, initial: FenceContext, options: LiveEditorOptions): LiveEditor {
    const { createElement } = kit.react
    const { Excalidraw, MainMenu, CaptureUpdateAction } = kit.excalidraw
    let context = initial
    /** The body as last read or written: the base a change from elsewhere is merged against. */
    let body: readonly string[] = context.body
    const read = readDrawing(body)
    let header: DrawingHeader = read.header ?? { type: 'excalidraw.drawing', version: 1, id: newDrawingId(), background: '#ffffff' }
    type Api = {
        getSceneElementsIncludingDeleted(): readonly unknown[]
        getAppState(): { viewBackgroundColor: string; editingTextElement?: unknown; newElement?: unknown }
        updateScene(scene: unknown): void
        getFiles(): Record<string, ImageFile | undefined>
        addFiles(files: ImageFile[]): void
    }
    let api: Api | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    /** A version stamp of what is on screen when it was last written, so an unchanged scene is not compared line by line. */
    let writtenStamp = ''
    let destroyed = false
    /** A change from elsewhere arrived while something was in hand: merged once the edit ends. */
    let waiting = false
    /** Each image's file and the Asset it names: from the drawing's lines, and from what this editor stored. */
    const assets = imageAssets(read.elements)
    /** The names new images came with, by file, for the Assets they become. */
    const names = new Map<string, string>()
    /** Files being read from the graph, or read. One that could not be read leaves, to be tried again when the drawing changes. */
    const reading = new Set<string>()
    /** Files being kept as Assets. */
    const keeping = new Set<string>()
    /** The scene as the editor closed, for the lines of images it was still storing. */
    let closing: readonly ElementRecord[] | null = null

    /** Leaving the page now would lose the image being stored, whose line is not written yet. */
    const askBeforeLeaving = (event: BeforeUnloadEvent) => {
        event.preventDefault()
    }

    const stampOf = (elements: readonly unknown[], background: string) => `${background}:${(elements as { id: string; version: number }[]).map((e) => `${e.id}.${e.version}`).join(',')}`

    /** Whether Excalidraw is typing text or drawing a shape, which it alone may change until it ends. */
    function inHand(): boolean {
        const state = api?.getAppState()
        return Boolean(state?.editingTextElement || state?.newElement)
    }

    /** Read the images these elements name that Excalidraw does not hold yet. */
    function readImages(elements: readonly ElementRecord[]): void {
        for (const [fileId, ref] of imageAssets(elements)) {
            if (reading.has(fileId) || api?.getFiles()[fileId]) continue
            reading.add(fileId)
            void options.images.read(ref).then(
                (dataURL) => {
                    if (dataURL && api && !destroyed) api.addFiles([imageFile(fileId, dataURL)])
                    else reading.delete(fileId)
                },
                () => reading.delete(fileId),
            )
        }
    }

    /** An image that could not be stored: off the canvas, since it would be gone at the next open, and the person told why. */
    function dropImage(fileId: string, reason: string): void {
        options.notify(`The image couldn't be added to the drawing. ${reason}`)
        if (!api || destroyed) return
        const left = (api.getSceneElementsIncludingDeleted() as ElementRecord[]).filter((element) => element.fileId !== fileId)
        api.updateScene({ elements: left, captureUpdate: kit.excalidraw.CaptureUpdateAction.NEVER })
    }

    /** The image's Asset now known: its line is due, through this editor, or through the fence if this editor closed meanwhile. */
    function writeKept(): void {
        if (!closing) {
            writtenStamp = ''
            flush()
            return
        }
        const now = options.current()
        const late = elementsToSave(closing, assets).filter((element) => element.type === 'image' && !element.isDeleted)
        const edits = planWrite(now.body, { header: readDrawing(now.body).header ?? header, elements: late })
        if (edits.length > 0 && !now.edit(edits)) options.notify("An image you added to a drawing wasn't saved, because the drawing closed first. Add the image again.")
    }

    /**
     * Find the Asset of an image new to this drawing. A reference it came with stands if this graph
     * can read it. Otherwise the bytes are stored here, which for the same bytes finds the same Asset.
     */
    async function keepImage(fileId: string, claimed: string | null, file: ImageFile | undefined): Promise<void> {
        if (claimed && (await options.images.read(claimed).catch(() => null))) {
            assets.set(fileId, claimed)
            return
        }
        if (!file) {
            // No bytes to store: the reference it came with is all there is.
            if (claimed) assets.set(fileId, claimed)
            return
        }
        const stored = await options.images.store(file.dataURL, names.get(fileId) ?? nameOfImage(''))
        if (stored.stored) assets.set(fileId, stored.ref)
        else dropImage(fileId, stored.reason)
    }

    /** Start keeping every image on the canvas with no known Asset. Excalidraw adds a new image's file just after its element. */
    function keepNewImages(elements: readonly ElementRecord[]): void {
        for (const { fileId, claimed } of imagesToKeep(elements, assets)) {
            if (keeping.has(fileId)) continue
            const file = api?.getFiles()[fileId]
            if (!file && !claimed) continue
            if (keeping.size === 0) addEventListener('beforeunload', askBeforeLeaving)
            keeping.add(fileId)
            void keepImage(fileId, claimed, file)
                .catch((error: unknown) => {
                    console.error('[excalidraw] an image could not be stored', error)
                    dropImage(fileId, 'Try again.')
                })
                .finally(() => {
                    keeping.delete(fileId)
                    if (keeping.size === 0) removeEventListener('beforeunload', askBeforeLeaving)
                    if (assets.has(fileId)) writeKept()
                })
        }
    }

    /** Write what changed. While text is typed, nothing is, unless `force` (the editor is closing). */
    function flush(force = false): void {
        if (timer) clearTimeout(timer)
        timer = null
        if (!api || !context.writable) return
        // Finishing the text changes the scene, and that change is saved.
        if (!force && api.getAppState().editingTextElement) return
        const elements = api.getSceneElementsIncludingDeleted() as unknown as ElementRecord[]
        const background = api.getAppState().viewBackgroundColor
        const stamp = stampOf(elements, background)
        if (stamp === writtenStamp) return
        const next = { header: { ...header, background }, elements: elementsToSave(elements, assets) }
        const edits = planWrite(body, next)
        if (edits.length === 0) {
            writtenStamp = stamp
            return
        }
        const after = applyEdits(body, edits)
        // Refused: the body changed meanwhile. Its new text arrives in an update, merged, then saved.
        if (!after || !context.edit(edits)) return
        body = after
        header = next.header
        writtenStamp = stamp
    }

    const schedule = () => {
        if (destroyed || !context.writable) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => flush(), SAVE_DELAY)
    }

    const root = kit.createRoot(element, { identifierPrefix: `etherpk-excalidraw-${++instances}` })
    const render = () => {
        root.render(
            createElement(
                Excalidraw,
                {
                    initialData: {
                        elements: restoreScene(kit, read.elements),
                        appState: { viewBackgroundColor: header.background ?? '#ffffff' },
                        scrollToContent: true,
                    },
                    excalidrawAPI: (value: unknown) => {
                        api = value as Api
                        readImages(read.elements)
                    },
                    // Excalidraw's own id, kept here with the name the file came with, which its file data does not hold.
                    generateIdForFile: async (file: File) => {
                        const id = await fileDigest(file)
                        names.set(id, nameOfImage(file.name))
                        return id
                    },
                    // Light in either of the app's themes: Excalidraw's dark theme inverts the canvas
                    // as it draws, so the colours on screen would not be the colours the drawing holds.
                    theme: 'light',
                    // What its image dialog calls the file: the name the frame's Save as image gives it.
                    name: drawingImageName(context.document, context.ordinal),
                    viewModeEnabled: !context.writable,
                    autoFocus: options.autoFocus,
                    handleKeyboardGlobally: false,
                    onChange: (elements: readonly ElementRecord[]) => {
                        // At once rather than at the next save, so leaving the page asks from the moment an image shows.
                        if (context.writable) keepNewImages(elements)
                        if (waiting && !inHand()) {
                            waiting = false
                            mergeFromDocument()
                        }
                        schedule()
                    },
                    // A stroke ended: written at once, so a closed tab never loses it.
                    onPointerUp: () => queueMicrotask(() => flush()),
                    UIOptions: {
                        canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: true, export: false, toggleTheme: false, changeViewBackgroundColor: true, clearCanvas: true },
                    },
                    validateEmbeddable: false,
                    aiEnabled: false,
                    // Library browsing returns here: the Client's origin, never a page's address, which holds the graph's id.
                    libraryReturnUrl: `${location.origin}/`,
                } as never,
                // Its menu with what works offline only: no links to its site, no social pages.
                createElement(MainMenu, null, createElement(MainMenu.DefaultItems.SaveAsImage), createElement(MainMenu.DefaultItems.ChangeCanvasBackground), createElement(MainMenu.DefaultItems.ClearCanvas)),
            ),
        )
    }
    render()

    /** The document's body, changed elsewhere: merged with what is on screen, against the body as last read. */
    function mergeFromDocument(): void {
        if (!api || sameBody(context.body, body)) return
        const remote = readDrawing(context.body)
        const local = api.getSceneElementsIncludingDeleted() as unknown as ElementRecord[]
        const merged = mergeDrawing(readDrawing(body).elements, local, remote.elements)
        body = context.body
        if (remote.header) header = remote.header
        api.updateScene({ elements: restoreScene(kit, merged), captureUpdate: CaptureUpdateAction.NEVER })
        for (const [fileId, ref] of imageAssets(merged)) assets.set(fileId, ref)
        readImages(merged)
        // Whatever is newer here is written on the next save.
        writtenStamp = ''
        schedule()
    }

    return {
        update(next) {
            const rendersAgain = next.writable !== context.writable || next.document !== context.document || next.ordinal !== context.ordinal
            context = next
            if (rendersAgain) render()
            if (sameBody(next.body, body) || !api) return
            // Not under the text being typed or the shape being drawn: once the edit ends (onChange).
            if (inHand()) {
                waiting = true
                return
            }
            mergeFromDocument()
        },
        flush: () => flush(),
        destroy() {
            flush(true)
            if (api && context.writable) {
                const scene = api.getSceneElementsIncludingDeleted() as unknown as ElementRecord[]
                // An image pasted the moment before: its file is still to be had while Excalidraw is mounted.
                keepNewImages(scene)
                if (keeping.size > 0) closing = scene
            }
            destroyed = true
            if (timer) clearTimeout(timer)
            // Unmounted after the widget's element left: React must not unmount inside the editor's own update.
            queueMicrotask(() => root.unmount())
        },
    }
}
