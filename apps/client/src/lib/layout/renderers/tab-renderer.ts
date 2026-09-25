/**
 * The tab renderer, which is dockview's default one plus a kind icon and two indicators: a pin
 * and a mark.
 *
 * A tab strip is exactly where someone scans to answer "what have I left open", and two facts
 * about a tab are not visible from its title. A **pinned** tab is one you have chosen to keep -
 * at the front of its [[Pane]], out of reach of the bulk-close rows - and the pin at its leading
 * edge says so. The mark before the close button says what the document IS: a
 * [[Protected Document]]'s tab wears a padlock, closed when locked and open when readable; a
 * document a [[Publication]] names as an include wears a globe, since its text is on a website.
 * One slot for both, because the two exclude each other: a protected document is never
 * published, and protecting a public one withdraws it first. The icon before the title is the
 * View kind's own (`ViewRegistryEntry.icon`) - the Graph Sidebar's tab wears the graph glyph
 * ahead of the graph's name - and, unlike the indicators, never changes while the tab lives.
 *
 * **A capped title.** The title is drawn about `titleCharsFor` characters wide (the View
 * registry's `tabTitleChars`) and ellipsised past that, so one long document name cannot push
 * every other tab off the strip. The cap is CSS (`--gk-tab-title-width`, compass-theme.css), not
 * a cut in the string: the whole title stays the tab's text, for its accessible name, and a
 * clipped one shows in full as a tooltip.
 *
 * **Indicators, not controls.** Clicking a tab focuses it — that is what a tab is for — and a
 * second action inside one is a mis-click away from either losing your place or throwing away a
 * key you were using. Pinning has its home in the tab's [[Context Menu]]; locking has two: the
 * inline marker on the block itself, and the Command Menu.
 *
 * Written out rather than subclassing `DefaultTab` because that class is not exported from
 * `dockview-core`. The parts reproduced here are the whole of it: a title element, a close action,
 * and a title-change subscription. Drag, drop and activation are handled by dockview's own `Tab`
 * wrapper around this renderer, not by it.
 */
import type { GroupPanelPartInitParameters, ITabRenderer } from 'dockview-core'

import { iconSvg } from '$lib/surface/icons'

/** The mark a tab wears, if any: which glyph, and the title that explains it on hover. */
export interface TabMark {
    state: 'locked' | 'unlocked' | 'include'
    title: string
}

export interface TabRendererOptions {
    /** The mark for the document behind `panelId`, re-read on every render; null for none. */
    markFor: (panelId: string) => TabMark | null
    /** Whether the View behind `panelId` is pinned, re-read on every render. */
    pinnedFor: (panelId: string) => boolean
    /** The icon name the View kind behind `panelId` registered, or undefined for none. */
    iconFor: (panelId: string) => string | undefined
    /** How many characters wide the title behind `panelId` may be drawn before its ellipsis. */
    titleCharsFor: (panelId: string) => number
}

/**
 * The average advance of a character of title text, in em of the tab's font (Inter).
 *
 * Not `1ch`: that is the width of "0", and Inter's digits are wider than its average letter, so
 * a 30ch cap showed about 40 characters of an ordinary title. Half an em is the measured average
 * of mixed-case words and spaces (0.49em for a 68-character title at 13px), so a cap of N
 * characters shows about N. Capitals and wide letters show fewer, narrow ones more.
 */
const AVERAGE_CHAR_EM = 0.5

/**
 * The width a tab title of `chars` characters is capped at, as a CSS length. Shared with the
 * mobile strip so the two presenters cap a title identically.
 */
export function tabTitleWidth(chars: number): string {
    return `${chars * AVERAGE_CHAR_EM}em`
}

/** The glyph for each mark state; shared with the mobile strip so the two never drift. */
export function markIcon(state: TabMark['state']): 'lock' | 'lock-open' | 'globe' {
    return state === 'locked' ? 'lock' : state === 'unlocked' ? 'lock-open' : 'globe'
}

/**
 * Every live tab's render callback.
 *
 * Neither locking nor pinning is a dockview event, so nothing would repaint the indicators on
 * their own — and the one thing worse than no indicator is one that says unlocked after you
 * locked. There is a single dockview per app, so a module-level set is the whole of the
 * bookkeeping needed.
 */
const liveTabs = new Set<() => void>()

/** Repaint every tab's indicators. Called when a lock state or a pin changes. */
export function refreshTabIndicators(): void {
    for (const render of liveTabs) render()
}

/**
 * Dockview's own close cross, reproduced.
 *
 * `createCloseButton` is internal to `dockview-core` and not exported, and this renderer replaces
 * the default tab for **every** panel in the app — so drawing our own cross here would silently
 * restyle every close button as a side-effect of adding a padlock. The `dv-svg` class carries
 * dockview's `fill: currentcolor; stroke-width: 0` from its stylesheet.
 */
