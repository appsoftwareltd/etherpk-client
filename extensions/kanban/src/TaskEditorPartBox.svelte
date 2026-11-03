<script lang="ts">
    /**
     * The box one of the [[Task Editor]]'s part editors is drawn in (the description, the comments,
     * the additional context), with a handle under it that makes it taller (ADR 0170), like a
     * textarea's: drag it, or give it the keyboard and press ↓ and ↑ (Home and End for the smallest
     * and the largest). The box is never smaller than its own height and never taller than three
     * quarters of the window; the dialog's body scrolls when the parts outgrow it.
     *
     * The handle is the board's divider again (`separator.ts`): the same gesture and the same keys.
     * The height a person chose is kept on this device for every Task Editor
     * (`task-editor-part-heights.ts`), so the part opens at it next time.
     */
    import { type Snippet, untrack } from "svelte";

    import { dragSeparator, separatorKeyValue } from "./separator";
    import { createPartHeights, type TaskEditorPart } from "./task-editor-part-heights";

    const {
        part,
        label,
        minRem,
        hidden = false,
        oninput,
        testId,
        children,
    }: {
        part: TaskEditorPart;
        /** What the part is called, for the handle's name ("Description" → "Description height"). */
        label: string;
        /** The box's own height, in rem: the smallest it is drawn at. */
        minRem: number;
        hidden?: boolean;
        oninput?: (event: Event) => void;
        testId: string;
        children: Snippet;
    } = $props();

    /** How far one arrow press moves the handle, in CSS pixels. */
    const KEY_STEP_PX = 40;
    /** The tallest a part is drawn, as a share of the window's height. */
    const MAX_SHARE_OF_WINDOW = 0.75;

    const heights = createPartHeights();
    const uid = $props.id();

    /** The smallest and largest the box may be now, in CSS pixels. */
    function range(): { min: number; max: number } {
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const min = Math.round(minRem * rem);
        return { min, max: Math.max(min, Math.floor(window.innerHeight * MAX_SHARE_OF_WINDOW)) };
    }
    const clamp = (value: number) => {
        const { min, max } = range();
        return Math.min(max, Math.max(min, Math.round(value)));
    };

    /** The height kept for this part on this device, held inside the range this window allows. */
    function keptHeight(): number | null {
        const kept = heights.get(untrack(() => part));
        return kept === null ? null : clamp(kept);
    }

    /** The height chosen, in CSS pixels, or null for the box's own: to begin with, what was kept. */
    let height = $state<number | null>(keptHeight());
    /** The range the handle announces, measured again at each resize (the window may have changed size). */
    let bounds = $state(range());
    const shown = $derived(height ?? bounds.min);
    let box = $state<HTMLElement>();

    function resize(next: number, keep: boolean): void {
        bounds = range();
        height = clamp(next);
        if (keep) heights.set(part, height);
    }

    function onPointerDown(event: PointerEvent): void {
        if (!box) return;
        const startY = event.clientY;
        const startHeight = box.getBoundingClientRect().height;
        dragSeparator(
            event,
            (move) => resize(startHeight + move.clientY - startY, false),
            () => height !== null && heights.set(part, height),
        );
    }

    function onKeydown(event: KeyboardEvent): void {
        const next = separatorKeyValue(event.key, shown, { ...range(), step: KEY_STEP_PX, growsDownward: true });
        if (next === null) return;
        event.preventDefault();
        resize(next, true);
    }
</script>

<div class={["flex flex-col", hidden && "hidden"]}>
    <div
        bind:this={box}
        id="{uid}-box"
        class="overflow-hidden rounded-lg border border-(--gk-control-border)"
        style:height="{shown}px"
        {oninput}
        data-testid={testId}
    >
        {@render children()}
    </div>
    <!-- The handle: a strip under the box, the width of it, with a grip at its right end where a
         textarea's would be. A focusable separator is a widget in ARIA, which the a11y check does not
         know (the board's divider is the same). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="{label} height"
        aria-controls="{uid}-box"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={shown}
        aria-valuetext="{shown} pixels tall"
        tabindex="0"
        class="group relative h-3 shrink-0 cursor-row-resize touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
        onpointerdown={onPointerDown}
        onkeydown={onKeydown}
        data-testid="{testId}-resize"
    >
        <span class="absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-transparent group-hover:bg-(--gk-accent) group-focus-visible:bg-(--gk-accent)"></span>
        <span class="absolute top-1/2 right-1 h-1 w-6 -translate-y-1/2 rounded-full bg-(--gk-text-subtle) group-hover:bg-(--gk-accent)" aria-hidden="true"></span>
    </div>
</div>
