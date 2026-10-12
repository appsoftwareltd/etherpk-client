/**
 * What an [[Extension Fence]] shows where no extension draws it (ADR 0138): the extension is not
 * installed on this device, is switched off, or failed to start. The fence holds that extension's
 * data, such as a drawing's elements, which reads as noise and is easy to break by hand, so the
 * document shows a small note naming the extension in its place, with **Show text** for anyone who
 * needs the text itself (Edit as text, which the caret alone never does for an Extension Fence).
 *
 * The note is drawn by the interactive fence host like any widget, so the caret passes over it as it
 * does over the extension's own widget, and the fence's text is never in sight by accident.
 */
import type { InteractiveFence, InteractiveFenceContext } from './interactive-fence-contract'

/** The note's height: one line of text and a button, inside the block's own padding. */
export const EXTENSION_FENCE_PLACEHOLDER_HEIGHT = 48

/** One placeholder per info word, so the widget a redraw compares is the same object each time. */
const placeholders = new Map<string, InteractiveFence>()

export function extensionFencePlaceholder(info: string): InteractiveFence {
    let fence = placeholders.get(info)
    if (!fence) {
        fence = createPlaceholder(info)
        placeholders.set(info, fence)
    }
    return fence
}

function createPlaceholder(info: string): InteractiveFence {
    const extension = info.slice(0, info.indexOf('.'))
    return {
        height: () => EXTENSION_FENCE_PLACEHOLDER_HEIGHT,
        mount(host: HTMLElement, context: InteractiveFenceContext) {
            let current = context
            const note = host.appendChild(document.createElement('div'))
            note.className = 'gk-extension-fence-placeholder'
            note.setAttribute('data-testid', 'extension-fence-placeholder')
            note.setAttribute('data-extension', extension)
            const text = note.appendChild(document.createElement('p'))
            const name = document.createElement('code')
            name.textContent = extension
            text.append('Content from the ', name, " extension, which isn't running here.")
            const show = note.appendChild(document.createElement('button'))
            show.type = 'button'
            show.className = 'gk-extension-fence-placeholder-show'
            show.textContent = 'Show text'
            show.setAttribute('data-testid', 'extension-fence-show-text')
            show.addEventListener('click', () => current.editAsText())
            return {
                update(next: InteractiveFenceContext) {
                    current = next
                },
                destroy() {
                    note.remove()
                },
            }
        },
    }
}
