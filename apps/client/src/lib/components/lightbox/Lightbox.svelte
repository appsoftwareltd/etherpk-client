<script lang="ts">
    /**
     * The [[Lightbox]] (`lightbox.ts` opens it): one image as large as the viewport allows, in the
     * shared Dialog, so Escape, the close button and the backdrop close it, and only it when it is
     * open over another dialog (the dialog stack). The image's name is the heading.
     *
     * Given several images, Previous and Next (and ← and →) step through them in the order given and
     * stop at either end (`lightbox-place.ts`), with the position shown as "2 of 3". While an image
     * loads, a spinner shows once it has taken a moment, so a quick read never flashes one; an image
     * that cannot be read says so under its name.
     */
    import { tick, untrack } from "svelte";

    import { Dialog } from "#lib/components/dialog.js";
    import { iconSvg } from "#lib/surface/icons.js";

    import type { LightboxImage } from "./lightbox-image";
    import { lightboxPlace } from "./lightbox-place";

    const { images, start = 0, onclose }: { images: readonly LightboxImage[]; start?: number; onclose: () => void } = $props();

    /** How long an image may take to read before the spinner shows. */
    const SPINNER_DELAY_MS = 150;

    /** The image shown: where the Lightbox opened, then wherever Previous and Next take it. */
    let index = $state(untrack(() => lightboxPlace(images.length, start).position - 1));
    const place = $derived(lightboxPlace(images.length, index));
    const image = $derived(images[index]);

    /** The image's address, read again only when the Lightbox steps to another image. */
    const picture = $derived(image.load().catch(() => null));
    /** How the `<img>` for an image came out; the image shown now is loading until its own event says otherwise. */
    let drawn = $state.raw<{ index: number; state: "loaded" | "failed" } | null>(null);
    const status = $derived(drawn?.index === index ? drawn.state : "loading");
    /** The image that has been loading long enough for the spinner. */
    let slow = $state<number | null>(null);
    $effect(() => {
        const shown = index;
        const timer = setTimeout(() => (slow = shown), SPINNER_DELAY_MS);
        return () => clearTimeout(timer);
    });
    const spinnerShown = $derived(status === "loading" && slow === index);

    let stage = $state<HTMLElement>();
    let previousButton = $state<HTMLButtonElement>();
    let nextButton = $state<HTMLButtonElement>();

    /**
     * Step to the image at `to`. A button the step disables (Next on reaching the last image) would
     * drop the keyboard out of the dialog, so it moves to the button that can still step.
     */
    async function step(to: number | null): Promise<void> {
        if (to === null) return;
        index = to;
        await tick();
        const active = document.activeElement;
        const panel = stage?.closest('[role="dialog"]');
        if (panel && (!panel.contains(active) || (active instanceof HTMLButtonElement && active.disabled))) {
            (place.previous === null ? nextButton : previousButton)?.focus();
        }
    }

    /** The image a bare ← or → steps to, or undefined for any other key, or one with a modifier held. */
    function arrowStep(event: KeyboardEvent): number | null | undefined {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
        return event.key === "ArrowLeft" ? place.previous : event.key === "ArrowRight" ? place.next : undefined;
    }

    /** ← and → step while the keyboard is in the Lightbox, unless something in it took the key. */
    function onKeydown(event: KeyboardEvent): void {
        const to = event.defaultPrevented ? undefined : arrowStep(event);
        if (to === undefined) return;
        const panel = stage?.closest('[role="dialog"]');
        if (!panel?.contains(event.target as Node | null)) return;
        event.preventDefault();
        void step(to);
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet steps()}
    <p class="m-0 mr-auto self-center text-sm text-(--gk-text-muted)" aria-live="polite" data-testid="lightbox-position">
        {place.position} of {place.count}
    </p>
    <button type="button" bind:this={previousButton} class="gk-button" aria-label="Previous image" disabled={place.previous === null} onclick={() => void step(place.previous)}>
        Previous
    </button>
    <button type="button" bind:this={nextButton} class="gk-button" aria-label="Next image" disabled={place.next === null} onclick={() => void step(place.next)}>
        Next
    </button>
{/snippet}

<!-- With one image there is nothing to step to, and no footer. -->
<Dialog open title={image.name} size="screen" fillPhone testId="lightbox" footer={place.count > 1 ? steps : undefined} {onclose}>
    {#snippet body()}
        <!-- One height whatever the image, so the buttons below stay put while stepping. An image
             smaller than the stage is shown at its own size, never blown up. -->
        <div
            bind:this={stage}
            class="relative grid h-[min(80vh,calc(100dvh-12rem))] place-items-center overflow-hidden rounded-lg bg-(--gk-surface-2) max-sm:h-[calc(100dvh-11rem)]"
            data-status={status}
            data-testid="lightbox-stage"
        >
            {#await picture then url}
                {#if url && status !== "failed"}
                    <!-- Keyed, so each image's load and error events are its own, never the last one's. -->
                    {#key index}
                        <img
                            src={url}
                            alt={image.name}
                            decoding="async"
                            class={["max-h-full max-w-full object-contain", status === "loading" && "invisible"]}
                            onload={() => (drawn = { index, state: "loaded" })}
                            onerror={() => (drawn = { index, state: "failed" })}
                            data-testid="lightbox-image"
                        />
                    {/key}
                {:else}
                    <div role="alert" class="flex max-w-sm flex-col items-center gap-2 px-4 text-center" data-testid="lightbox-error">
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
                        <span class="grid size-8 place-items-center text-(--gk-text-muted)" aria-hidden="true">{@html iconSvg("image", { size: 32 })}</span>
                        <p class="m-0 text-sm font-medium text-(--gk-text-default)">This image could not be loaded.</p>
                        <p class="m-0 text-sm text-(--gk-text-muted)">The graph may not hold it, or it has not reached this device yet.</p>
                    </div>
                {/if}
            {/await}
            {#if spinnerShown}
                <span class="absolute inset-0 grid place-items-center" role="status" aria-label="Loading the image" data-testid="lightbox-loading">
                    <svg class="size-6 text-(--gk-text-muted) motion-safe:animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
                    </svg>
                </span>
            {/if}
        </div>
    {/snippet}
</Dialog>
