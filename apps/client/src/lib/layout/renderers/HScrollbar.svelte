<script lang="ts">
    /**
     * A mobile-friendly horizontal scrollbar for any overflow-x strip: a thick,
     * easy-to-grab thumb in its own row, replacing the native bar (which is hard to
     * drag on touch). Self-contained — it measures the target via a ResizeObserver
     * (viewport/size changes) and a MutationObserver (content added/removed), and
     * drives the target's `scrollLeft` from thumb drags.
     *
     * Renders nothing when the target does not overflow. Extracted from the mobile
     * tab strip in {@link MobilePresenter}; the Command Bar is its second caller.
     */
    let {
        target,
        overflowing = $bindable(false),
        testid = 'hscrollbar',
    }: {
        /** The overflow-x:auto strip to scroll. */
        target?: HTMLElement
        /** Bound out: whether the target currently overflows. */
        overflowing?: boolean
        testid?: string
    } = $props()

    let scrollLeft = $state(0)
    let scrollWidth = $state(0)
    let clientWidth = $state(0)

    function measure() {
        if (!target) return
        scrollLeft = target.scrollLeft
        scrollWidth = target.scrollWidth
        clientWidth = target.clientWidth
    }

    // Keep the bound-out flag in step with the measured metrics.
    $effect(() => {
        overflowing = scrollWidth - clientWidth > 1
    })

    const thumbWidthPct = $derived(scrollWidth > 0 ? Math.min(100, (clientWidth / scrollWidth) * 100) : 100)
    const thumbLeftPct = $derived(
        scrollWidth > 0 ? Math.min(100 - thumbWidthPct, (scrollLeft / scrollWidth) * 100) : 0,
    )

    // Track live scroll + size + content of the strip. ResizeObserver catches viewport
    // resizes (clientWidth); MutationObserver catches items added/removed (scrollWidth),
    // which a ResizeObserver on the strip itself would miss.
    $effect(() => {
        if (!target) return
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(target)
        const mo = new MutationObserver(measure)
        mo.observe(target, { childList: true, subtree: true, characterData: true })
        target.addEventListener('scroll', measure, { passive: true })
        return () => {
            ro.disconnect()
            mo.disconnect()
            target?.removeEventListener('scroll', measure)
        }
    })

    function onThumbPointerDown(event: PointerEvent) {
        if (!target) return
        event.preventDefault()
        const track = (event.currentTarget as HTMLElement).parentElement
        const trackWidth = track?.clientWidth ?? target.clientWidth
        const startX = event.clientX
        const startScroll = target.scrollLeft
        const ratio = scrollWidth / trackWidth // content px per track px
        const onMove = (e: PointerEvent) => {
            if (target) target.scrollLeft = startScroll + (e.clientX - startX) * ratio
        }
        const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }
</script>

{#if overflowing}
    <div class="hscroll" data-testid={testid}>
        <button
            class="hscroll-thumb"
            data-testid="{testid}-thumb"
            aria-label="Scroll"
            style="left: {thumbLeftPct}%; width: {thumbWidthPct}%"
            onpointerdown={onThumbPointerDown}
        ></button>
    </div>
{/if}

<style>
    .hscroll {
        position: relative;
        height: 0.95rem;
        padding: 0.18rem 0;
        box-sizing: border-box;
        background: var(--gk-surface-1);
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .hscroll-thumb {
        position: absolute;
        top: 0.18rem;
        bottom: 0.18rem;
        min-width: 1.75rem;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: var(--gk-border-strong, rgba(127, 127, 127, 0.55));
        cursor: grab;
        touch-action: none;
    }
    .hscroll-thumb:hover {
        background: var(--gk-text-muted, rgba(127, 127, 127, 0.8));
    }
    .hscroll-thumb:active {
        cursor: grabbing;
    }
</style>