function closeButton(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttributeNS(null, 'height', '11')
    svg.setAttributeNS(null, 'width', '11')
    svg.setAttributeNS(null, 'viewBox', '0 0 28 28')
    svg.setAttributeNS(null, 'aria-hidden', 'false')
    svg.setAttributeNS(null, 'focusable', 'false')
    svg.classList.add('dv-svg')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttributeNS(
        null,
        'd',
        'M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z',
    )
    svg.appendChild(path)
    return svg
}

export function createTabRenderer(options: TabRendererOptions): ITabRenderer {
    const element = document.createElement('div')
    element.className = 'dv-default-tab'

    // Before the title: pinned tabs lead the strip, and the mark that says why leads the tab.
    const pin = document.createElement('span')
    pin.className = 'gk-tab-pin'
    pin.setAttribute('aria-hidden', 'true')

    // The kind's icon, between the pin and the title. Decorative: the title says what the tab is.
    const icon = document.createElement('span')
    icon.className = 'gk-tab-icon'
    icon.setAttribute('aria-hidden', 'true')

    const content = document.createElement('div')
    content.className = 'dv-default-tab-content'

    // Between the title and the close button, so the close affordance stays where the muscle
    // memory expects it — the rightmost thing on the tab.
    const mark = document.createElement('span')
    mark.className = 'gk-tab-mark'
    mark.setAttribute('aria-hidden', 'true')

    const action = document.createElement('div')
    action.className = 'dv-default-tab-action'
    action.append(closeButton())

    element.append(pin, icon, content, mark, action)

    let title: string | undefined
    let panelId = ''
    const disposers: (() => void)[] = []

    function renderPin(): void {
        const pinned = panelId ? options.pinnedFor(panelId) : false
        // `data-pinned` is what the overflow dropdown and the e2e specs read; the glyph is for eyes.
        if (element.dataset.pinned === String(pinned)) return
        element.dataset.pinned = String(pinned)
        if (pinned) {
            pin.innerHTML = iconSvg('pin', { size: 12 })
            pin.title = 'Pinned'
        } else {
            pin.replaceChildren()
            pin.removeAttribute('title')
        }
    }

    function renderMark(): void {
        const next = panelId ? options.markFor(panelId) : null
        if (next === null) {
            mark.replaceChildren()
            mark.removeAttribute('title')
            mark.dataset.state = ''
            return
        }
        if (mark.dataset.state !== next.state) mark.innerHTML = iconSvg(markIcon(next.state), { size: 13 })
        mark.dataset.state = next.state
        // A title, not an aria-label: the icon is decorative to a screen reader, which gets the
        // same information from the document itself.
        mark.title = next.title
    }

    function renderIcon(): void {
        const name = panelId ? options.iconFor(panelId) : undefined
        if (icon.dataset.icon === (name ?? '')) return
        icon.dataset.icon = name ?? ''
        if (name) icon.innerHTML = iconSvg(name, { size: 13 })
        else icon.replaceChildren()
    }

    function render(): void {
        if (content.textContent !== title) content.textContent = title ?? ''
        renderPin()
        renderIcon()
        renderMark()
    }

    return {
        element,
        init(params: GroupPanelPartInitParameters) {
            title = params.title
            panelId = params.api.id
            // Per kind, so fixed for the tab's life: set once rather than on every render.
            content.style.setProperty('--gk-tab-title-width', tabTitleWidth(options.titleCharsFor(panelId)))
            const titleChange = params.api.onDidTitleChange((event: { title: string }) => {
                title = event.title
                render()
            })
            disposers.push(() => titleChange.dispose())

            // preventDefault on pointerdown so pressing the close button never starts a tab drag.
            const onPointerDown = (event: Event) => event.preventDefault()
            const onClick = (event: MouseEvent) => {
                if (event.defaultPrevented) return
                event.preventDefault()
                params.api.close()
            }
            action.addEventListener('pointerdown', onPointerDown)
            action.addEventListener('click', onClick)
            disposers.push(() => action.removeEventListener('pointerdown', onPointerDown))
            disposers.push(() => action.removeEventListener('click', onClick))

            // A clipped title shows in full on hover. Decided as the pointer arrives, because
            // only layout knows whether this title in this font overflows its cap, and a title
            // that fits wants no tooltip repeating it.
            const onPointerEnter = () => {
                if (content.scrollWidth > content.clientWidth) content.title = title ?? ''
                else content.removeAttribute('title')
            }
            content.addEventListener('pointerenter', onPointerEnter)
            disposers.push(() => content.removeEventListener('pointerenter', onPointerEnter))

            liveTabs.add(render)
            disposers.push(() => liveTabs.delete(render))
            render()
        },
        update() {
            render()
        },
        dispose() {
            for (const dispose of disposers) dispose()
            disposers.length = 0
        },
    } as ITabRenderer
}
