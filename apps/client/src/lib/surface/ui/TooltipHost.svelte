<script lang="ts">
    /**
     * Draws the Client's one tooltip, for whichever control carries `data-tooltip` (tooltip.ts says
     * when it shows). Mounted once, in the root layout, so every page has it and no control draws
     * its own.
     *
     * It listens to the whole document, in the capture phase, so a control that stops an event (the
     * Command Bar's buttons cancel their pointer down to keep the editor's focus) still gets its
     * tooltip. The tooltip takes no clicks and is hidden from screen readers: the words are the
     * control's `aria-label` already, and reading them twice is noise.
     */
    import { flushSync, onMount } from 'svelte'

    import { visibleArea } from '../menu-placement'
    import { placeTooltip, type PointerKind, TooltipController, type TooltipMode } from '../tooltip'

    /** How often a showing tooltip checks that its control is still there, where it is, and its words. */
    const WATCH_MS = 250

    let tip = $state<HTMLDivElement>()
    /** What the tooltip shows and where; null while none shows. */
    let shown = $state<{ text: string; x: number; y: number; side: 'above' | 'below' } | null>(null)

    let hovered: Element | null = null
    let pressedOn: Element | null = null
    let watching: ReturnType<typeof setInterval> | undefined
    /** Where the control was when the tooltip was last placed, to follow it when it moves. */
    let placedAt = { left: 0, top: 0 }
    let followFrame = 0

    /** The control under `node` that has words to show, if any. */
    function owner(node: EventTarget | null): HTMLElement | null {
        const element = node instanceof Element ? node.closest<HTMLElement>('[data-tooltip]') : null
        return element && words(element) ? element : null
    }

    function words(element: Element): string {
        return element.getAttribute('data-tooltip')?.trim() ?? ''
    }

    function kind(event: PointerEvent): PointerKind {
        return event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse'
    }

    /**
     * Gone from the page, hidden, or scrolled out of sight (off the screen, or under the edge of the
     * strip or list it scrolls in): a tooltip naming it would point at nothing.
     */
    function outOfSight(target: HTMLElement): boolean {
        if (!target.isConnected) return true
        const box = target.getBoundingClientRect()
        if (box.width === 0 && box.height === 0) return true
        const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        return !inside(centre, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }) || clippedByScroller(target, centre)
    }

    function inside(point: { x: number; y: number }, edge: { left: number; top: number; right: number; bottom: number }): boolean {
        return point.x >= edge.left && point.x <= edge.right && point.y >= edge.top && point.y <= edge.bottom
    }

    /** Whether a box the control scrolls in, such as the Command Bar's strip, hides `point`. */
    function clippedByScroller(target: HTMLElement, point: { x: number; y: number }): boolean {
        for (let box = target.parentElement; box; box = box.parentElement) {
            const style = getComputedStyle(box)
            if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
            if (!inside(point, box.getBoundingClientRect())) return true
        }
        return false
    }

    /** Show the words at the top left, measure them there, then move them beside the control. */
    function draw(target: HTMLElement, mode: TooltipMode) {
        shown = { text: words(target), x: 0, y: 0, side: 'below' }
        // Placed nowhere yet, so `follow` draws it again if it cannot be measured now.
        placedAt = { left: NaN, top: NaN }
        flushSync()
        if (!tip) {
            // Shown while Svelte is in the middle of an update of its own (a dialog going away gives
            // the focus back to its button): measured once that update is done.
            followFrame = requestAnimationFrame(follow)
            return
        }
        const box = target.getBoundingClientRect()
        placedAt = { left: box.left, top: box.top }
        const size = tip.getBoundingClientRect()
        // Above for a finger, which would cover a tooltip below it; below for a mouse.
        const placed = placeTooltip(box, size, visibleArea(), mode === 'brief' ? 'above' : 'below')
        shown = { ...shown, ...placed }
    }

    /**
     * Keep the tooltip with its control: put it away once the control is out of sight, and draw it
     * again where the control now is, or with its new words.
     */
    function follow() {
        const current = tooltips.current
        if (!current) return
        if (outOfSight(current.target)) {
            tooltips.dismiss()
            return
        }
        const box = current.target.getBoundingClientRect()
        const moved = box.left !== placedAt.left || box.top !== placedAt.top
        if (moved || shown?.text !== words(current.target)) draw(current.target, current.mode)
    }

    const tooltips = new TooltipController<HTMLElement>({
        show(target, mode) {
            draw(target, mode)
            watching = setInterval(follow, WATCH_MS)
        },
        hide() {
            clearInterval(watching)
            cancelAnimationFrame(followFrame)
            shown = null
        },
    })

    onMount(() => () => tooltips.dismiss())

    function onpointerover(event: PointerEvent) {
        const target = owner(event.target)
        if (target === hovered) return
        if (hovered instanceof HTMLElement) tooltips.leave(hovered)
        hovered = target
        if (target) tooltips.enter(target, kind(event))
    }

    /** Off the page altogether (another window, or the edge): what was hovered is left. */
    function onpointerout(event: PointerEvent) {
        if (event.relatedTarget !== null || !(hovered instanceof HTMLElement)) return
        tooltips.leave(hovered)
        hovered = null
    }

    function onpointerdown(event: PointerEvent) {
        pressedOn = owner(event.target)
        tooltips.press(kind(event))
    }

    function onpointerup(event: PointerEvent) {
        const target = owner(event.target)
        if (target && target === pressedOn) tooltips.tap(target, kind(event))
        pressedOn = null
    }

    /** A swipe the browser took for a scroll is not a tap. */
    function onpointercancel() {
        pressedOn = null
    }

    function onfocusin(event: FocusEvent) {
        const target = owner(event.target)
        // Only a control reached with the keyboard: a click focuses its button too.
        if (target && target.matches(':focus-visible')) tooltips.focus(target)
    }

    function onfocusout(event: FocusEvent) {
        const target = owner(event.target)
        if (target) tooltips.blur(target)
    }

    function onkeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') tooltips.dismiss()
    }

    /**
     * A scroll or a resize moves the control, so the tooltip follows it, once a frame, and goes when the control
     * leaves sight. It is not put away outright: turning on a PDF tool scrolls the Command Bar to show
     * the tool whole, in the same moment as the tap whose words are showing.
     */
    function onscroll() {
        if (!tooltips.current) return
        cancelAnimationFrame(followFrame)
        followFrame = requestAnimationFrame(follow)
    }
