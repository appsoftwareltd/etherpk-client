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

import { mapSizeOf } from '#lib/document/map-text.js'
import type {
    InteractiveFence,
    InteractiveFenceContext,
    InteractiveFenceInfo,
} from '#lib/document/view/augmentations/interactive-fence-contract.js'

import type { MapBlockServices } from './map-block-services'
import { followNarrowScreen, mapHeight, narrowScreen } from './map-size'

/** A folded Map Block's height, in CSS pixels. */
export const MAP_HEIGHT_FOLDED = 44

type MapBlockProps = {
    context: InteractiveFenceContext
    services: MapBlockServices
    /** Show the map at this height while its handle is dragged, or at its own height again for null. */
    previewHeight(height: number | null): void
}

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

/** Whether a map's widget has anything to draw differently, the editor having drawn it again. */
function sameMap(a: InteractiveFenceContext, b: InteractiveFenceContext): boolean {
    return (
        a.document === b.document &&
        a.ordinal === b.ordinal &&
        a.writable === b.writable &&
        a.dark === b.dark &&
        a.onScreen === b.onScreen &&
        a.body.length === b.body.length &&
        a.body.every((line, i) => line === b.body[i])
    )
}

export function createMapFence(services: MapBlockServices): InteractiveFence {
    /**
     * The height of each map whose handle is being dragged, by where it is drawn. The editor reads it
     * through `height`, so a drag changes a map's room as folding does, through a redraw, and the
     * height map follows it whatever else happens during the drag (ADR 0022).
     */
    const dragged = new Map<string, number>()
    const height = (info: InteractiveFenceInfo): number => {
        const drag = info.instance === undefined ? undefined : dragged.get(info.instance)
        if (drag !== undefined) return drag
        if (services.memory.folded(info)) return MAP_HEIGHT_FOLDED
        return mapHeight(mapSizeOf(info.body), narrowScreen())
    }
    return {
        height,

        mount(host: HTMLElement, context: InteractiveFenceContext) {
            const previewHeight = (preview: number | null) => {
                const { instance } = props.context
                if (instance === undefined) return
                if (preview === null) dragged.delete(instance)
                else dragged.set(instance, preview)
                props.context.resized()
            }
            const props: MapBlockProps = $state({ context, services, previewHeight })
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
                        retry.className = 'gk-button'
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
            const stopFollowing = followNarrowScreen(() => props.context.resized())

            return {
                update(next: InteractiveFenceContext) {
                    // A drag redraws the map on every move with nothing changed but its room, which
                    // need not read its places again or redraw its pins.
                    if (!sameMap(props.context, next)) props.context = next
                },
                destroy() {
                    destroyed = true
                    stopFollowing()
                    if (component) void unmount(component)
                    waiting.remove()
                },
            }
        },
    }
}
