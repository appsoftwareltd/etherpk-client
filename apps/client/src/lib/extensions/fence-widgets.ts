/**
 * An extension's fence widget (`context.editor.registerFence`) as the editor's interactive fence
 * host takes it (`interactive-fence-contract.ts`).
 *
 * Two things are added on the way:
 *
 * - **Where it mounts.** A loaded extension's widget mounts in a shadow root holding the extension's
 *   stylesheets, as its Views do (ADR 0121, amended 2026-10-10), so neither side's CSS reaches the
 *   other. One that mounts in the page (`"isolation": "page"`) and a compiled-in one share the page.
 * - **Guards.** The editor builds widgets inside its own update, where an error would refuse every
 *   transaction, so a widget that throws as it mounts shows a short note in its place instead, and
 *   one that throws later is logged. Its other callbacks (`identify`, `fromPaste`) are guarded where
 *   the editor calls them.
 * - **The editor frame**, for a registration with `frame: 'editor'` (`fence-frame.ts`): drawn in the
 *   page round wherever the widget mounts.
 */
import type { FenceOptions, FenceWidget, MountedFence } from '@appsoftwareltd/etherpk-extension-api'

import type { InteractiveFence, InteractiveFenceContext, InteractiveFenceView } from '#lib/document/view/augmentations/interactive-fence-contract.js'

import { framedFence } from './fence-frame'
import { clientShadowSheets, extensionStyleSheets } from './styles'

/** How an extension's widgets mount: in a shadow root holding these stylesheets, or in the page (null). */
export type FenceIsolation = { styles: readonly string[] } | null

/** What the Client gives a fence registration beyond the widget itself. */
export interface FenceServices {
    /**
     * Hears when the extension's own settings change, which can change what its `quote` answers (a
     * video's thumbnail), so a quote kept from before is asked for again.
     */
    settingsChanged?: (listener: () => void) => () => void
    /** Tell the person what the page does not show, such as how to undo the editor frame's Delete. */
    notify?: (text: string) => void
}

export function toInteractiveFence(extensionName: string, widget: FenceWidget, options: FenceOptions, isolation: FenceIsolation, services: FenceServices = {}): InteractiveFence {
    const fence = adaptedFence(extensionName, widget, options, isolation, services.settingsChanged)
    return options.frame === 'editor' ? framedFence(fence, services.notify ?? (() => {})) : fence
}

function adaptedFence(extensionName: string, widget: FenceWidget, options: FenceOptions, isolation: FenceIsolation, settingsChanged: FenceServices['settingsChanged']): InteractiveFence {
    return {
        height: (info) => widget.height(info),
        mount: (host, context) => (isolation ? mountInShadow(extensionName, widget, host, context, isolation.styles) : mountGuarded(extensionName, widget, host, context)),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.keepsHistory ? { keepsHistory: true } : {}),
        ...(options.identify ? { identify: options.identify.bind(options) } : {}),
        ...(options.fromPaste ? { fromPaste: options.fromPaste.bind(options) } : {}),
        ...(options.publish ? { publish: options.publish.bind(options) } : {}),
        ...(options.quote ? { quote: options.quote.bind(options), ...(settingsChanged ? { quotesChanged: settingsChanged } : {}) } : {}),
    }
}

/** A note in the widget's place when it could not draw. */
function failedNote(host: HTMLElement | ShadowRoot, extensionName: string): void {
    const note = document.createElement('p')
    note.className = 'gk-extension-fence-failed'
    note.setAttribute('role', 'alert')
    note.setAttribute('data-testid', 'extension-fence-failed')
    note.style.cssText = 'margin:0;padding:0.75rem;font-size:0.875rem;color:var(--gk-text-muted)'
    note.textContent = `${extensionName} couldn't draw this. Its text is still in the document.`
    host.append(note)
}

function guardedView(extensionName: string, mounted: MountedFence): InteractiveFenceView {
    return {
        flush() {
            try {
                mounted.flush?.()
            } catch (error) {
                console.error(`[extensions] ${extensionName}: a fence widget's flush threw`, error)
            }
        },
        owns(node) {
            try {
                return mounted.owns?.(node) ?? false
            } catch {
                return false
            }
        },
        update(context) {
            try {
                mounted.update(context)
            } catch (error) {
                console.error(`[extensions] ${extensionName}: a fence widget's update threw`, error)
            }
        },
        destroy() {
            try {
                mounted.destroy()
            } catch (error) {
                console.error(`[extensions] ${extensionName}: a fence widget's destroy threw`, error)
            }
        },
    }
}

const nothing: InteractiveFenceView = { update: () => {}, destroy: () => {} }

function mountGuarded(extensionName: string, widget: FenceWidget, host: HTMLElement, context: InteractiveFenceContext): InteractiveFenceView {
    try {
        return guardedView(extensionName, widget.mount(host, context))
    } catch (error) {
        console.error(`[extensions] ${extensionName}: a fence widget's mount threw`, error)
        failedNote(host, extensionName)
        return nothing
    }
}

/**
 * Mount in a shadow root once the extension's stylesheets are there, so the widget never draws
 * unstyled. Until then the host holds its reserved height, and changes are kept for the mount.
 */
function mountInShadow(extensionName: string, widget: FenceWidget, host: HTMLElement, context: InteractiveFenceContext, styles: readonly string[]): InteractiveFenceView {
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    let latest = context
    let view: InteractiveFenceView | null = null
    let destroyed = false
    extensionStyleSheets(styles).then(
        (own) => {
            if (destroyed) return
            shadow.adoptedStyleSheets = [...clientShadowSheets(), ...own]
            const root = document.createElement('div')
            root.className = 'extension-fence'
            shadow.append(root)
            view = mountGuarded(extensionName, widget, root, latest)
        },
        (error: unknown) => {
            if (destroyed) return
            console.error(`[extensions] ${extensionName}: its stylesheets would not load`, error)
            failedNote(shadow, extensionName)
        },
    )
    return {
        update(next) {
            latest = next
            view?.update(next)
        },
        flush: () => view?.flush?.(),
        owns: (node) => view?.owns?.(node) ?? false,
        destroy() {
            destroyed = true
            view?.destroy()
            shadow.replaceChildren()
        },
    }
}
