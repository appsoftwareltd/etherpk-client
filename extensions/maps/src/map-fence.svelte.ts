/**
 * The interactive fence the maps extension registers for `map` (ADR 0118): how tall a Map Block
 * is, and how its widget is mounted.
 *
 * The widget's code, MapLibre with it, loads the first time a Map Block is drawn, so a graph with
 * no maps never downloads it. Until it lands the block shows a quiet placeholder of the same
 * height, so nothing below it moves, and if it cannot load the block says so with a way to try
 * again.
 */
import { type Component, mount, unmount } from 'svelte'

import type {
    InteractiveFence,
    InteractiveFenceContext,
    InteractiveFenceInfo,
} from '$lib/document/view/augmentations/interactive-fence-contract'

import type { MapBlockServices } from './map-block-services'

/** A Map Block's height on a wide screen, a narrow one, and folded, in CSS pixels. */
export const MAP_HEIGHT_WIDE = 380
export const MAP_HEIGHT_NARROW = 320
export const MAP_HEIGHT_FOLDED = 44

const NARROW = '(max-width: 640px)'

function narrow(): boolean {
    return typeof matchMedia === 'function' && matchMedia(NARROW).matches
}

type MapBlockProps = { context: InteractiveFenceContext; services: MapBlockServices }

let widget: Promise<Component<MapBlockProps>> | null = null

/** The widget's module, loaded once and shared by every Map Block; a failed load can be tried again. */
function loadWidget(): Promise<Component<MapBlockProps>> {
    widget ??= import('./MapBlock.svelte').then(
        (module) => module.default as Component<MapBlockProps>,
        (error: unknown) => {
            widget = null
            throw error
        },
    )
    return widget
}

function placeholder(): HTMLElement {
    const element = document.createElement('div')
    element.className = 'gk-map-placeholder'
    element.setAttribute('data-testid', 'map-loading')
    element.setAttribute('aria-busy', 'true')
    const text = element.appendChild(document.createElement('p'))
    text.textContent = 'Loading the map…'
    return element
}

export function createMapFence(services: MapBlockServices): InteractiveFence {
    return {
        height(info: InteractiveFenceInfo): number {
            if (services.memory.folded(info)) return MAP_HEIGHT_FOLDED
            return narrow() ? MAP_HEIGHT_NARROW : MAP_HEIGHT_WIDE
        },

        mount(host: HTMLElement, context: InteractiveFenceContext) {
            const props: MapBlockProps = $state({ context, services })
            let component: ReturnType<typeof mount> | null = null
            let destroyed = false
            const waiting = host.appendChild(placeholder())

            const show = () => {
                waiting.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Loading the map…' }))
                loadWidget().then(
                    (MapBlock) => {
                        if (destroyed) return
                        waiting.remove()
                        component = mount(MapBlock, { target: host, props })
                    },
                    () => {
                        if (destroyed) return
                        const text = Object.assign(document.createElement('p'), {
                            textContent: "The map couldn't load. Check your connection, then try again.",
                        })
                        const retry = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Try again' })
                        retry.className = 'gk-map-button'
                        retry.setAttribute('data-testid', 'map-load-retry')
                        retry.addEventListener('click', show)
                        waiting.removeAttribute('aria-busy')
                        waiting.classList.add('gk-map-placeholder--failed')
                        waiting.replaceChildren(text, retry)
                    },
                )
            }
            show()

            // The height follows the screen: a map that crosses the narrow breakpoint is measured again.
            const query = typeof matchMedia === 'function' ? matchMedia(NARROW) : null
            const remeasure = () => props.context.resized()
            query?.addEventListener('change', remeasure)

            return {
                update(next: InteractiveFenceContext) {
                    props.context = next
                },
                destroy() {
                    destroyed = true
                    query?.removeEventListener('change', remeasure)
                    if (component) void unmount(component)
                    waiting.remove()
                },
            }
        },
    }
}
