<script lang="ts" generics="T">
    /**
     * A list of graphs' cards a person can put in order: by dragging a card's grip with a mouse or a
     * finger, or with the arrow keys on a focused grip. It draws the list and reports the new
     * sequence; the caller saves it, and hands the list back in that order.
     *
     * The cards stay where they are in the DOM until the drop, and move only by transform. Moving an
     * element in the DOM would drop the pointer capture its grip holds, which ends a finger's drag.
     * Nothing is saved until the drop, so Escape or a cancelled touch leaves things as they were, and
     * the data refreshing underneath a drag cannot reorder a card that is being carried.
     */
    import { tick, type Snippet } from 'svelte'

    import { applyGraphOrder } from '#lib/storage/index.js'
    import type { GraphGripProps } from './GraphGrip.svelte'
    import { closestSlot, moveId, stackedTops } from './graph-order-drag'

    let {
        items,
        idOf,
        nameOf,
        onreorder,
        card,
        testid,
    }: {
        /** In the order to show them. */
        items: readonly T[]
        idOf: (item: T) => string
        nameOf: (item: T) => string
        /** The person put the list in this sequence. */
        onreorder: (ids: string[]) => void
        /** One card; `grip` is null when the list has nothing to put in order. */
        card: Snippet<[T, GraphGripProps | null]>
        testid: string
    } = $props()

    /** What a drag needs from its start: measured once, because the cards do not change under it. */
    interface Drag {
        id: string
        pointerId: number
        /** The sequence the drag started from, which the DOM keeps until the drop. */
        startOrder: string[]
        /** Each card's height and its place in the list, as laid out at the start. */
        measured: Map<string, { top: number; height: number }>
        gap: number
        /** How far below the card's top the pointer took hold of it. */
        grabOffset: number
    }

    /** A card this near the edge of what scrolls brings the rest of the list into view. */
    const AUTOSCROLL_EDGE = 48

    let list = $state<HTMLUListElement>()
    let drag = $state.raw<Drag | null>(null)
    /** The sequence the cards are showing during a drag. */
    let sequence = $state.raw<string[]>([])
    /** Where the carried card's top is, measured as `Drag.measured` is. */
    let carriedTop = $state(0)
    let announcement = $state('')
    let pointerY = 0
    let autoscrollFrame = 0

    const shown = $derived(drag ? applyGraphOrder(items, drag.startOrder, idOf) : items)

    /** Where each card belongs in `sequence`, for the cards making room around the carried one. */
    const slotTops = $derived.by(() => {
        if (!drag) return new Map<string, number>()
        const { measured, startOrder, gap } = drag
        const firstTop = measured.get(startOrder[0])?.top ?? 0
        const tops = stackedTops(sequence.map((id) => measured.get(id)?.height ?? 0), gap)
        return new Map(sequence.map((id, index) => [id, firstTop + tops[index]]))
    })

    function transformOf(id: string): string | null {
        const natural = drag?.measured.get(id)?.top
        if (natural === undefined) return null
        const top = id === drag?.id ? carriedTop : (slotTops.get(id) ?? natural)
        return `translateY(${top - natural}px)`
    }

    function announceMove(id: string, order: readonly string[]): void {
        const item = items.find((other) => idOf(other) === id)
        if (item) announcement = `${nameOf(item)} moved to place ${order.indexOf(id) + 1} of ${order.length}.`
    }

    function startDrag(event: PointerEvent, id: string): void {
        if (!list || drag || event.button !== 0) return
        // Keeps the press from starting a text selection as the pointer moves.
        event.preventDefault()
        const cards = [...list.children] as HTMLElement[]
        const startOrder = shown.map(idOf)
        const measured = new Map(startOrder.map((other, index) => [other, { top: cards[index].offsetTop, height: cards[index].offsetHeight }]))
        const gap = cards[1].offsetTop - cards[0].offsetTop - cards[0].offsetHeight
        const carried = cards[startOrder.indexOf(id)]
        const grabOffset = event.clientY - carried.getBoundingClientRect().top
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
        pointerY = event.clientY
        carriedTop = carried.offsetTop
        sequence = startOrder
        drag = { id, pointerId: event.pointerId, startOrder, measured, gap, grabOffset }
        autoscrollFrame = requestAnimationFrame(autoscroll)
    }

    /** Bring the carried card to the pointer, and the others to where that leaves them. */
    function followPointer(current: Drag): void {
        if (!list) return
        const { id, measured, gap, grabOffset, startOrder } = current
        const height = measured.get(id)?.height ?? 0
        const firstTop = measured.get(startOrder[0])?.top ?? 0
        const lastCard = measured.get(startOrder[startOrder.length - 1])
        const lowest = (lastCard ? lastCard.top + lastCard.height : firstTop) - height
        // Held to the list: a graph belongs to its group, so the card cannot be carried out of it.
        carriedTop = Math.max(firstTop, Math.min(lowest, pointerY - grabOffset - list.getBoundingClientRect().top))
        const others = sequence.filter((other) => other !== id)
        const place = closestSlot(others.map((other) => measured.get(other)?.height ?? 0), height, gap, carriedTop - firstTop + height / 2)
        const next = moveId(sequence, id, place)
        if (next.some((other, index) => other !== sequence[index])) sequence = next
    }

    /** The cards measured at the start are still the list's cards. A refresh may have changed them. */
    function stillTheSameCards(current: Drag): boolean {
        return items.length === current.startOrder.length && items.every((item) => current.measured.has(idOf(item)))
    }

    function moveDrag(event: PointerEvent): void {
        if (!drag || event.pointerId !== drag.pointerId) return
        if (!stillTheSameCards(drag)) {
            endDrag(false)
            return
        }
        pointerY = event.clientY
        followPointer(drag)
    }

    function endDrag(save: boolean): void {
        const finished = drag
        if (!finished) return
        cancelAnimationFrame(autoscrollFrame)
        const order = sequence
        // The new order and the end of the drag land in one update, so a card that has made room
        // stays where it is rather than jumping back for a frame.
        drag = null
        if (save && order.some((id, index) => id !== finished.startOrder[index])) {
            onreorder(order)
            announceMove(finished.id, order)
        }
    }

    /** What scrolls the list: the nearest ancestor that overflows, or the page itself. */
    function scrollerOf(element: HTMLElement): HTMLElement {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const { overflowY } = getComputedStyle(parent)
            if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent
        }
        return document.documentElement
    }

    /** While the pointer is held near the edge of what scrolls, keep scrolling, faster nearer the edge. */
    function autoscroll(): void {
        if (!drag || !list) return
        const scroller = scrollerOf(list)
        const page = scroller === document.documentElement
        const top = page ? 0 : scroller.getBoundingClientRect().top
        const bottom = page ? window.innerHeight : scroller.getBoundingClientRect().bottom
        const pastTop = top + AUTOSCROLL_EDGE - pointerY
        const pastBottom = pointerY - (bottom - AUTOSCROLL_EDGE)
        const step = pastTop > 0 ? -pastTop / 4 : pastBottom > 0 ? pastBottom / 4 : 0
        const before = scroller.scrollTop
        if (step !== 0) scroller.scrollTop = before + step
        if (scroller.scrollTop !== before) followPointer(drag)
        autoscrollFrame = requestAnimationFrame(autoscroll)
    }

    /** Move a graph one place with the arrow keys. The focus stays on its grip, which is where the person is. */
    async function moveByKey(event: KeyboardEvent, id: string): Promise<void> {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        // Pressed at either end too, so the key never scrolls the page instead.
        event.preventDefault()
        if (drag) return
        const order = items.map(idOf)
        const place = order.indexOf(id) + (event.key === 'ArrowUp' ? -1 : 1)
        if (place < 0 || place >= order.length) return
        const next = moveId(order, id, place)
        onreorder(next)
        announceMove(id, next)
        await tick()
        list?.querySelector<HTMLElement>(`[data-grip-id="${CSS.escape(id)}"]`)?.focus()
    }

    function gripFor(item: T): GraphGripProps {
        const id = idOf(item)
        return {
            id,
            name: nameOf(item),
            dragging: drag?.id === id,
            onpointerdown: (event) => startDrag(event, id),
            onpointermove: moveDrag,
            onpointerup: (event) => {
                if (event.pointerId === drag?.pointerId) endDrag(true)
            },
            onpointercancel: () => endDrag(false),
            // Fires after pointerup too, when `endDrag` has already finished and does nothing.
            onlostpointercapture: () => endDrag(false),
            onkeydown: (event) => void moveByKey(event, id),
        }
    }

    function onWindowKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && drag) {
            event.stopPropagation()
            endDrag(false)
        }
    }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<ul bind:this={list} data-testid={testid} class="relative space-y-3">
    {#each shown as item (idOf(item))}
        {@const id = idOf(item)}
        <li
            class="relative rounded-xl {drag?.id === id
                ? 'z-10 shadow-lg'
                : drag
                  ? 'transition-transform duration-150 ease-out motion-reduce:transition-none'
                  : ''}"
            style:transform={transformOf(id)}
        >
            {@render card(item, items.length > 1 ? gripFor(item) : null)}
        </li>
    {/each}
</ul>
<p data-testid="graph-order-status" role="status" class="sr-only">{announcement}</p>