</script>

<svelte:document
    onpointerovercapture={onpointerover}
    onpointeroutcapture={onpointerout}
    onpointerdowncapture={onpointerdown}
    onpointerupcapture={onpointerup}
    onpointercancelcapture={onpointercancel}
    onfocusincapture={onfocusin}
    onfocusoutcapture={onfocusout}
    onkeydowncapture={onkeydown}
    onscrollcapture={onscroll}
/>
<!-- A resize moves the control as a scroll does (a phone turned, a window dragged wider). -->
<svelte:window onblur={() => tooltips.dismiss()} onresize={onscroll} />

{#if shown}
    <div
        bind:this={tip}
        class="gk-tooltip"
        style:left="{shown.x}px"
        style:top="{shown.y}px"
        data-side={shown.side}
        aria-hidden="true"
        data-testid="tooltip"
    >
        {shown.text}
    </div>
{/if}

<style>
    /* The menu's colours, so it reads as part of the app in either theme, at the size of a menu
       row's text ([[Style Guide]], "Icons"). */
    .gk-tooltip {
        position: fixed;
        z-index: var(--z-tooltip);
        max-width: min(20rem, calc(100vw - 1rem));
        padding: 0.25rem 0.5rem;
        border: 1px solid var(--gk-menu-border);
        border-radius: 6px;
        background: var(--gk-menu-bg);
        box-shadow: var(--gk-menu-shadow);
        color: var(--gk-text-strong);
        font-size: 0.875rem;
        line-height: 1.25rem;
        font-weight: 500;
        overflow-wrap: break-word;
        white-space: normal;
        /* It names the control under the pointer; a click there must reach the control. */
        pointer-events: none;
        user-select: none;
        animation: gk-tooltip-in 120ms ease-out;
    }
    @keyframes gk-tooltip-in {
        from {
            opacity: 0;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .gk-tooltip {
            animation: none;
        }
    }
    @media print {
        .gk-tooltip {
            display: none;
        }
    }
</style>
