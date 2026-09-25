/**
 * A custom horizontal scrollbar for dockview tab strips.
 *
 * dockview keeps the tab list at `overflow-x: hidden` and scrolls it to the
 * active tab (tabs.js scroll-to-active), which clips the leftmost tabs off the
 * left edge. We don't want that: the strip should stay left-anchored and move
 * *only* under explicit user control. So this module:
 *
 *  - Owns each strip's scroll position (`desired`, default 0) and restores it
 *    after dockview's auto-scroll, removing the clipping — *except* that
 *    **activating a tab reveals it** (minimal scroll; stays put if already
 *    visible), so an off-screen tab made active scrolls into view like on mobile.
 *  - Renders a thin scrollbar that appears only when the pointer is within the
 *    top few pixels of an *overflowing* strip — at the very top of the pane, so
 *    it never interferes with the connected-tabs look along the bottom edge.
 *
 * One shared bar element follows whichever strip is hovered.
 */

import type { DockviewApi } from 'dockview-core'

import { iconSvg } from '$lib/surface/icons'

/** How close to a strip's top edge the pointer must be to reveal the scrollbar. */
const HOVER_ZONE_PX = 6
/** Minimum thumb width so it stays grabbable on very wide strips. */
const MIN_THUMB_PX = 28

/** Close a real tab through dockview's own close affordance, so it takes dockview's close path. */
function closeTab(tab: HTMLElement): void {
    const action = tab.querySelector<HTMLElement>('.dv-default-tab-action')
    action?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/**
 * Activate a real tab as though the user had pressed it.
 *
 * Which event that takes depends on the group, and dockview is explicit about it: a **grid**
 * group (the main region) opens the panel on `pointerdown` with button 0, while an **edge**
 * group (a Sidebar) deliberately ignores pointerdown - "all tab interaction for edge groups is
 * handled by onTabClick to avoid race conditions with active panel state" - and acts on
 * `click` instead. Dispatching `mousedown`, which is what this used to do, reaches neither:
 * dockview binds no mousedown listener at all, so the overflow dropdown silently did nothing in
 * the main region.
 *
 * Pointerdown first, then click only if the tab did not become active - so an edge group still
 * works, and a grid group never gets a second event. That matters: on an edge group a click on
 * the ALREADY-ACTIVE tab toggles the Sidebar collapsed, so firing both would activate the tab
 * and then immediately collapse the Sidebar it lives in.
 */
function activateTab(tab: HTMLElement): void {
    const options = { bubbles: true, button: 0, isPrimary: true } as const
    tab.dispatchEvent(
        typeof PointerEvent === 'function'
            ? new PointerEvent('pointerdown', options)
            : new MouseEvent('pointerdown', options),
    )
    if (!tab.classList.contains('dv-active-tab')) {
        tab.dispatchEvent(new MouseEvent('click', options))
    }
}

export function installTabStripScrollbar(api: DockviewApi, container: HTMLElement): () => void {
    // User-intended scroll position per tab list. Default (absent) is 0.
    const desired = new WeakMap<HTMLElement, number>()
    let current: HTMLElement | null = null
    let dragging = false

    const bar = document.createElement('div')
    bar.className = 'dv-compass-tabscroll'
    bar.style.display = 'none'
    const thumb = document.createElement('div')
    thumb.className = 'dv-compass-tabscroll-thumb'
    bar.appendChild(thumb)
    container.appendChild(bar)

    const lists = () => [...container.querySelectorAll<HTMLElement>('.dv-tabs-container')]
    const overflowing = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1
    const desiredOf = (el: HTMLElement) => desired.get(el) ?? 0

    function syncThumb() {
        if (!current) return
        const w = current.clientWidth
        const thumbW = Math.max(MIN_THUMB_PX, (w / current.scrollWidth) * w)
        const maxScroll = current.scrollWidth - w
        const maxThumb = w - thumbW
        const left = maxScroll > 0 ? (current.scrollLeft / maxScroll) * maxThumb : 0
        thumb.style.width = `${thumbW}px`
        thumb.style.transform = `translateX(${left}px)`
    }

    function showBarOver(list: HTMLElement) {
        current = list
        const r = list.getBoundingClientRect()
        const cr = container.getBoundingClientRect()
        bar.style.left = `${r.left - cr.left}px`
        // Sit at the top of the *content* area, just under the tab row — so it
        // never covers the tabs or the connected-tab look along their bottom edge.
        bar.style.top = `${r.bottom - cr.top}px`
        bar.style.width = `${r.width}px`
        bar.style.display = 'block'
        syncThumb()
    }

    function onMouseMove(event: MouseEvent) {
        if (dragging) return
        let hit: HTMLElement | null = null
        for (const list of lists()) {
            if (!overflowing(list)) continue
            const r = list.getBoundingClientRect()
            // Reveal when the pointer is just below the tabs (top of the pane).
            const inRevealZone =
                event.clientX >= r.left &&
                event.clientX <= r.right &&
                event.clientY >= r.bottom - 2 &&
                event.clientY <= r.bottom + HOVER_ZONE_PX
            if (inRevealZone) {
                hit = list
                break
            }
        }
        if (hit) showBarOver(hit)
        else if (!bar.matches(':hover')) bar.style.display = 'none'
    }

    function onThumbPointerDown(event: PointerEvent) {
        if (!current) return
        const list = current
        dragging = true
        thumb.setPointerCapture(event.pointerId)
        const startX = event.clientX
        const startScroll = list.scrollLeft
        const w = list.clientWidth
        const thumbW = thumb.offsetWidth
        const maxScroll = list.scrollWidth - w
        const maxThumb = w - thumbW

        const move = (e: PointerEvent) => {
            const delta = maxThumb > 0 ? ((e.clientX - startX) / maxThumb) * maxScroll : 0
            const next = Math.max(0, Math.min(maxScroll, startScroll + delta))
            list.scrollLeft = next
            desired.set(list, next)
            syncThumb()
        }
        const up = (e: PointerEvent) => {
            dragging = false
            thumb.releasePointerCapture(e.pointerId)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        event.preventDefault()
    }

    // Capture user wheel scrolling into `desired` so it persists across dockview's
    // auto-scroll restores (a wheel event is user-driven; scroll-to-active is not).
    function onWheelCapture(event: WheelEvent) {
        const list = (event.target as HTMLElement | null)?.closest?.('.dv-tabs-container')
        if (list instanceof HTMLElement) {
            requestAnimationFrame(() => desired.set(list, list.scrollLeft))
        }
    }

    function onScrollCapture(event: Event) {
        if (event.target === current) syncThumb()
        updateOverflowCounts()
    }

    // Override dockview's scroll-to-active: after it runs, restore each strip to
    // its user-intended position (default 0 → left-anchored).
    function restoreDesired() {
        if (dragging) return
        requestAnimationFrame(() => {
            for (const list of lists()) {
                const d = desiredOf(list)
                if (list.scrollLeft !== d) list.scrollLeft = d
            }
            if (current) syncThumb()
            updateOverflowCounts()
        })
    }

    // When a tab is *activated* (click, navigation, open), make sure it is visible —
    // minimal scroll only: stay put if it is already on-screen (so left-anchoring is
    // preserved while the active tab is among the visible ones), else scroll just far
    // enough to reveal it. Mirrors the mobile presenter's reveal-active behaviour.
    function revealActiveTab() {
        if (dragging) return
        requestAnimationFrame(() => {
            for (const list of lists()) {
                const active = list.querySelector<HTMLElement>('.dv-tab.dv-active-tab')
                const max = list.scrollWidth - list.clientWidth
                if (max <= 0) {
                    if (list.scrollLeft !== 0) list.scrollLeft = 0
                    desired.set(list, 0)
                    continue
                }
                if (!active) continue
                const left = active.offsetLeft
                const right = left + active.offsetWidth
                let next = list.scrollLeft
                if (left < next) next = left // clipped off the left → show its left edge
                else if (right > next + list.clientWidth) next = right - list.clientWidth // off the right
                next = Math.max(0, Math.min(max, next))
                if (next !== list.scrollLeft) list.scrollLeft = next
                desired.set(list, next)
            }
            if (current) syncThumb()
            updateOverflowCounts()
        })
    }

    // ── Overflow dropdown ────────────────────────────────────────────────────
    // dockview's overflow popover opens at the click point and lists only the
    // clipped tabs. Re-anchor it as a proper dropdown (below the control, right-
    // aligned), and rebuild it to list EVERY tab. Selecting one activates it and
    // scrolls it into view right-aligned (or left-anchored if it is too early to
    // right-align).

    function scrollTabIntoViewRightAligned(list: HTMLElement, tab: HTMLElement) {
        const max = list.scrollWidth - list.clientWidth
        const tabs = list.querySelectorAll<HTMLElement>('.dv-tab')
        const isLast = tabs.length > 0 && tabs[tabs.length - 1] === tab
        // The last tab scrolls fully right so its trailing margin (and the gap to
        // the overflow control) is visible; others align their right edge to the
        // visible right edge. Clamped to 0 when the tab is too early to right-align.
        const target = isLast ? max : tab.offsetLeft + tab.offsetWidth - list.clientWidth
        const next = Math.max(0, Math.min(max, target))
        list.scrollLeft = next
        desired.set(list, next)
        if (current === list) syncThumb()
    }

    // The overflow control's badge shows the TOTAL number of tabs (dockview sets
    // it to just the hidden count, which is confusing), kept in sync on changes.
    function updateOverflowCounts() {
        for (const ctrl of container.querySelectorAll<HTMLElement>(
            '.dv-tabs-overflow-dropdown-default',
        )) {
            const strip = ctrl.closest('.dv-tabs-and-actions-container')
            const total = String(strip ? strip.querySelectorAll('.dv-tab').length : 0)
            const span = ctrl.querySelector('span')
            // Only write on a real difference, so the MutationObserver that calls
            // this doesn't fire itself in a loop.
            if (span && span.textContent !== total) span.textContent = total
        }
    }
    // dockview's OverflowObserver rewrites the badge to the hidden-tab count after
    // our update; re-assert the total whenever it (or the tab set) changes.
    const countObserver = new MutationObserver(() => updateOverflowCounts())
    countObserver.observe(container, { subtree: true, childList: true, characterData: true })

    function rebuildOverflowPopup(popup: HTMLElement, list: HTMLElement) {
        const realTabs = [...list.querySelectorAll<HTMLElement>('.dv-tab')]
        popup.replaceChildren()
        for (const realTab of realTabs) {
            const item = document.createElement('div')
            item.className = 'dv-compass-overflow-item'
            if (realTab.classList.contains('dv-active-tab')) {
                item.classList.add('dv-compass-overflow-active')
            }
            const label = realTab.querySelector('.dv-default-tab-content')?.textContent
            const name = (label ?? realTab.textContent ?? '').trim()
            // A pinned tab leads the strip, and this list mirrors the strip: mark it the same way.
            if (realTab.querySelector('[data-pinned="true"]')) {
                item.dataset.pinned = 'true'
                const pin = item.appendChild(document.createElement('span'))
                pin.className = 'dv-compass-overflow-pin'
                pin.setAttribute('aria-hidden', 'true')
                pin.innerHTML = iconSvg('pin', { size: 12 })
            }
            const text = item.appendChild(document.createElement('span'))
            text.className = 'dv-compass-overflow-label'
            text.textContent = name

            // A close control per row: with a strip this long the row you want to close is
            // often the one you cannot see, which is the whole reason this list exists.
            const close = item.appendChild(document.createElement('button'))
            close.type = 'button'
            close.className = 'dv-compass-overflow-close'
            close.title = `Close ${name}`
            close.setAttribute('aria-label', `Close ${name}`)
            close.innerHTML = iconSvg('close', { size: 14 })
            close.addEventListener('click', (event) => {
                // Without this the row's own handler would also run and ACTIVATE the tab it was
                // asked to close.
                event.stopPropagation()
                closeTab(realTab)
                const remaining = [...list.querySelectorAll<HTMLElement>('.dv-tab')]
                if (remaining.length === 0) popup.parentElement?.remove()
                else rebuildOverflowPopup(popup, list)
            })

            item.addEventListener('click', () => {
                activateTab(realTab)
                requestAnimationFrame(() => scrollTabIntoViewRightAligned(list, realTab))
                popup.parentElement?.remove() // close the popover
            })
            popup.appendChild(item)
        }
    }

    function onOverflowClick(event: MouseEvent) {
        const control = (event.target as HTMLElement | null)?.closest?.(
            '.dv-tabs-overflow-dropdown-root',
        )
        if (!control) return
        const strip = control.closest('.dv-tabs-and-actions-container')
        const list = strip?.querySelector<HTMLElement>('.dv-tabs-container')
        if (!list) return
        requestAnimationFrame(() => {
            const popup = container.querySelector<HTMLElement>('.dv-tabs-overflow-container')
            const wrapper = popup?.parentElement
            const anchor = wrapper?.parentElement // .dv-popover-anchor
            if (!popup || !wrapper || !anchor) return
            rebuildOverflowPopup(popup, list)
            const c = control.getBoundingClientRect()
            const a = anchor.getBoundingClientRect()
            wrapper.style.left = `${Math.max(0, c.right - a.left - popup.offsetWidth)}px`
            wrapper.style.top = `${c.bottom - a.top}px`
        })
    }

    container.addEventListener('mousemove', onMouseMove)
    bar.addEventListener('mouseleave', () => {
        if (!dragging) bar.style.display = 'none'
    })
    thumb.addEventListener('pointerdown', onThumbPointerDown)
    container.addEventListener('wheel', onWheelCapture, { passive: true, capture: true })
    container.addEventListener('scroll', onScrollCapture, true)
    container.addEventListener('click', onOverflowClick, true)
    // Activation reveals the active tab; other layout changes (resize) just hold position.
    const activeSub = api.onDidActivePanelChange(revealActiveTab)
    const layoutSub = api.onDidLayoutChange(restoreDesired)

    return () => {
        countObserver.disconnect()
        activeSub.dispose()
        layoutSub.dispose()
        container.removeEventListener('mousemove', onMouseMove)
        container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
        container.removeEventListener('scroll', onScrollCapture, true)
        container.removeEventListener('click', onOverflowClick, true)
        bar.remove()
    }
}
