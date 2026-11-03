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
 *
 * Excalidraw's features that reach other services are off: links to its site and social pages,
 * library publishing, web embeds and AI. Its image tool is off too, since a picture inside a drawing
 * would be written into every save of it.
 */
import type { FenceContext } from '@appsoftwareltd/etherpk-extension-api'

import { applyEdits, type DrawingHeader, type ElementRecord, mergeDrawing, newDrawingId, planWrite, readDrawing, sameBody } from './format'
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

export function mountLiveEditor(kit: ExcalidrawKit, element: HTMLElement, initial: FenceContext, options: { autoFocus: boolean }): LiveEditor {
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
    }
    let api: Api | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    /** A version stamp of what is on screen when it was last written, so an unchanged scene is not compared line by line. */
    let writtenStamp = ''
    let destroyed = false
    /** A change from elsewhere arrived while something was in hand: merged once the edit ends. */
    let waiting = false

    const stampOf = (elements: readonly unknown[], background: string) => `${background}:${(elements as { id: string; version: number }[]).map((e) => `${e.id}.${e.version}`).join(',')}`

    /** Whether Excalidraw is typing text or drawing a shape, which it alone may change until it ends. */
    function inHand(): boolean {
        const state = api?.getAppState()
        return Boolean(state?.editingTextElement || state?.newElement)
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
        const next = { header: { ...header, background }, elements }
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
                    },
                    // Light in either of the app's themes: Excalidraw's dark theme inverts the canvas
                    // as it draws, so the colours on screen would not be the colours the drawing holds.
                    theme: 'light',
                    viewModeEnabled: !context.writable,
                    autoFocus: options.autoFocus,
                    handleKeyboardGlobally: false,
                    onChange: () => {
                        if (waiting && !inHand()) {
                            waiting = false
                            mergeFromDocument()
                        }
                        schedule()
                    },
                    // A stroke ended: written at once, so a closed tab never loses it.
                    onPointerUp: () => queueMicrotask(() => flush()),
                    UIOptions: {
                        canvasActions: { loadScene: false, saveToActiveFile: false, saveAsImage: false, export: false, toggleTheme: false, changeViewBackgroundColor: true, clearCanvas: true },
                        tools: { image: false },
                    },
                    validateEmbeddable: false,
                    aiEnabled: false,
                    // Library browsing returns here: the Client's origin, never a page's address, which holds the graph's id.
                    libraryReturnUrl: `${location.origin}/`,
                } as never,
                // Its menu with what works offline only: no links to its site, no social pages.
                createElement(MainMenu, null, createElement(MainMenu.DefaultItems.ChangeCanvasBackground), createElement(MainMenu.DefaultItems.ClearCanvas)),
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
        // Whatever is newer here is written on the next save.
        writtenStamp = ''
        schedule()
    }

    return {
        update(next) {
            const writableChanged = next.writable !== context.writable
            context = next
            if (writableChanged) render()
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
            destroyed = true
            if (timer) clearTimeout(timer)
            // Unmounted after the widget's element left: React must not unmount inside the editor's own update.
            queueMicrotask(() => root.unmount())
        },
    }
}
