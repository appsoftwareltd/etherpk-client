/**
 * The **editor frame** (`frame: 'editor'` on a fence registration, Proposed): the toolbar and menu
 * the Client draws round a fence that is a picture until it is edited in the document, such as a
 * drawing, so every such fence looks and behaves the same whichever extension draws it.
 *
 * - **Over the picture**, where the document can be written, a "…" menu offers Edit as text and
 *   Delete. It shows while the pointer is over the fence or the keyboard is in it, and always on a
 *   screen with no hover.
 * - **While the fence is edited** (the widget calls `setEditing(true)`, as when its picture is
 *   pressed), a toolbar above it offers Done, Full window, Open in tab, and apart from those Edit as
 *   text and Delete. Each first has the widget write what it holds (`flush`), so Edit as text shows,
 *   and Mod+Z after Delete brings back, what was drawn.
 * - **One fence is edited at a time** (`frameEditing`), and a press outside it, other than on a
 *   dialog of its own (`owns`), stops editing it.
 * - **In a tab or a window** the frame draws nothing: the widget fills the space, and the Client's
 *   window has its own Return.
 *
 * The frame mounts in the page, outside any shadow root the widget mounts in, so its controls are the
 * Client's own (`gk-button`, `gk-menu`, ADR 0151). The rules are in `fence-frame-core.ts`.
 */
import type { InteractiveFence, InteractiveFenceContext, InteractiveFenceView } from '#lib/document/view/augmentations/interactive-fence-contract.js'

import { deletedNotice, FRAME_ACTION_LABELS, FRAME_TOOLBAR_HEIGHT, type FrameAction, frameActions, frameEditing, frameKey } from './fence-frame-core'
import './fence-frame.css'

/** What the frame reads of a fence to know which one it is. */
type FramedInfo = { document: string | null; body: readonly string[]; instance?: string }

/** Numbers for the ids that tie a menu to its button. */
let menus = 0

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

function actionButton(action: FrameAction, onClick: () => void): HTMLButtonElement {
    const node = element('button', action === 'delete' ? 'gk-button gk-button--danger' : 'gk-button', FRAME_ACTION_LABELS[action])
    node.type = 'button'
    node.dataset.testid = `fence-frame-${action}`
    node.addEventListener('click', onClick)
    return node
}

/** Three dots in a row, for the menu's button. */
function moreIcon(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'gk-fence-frame-menu-icon')
    for (const cx of [3.5, 8, 12.5]) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        dot.setAttribute('cx', String(cx))
        dot.setAttribute('cy', '8')
        dot.setAttribute('r', '1.5')
        svg.append(dot)
    }
    return svg
}

interface FrameMenu {
    root: HTMLElement
    close(): void
    contains(node: Node): boolean
}

/**
 * A menu button and its menu, with the keyboard a menu has: the arrows, Home and End move between the
 * items, Escape closes it and gives the button back the focus, Tab closes it. Delete is drawn in the
 * danger colour, as the toolbar's is.
 */
