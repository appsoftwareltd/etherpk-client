/**
 * Augmentation: a **pointer cursor over every clickable link** — wikilinks, external
 * markdown links and asset links alike — that reverts to the text caret while the mod key
 * (Ctrl / ⌘) is held.
 *
 * It mirrors the click contract those three augmentations share: a plain click follows the
 * link, and holding the mod key suppresses that so the click places the caret instead. The
 * cursor has to say which of the two a click would do, or the modifier is invisible until
 * the user tries it.
 *
 * The mod key's state is not something CSS can see, so it is tracked here and reflected as
 * `.cm-mod-held` on each editor's root element. One set of window listeners serves every
 * mounted editor: the key can be pressed while the focus is in any of them, or in none.
 */

import { type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

/** Every decoration that a plain click acts on. Keep in step with the three click handlers. */
const LINK_SELECTORS = ['.cm-wikilink', '.cm-md-link', '.cm-asset-link']

const HELD_CLASS = 'cm-mod-held'

const views = new Set<EditorView>()
let held = false
let detachListeners: (() => void) | undefined

function setHeld(next: boolean): void {
    if (next === held) return
    held = next
    for (const view of views) view.dom.classList.toggle(HELD_CLASS, held)
}

/**
 * Track the mod key globally. `keydown`/`keyup` carry the *resulting* modifier state, so
 * reading `ctrlKey`/`metaKey` off any key event covers presses and releases of either key
 * without tracking them individually. Blur and tab-switches clear it: a key released while
 * the window is in the background never reports its `keyup` here, which would otherwise
 * leave every link stuck on the caret cursor.
 */
function attachListeners(): void {
    if (detachListeners || typeof window === 'undefined') return
    const onKey = (event: KeyboardEvent) => setHeld(event.ctrlKey || event.metaKey)
    const clear = () => setHeld(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    detachListeners = () => {
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('keyup', onKey, true)
        window.removeEventListener('blur', clear)
        document.removeEventListener('visibilitychange', clear)
        detachListeners = undefined
    }
}

export function linkCursorAugmentation(): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            constructor(readonly view: EditorView) {
                attachListeners()
                views.add(view)
                view.dom.classList.toggle(HELD_CLASS, held)
            }
            destroy() {
                views.delete(this.view)
                this.view.dom.classList.remove(HELD_CLASS)
                if (views.size === 0) detachListeners?.()
            }
        },
    )

    // A pointer entering the editor with the key already down (held while the window was
    // in the background, or pressed over another surface) reports it on the first move.
    const pointerSync = EditorView.domEventHandlers({
        mousemove(event) {
            setHeld(event.ctrlKey || event.metaKey)
            return false
        },
    })

    const theme = EditorView.baseTheme({
        [LINK_SELECTORS.join(', ')]: { cursor: 'pointer' },
        [LINK_SELECTORS.map((s) => `&.${HELD_CLASS} ${s}`).join(', ')]: { cursor: 'text' },
    })

    return [plugin, pointerSync, theme]
}
