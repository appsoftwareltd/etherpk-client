<script lang="ts" module>
    /** What a list hands the card it draws, so the card can place the grip in its band. */
    export interface GraphGripProps {
        id: string
        name: string
        dragging: boolean
        onpointerdown: (event: PointerEvent) => void
        onpointermove: (event: PointerEvent) => void
        onpointerup: (event: PointerEvent) => void
        onpointercancel: (event: PointerEvent) => void
        onlostpointercapture: (event: PointerEvent) => void
        onkeydown: (event: KeyboardEvent) => void
    }
</script>

<script lang="ts">
    /**
     * The handle a graph's card is moved by, always on show because a touch screen has no hover.
     * It stops touch from scrolling the page, so a finger on it drags the card; everywhere else on
     * the card a finger still scrolls. The arrow keys move it too (GraphOrderList).
     */
    import { ICON_ON_COLOUR } from './graph-card'

    let { grip, coloured }: { grip: GraphGripProps; coloured: boolean } = $props()

    const PLAIN =
        'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200'
</script>

<button
    type="button"
    data-testid="graph-grip"
    data-grip-id={grip.id}
    aria-label={`Reorder ${grip.name}`}
    title="Drag to reorder, or press the up and down arrow keys"
    onpointerdown={grip.onpointerdown}
    onpointermove={grip.onpointermove}
    onpointerup={grip.onpointerup}
    onpointercancel={grip.onpointercancel}
    onlostpointercapture={grip.onlostpointercapture}
    onkeydown={grip.onkeydown}
    class="touch-none select-none {grip.dragging ? 'cursor-grabbing' : 'cursor-grab'} {coloured ? ICON_ON_COLOUR : PLAIN}"
>
    <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="5.5" cy="3" r="1.5" />
        <circle cx="10.5" cy="3" r="1.5" />
        <circle cx="5.5" cy="8" r="1.5" />
        <circle cx="10.5" cy="8" r="1.5" />
        <circle cx="5.5" cy="13" r="1.5" />
        <circle cx="10.5" cy="13" r="1.5" />
    </svg>
</button>