function actionMenu(label: string, actions: readonly FrameAction[], run: (action: FrameAction) => void): FrameMenu {
    const root = element('div', 'gk-fence-frame-menu')
    const trigger = element('button', 'gk-icon-button gk-button--raised gk-fence-frame-menu-button')
    trigger.type = 'button'
    trigger.dataset.testid = 'fence-frame-menu'
    trigger.setAttribute('aria-label', label)
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.append(moreIcon())
    const list = element('div', 'gk-menu gk-fence-frame-menu-list')
    list.id = `gk-fence-frame-menu-${++menus}`
    list.setAttribute('role', 'menu')
    list.setAttribute('aria-label', label)
    list.hidden = true
    trigger.setAttribute('aria-controls', list.id)
    const entries = actions.map((action) => {
        const entry = element('button', action === 'delete' ? 'gk-menu-item gk-menu-item--danger' : 'gk-menu-item', FRAME_ACTION_LABELS[action])
        entry.type = 'button'
        entry.dataset.testid = `fence-frame-menu-${action}`
        entry.setAttribute('role', 'menuitem')
        entry.tabIndex = -1
        entry.addEventListener('click', () => {
            close(false)
            run(action)
        })
        return entry
    })
    list.append(...entries)
    root.append(trigger, list)

    const open = (focusAt: number) => {
        list.hidden = false
        trigger.setAttribute('aria-expanded', 'true')
        entries[(focusAt + entries.length) % entries.length]?.focus()
    }
    function close(restoreFocus: boolean) {
        if (list.hidden) return
        list.hidden = true
        trigger.setAttribute('aria-expanded', 'false')
        if (restoreFocus) trigger.focus()
    }
    trigger.addEventListener('click', () => (list.hidden ? open(0) : close(true)))
    trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        open(event.key === 'ArrowDown' ? 0 : -1)
    })
    list.addEventListener('keydown', (event) => {
        const at = entries.indexOf(document.activeElement as HTMLButtonElement)
        const step: Record<string, number> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: entries.length - 1 }
        if (event.key in step) {
            event.preventDefault()
            entries[(step[event.key] + entries.length) % entries.length].focus()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
        } else if (event.key === 'Tab') {
            close(false)
        }
    })
    return { root, close: () => close(false), contains: (node) => root.contains(node) }
}

/** The fence's own id, or null when it has none or `identify` throws. */
function idOf(fence: InteractiveFence, body: readonly string[]): string | null {
    try {
        return fence.identify?.(body) ?? null
    } catch {
        return null
    }
}

/**
 * `inner` drawn in the editor frame. `notify` tells the person what the page does not show: how to
 * bring back a fence Delete took out.
 */
export function framedFence(inner: InteractiveFence, notify: (text: string) => void): InteractiveFence {
    // Where the editor draws the fence (`fenceInstance`), so the same document open twice edits the
    // drawing only where it was pressed. A host that cannot say falls back to the document and id.
    const keyOf = (info: FramedInfo) => info.instance ?? frameKey(info.document, idOf(inner, info.body))
    return {
        ...inner,
        height(info) {
            const key = keyOf(info)
            const editing = key !== null && frameEditing.isEditing(key)
            return inner.height({ ...info, editing }) + (editing ? FRAME_TOOLBAR_HEIGHT : 0)
        },
        mount(host, initial) {
            if (initial.presentation !== 'inline') return inner.mount(host, { ...initial, editing: false, setEditing: () => {} })
            return mountFramed(inner, host, initial, keyOf, notify)
        },
    }
}

function mountFramed(
    inner: InteractiveFence,
    host: HTMLElement,
    initial: InteractiveFenceContext,
    keyOf: (info: FramedInfo) => string | null,
    notify: (text: string) => void,
): InteractiveFenceView {
    let context = initial
    let key = keyOf(context)
    let menu: FrameMenu | null = null
    let view: InteractiveFenceView | null = null
    /** Whether this widget was last drawn edited, so a change from elsewhere is told once. */
    let shownEditing = false
    const root = element('div', 'gk-fence-frame')
    const toolbar = element('div', 'gk-fence-frame-toolbar')
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', `${inner.title ?? 'Block'} actions`)
    const body = element('div', 'gk-fence-frame-body')
    root.append(toolbar, body)
    host.append(root)

    const editing = () => key !== null && frameEditing.isEditing(key)

    /** Write what the widget holds, then stop editing: the registry calls it when another fence starts. */
    const stop = () => {
        try {
            view?.flush?.()
        } catch (error) {
            console.error('[extensions] a framed widget could not write what it held', error)
        }
        if (key !== null) frameEditing.end(key)
    }

    const setEditing = (on: boolean) => {
        if (key === null) return
        if (!on) {
            if (editing()) stop()
            return
        }
        if (!context.writable || editing()) return
        frameEditing.start(key, stop)
    }

    const innerContext = (): InteractiveFenceContext => ({ ...context, editing: editing(), setEditing })

    /** Write what the widget holds, and leave editing, before an action that needs the fence's text as drawn. */
    const settle = () => (editing() ? stop() : view?.flush?.())

    const run = (action: FrameAction) => {
        switch (action) {
            case 'done':
                stop()
                // Back on the picture, which is what the person goes on from.
                body.querySelector<HTMLElement>('button, [tabindex="0"]')?.focus()
                return
            case 'full-window':
                settle()
                context.openWindow()
                return
            case 'open-tab':
                settle()
                context.openInTab()
                return
            case 'edit-as-text':
                settle()
                context.editAsText()
                return
            case 'delete':
                settle()
                if (context.remove()) notify(deletedNotice(inner.title))
        }
    }

    /** The toolbar or the menu, as the fence's state now asks. */
    const drawChrome = () => {
        const now = editing()
        const actions = frameActions({ presentation: 'inline', writable: context.writable, editing: now, identified: idOf(inner, context.body) !== null })
        root.dataset.editing = String(now)
        toolbar.replaceChildren()
        toolbar.hidden = actions.toolbar.length === 0
        if (actions.toolbar.length > 0) {
            const apart = element('div', 'gk-fence-frame-toolbar-apart')
            apart.append(...actions.apart.map((action) => actionButton(action, () => run(action))))
            toolbar.append(...actions.toolbar.map((action) => actionButton(action, () => run(action))), apart)
        }
        menu?.root.remove()
        menu = actions.menu.length > 0 ? actionMenu(`${inner.title ?? 'Block'} actions`, actions.menu, run) : null
        if (menu) root.append(menu.root)
    }

    /** Editing started or stopped, here or elsewhere: draw the frame and the widget again, at its new height. */
    const followEditing = () => {
        const now = editing()
        if (now === shownEditing) return
        shownEditing = now
        drawChrome()
        view?.update(innerContext())
        context.resized()
    }
    const unsubscribe = frameEditing.subscribe(followEditing)

    // A press outside the frame closes its menu, and stops editing unless it is on the widget's own
    // dialog in the page's body.
    const outside = (event: PointerEvent) => {
        const path = event.composedPath()
        const within = (node: EventTarget) => node instanceof Node && root.contains(node)
        if (menu && !path.some((node) => node instanceof Node && menu?.contains(node))) menu.close()
        if (!editing() || path.some(within)) return
        if (path.some((node) => node instanceof Node && view?.owns?.(node))) return
        stop()
    }
    document.addEventListener('pointerdown', outside, true)

    shownEditing = editing()
    // Drawn again while edited (scrolled back into view, or the editor rebuilt): this widget now
    // writes what it holds when editing stops.
    if (shownEditing && key !== null) frameEditing.start(key, stop)
    drawChrome()
    const mountedWith = innerContext()
    view = inner.mount(body, mountedWith)
    // A widget that starts editing as it mounts (`takeFocus`, as for a fence just put in) is told
    // now: the change it caused reached no widget, since there was none yet.
    if (mountedWith.editing !== editing()) view.update(innerContext())

    return {
        update(next) {
            context = next
            const before = key
            key = keyOf(next)
            // The document can no longer be written: back to the picture, saved.
            if (before !== null && frameEditing.isEditing(before) && (!next.writable || before !== key)) {
                try {
                    view?.flush?.()
                } finally {
                    frameEditing.end(before)
                }
            }
            shownEditing = editing()
            drawChrome()
            view?.update(innerContext())
        },
        destroy() {
            unsubscribe()
            document.removeEventListener('pointerdown', outside, true)
            // Still edited when drawn again; until then, starting another fence only ends this one.
            if (editing() && key !== null) {
                const ended = key
                try {
                    view?.flush?.()
                } catch (error) {
                    console.error('[extensions] a framed widget could not write what it held', error)
                }
                frameEditing.start(ended, () => frameEditing.end(ended))
            }
            view?.destroy()
            view = null
            root.remove()
        },
    }
}
