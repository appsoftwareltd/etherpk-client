<script module lang="ts">
    import { THEME_CHANGE_EVENT } from "@appsoftwareltd/etherpk-shared/theme";
    import { createSubscriber } from "svelte/reactivity";

    /** Read again whenever the app changes theme, as the editor redraws its rendered widgets (rendered-common.ts). */
    const watchTheme = createSubscriber((update) => {
        window.addEventListener(THEME_CHANGE_EVENT, update);
        return () => window.removeEventListener(THEME_CHANGE_EVENT, update);
    });
</script>

<script lang="ts">
    /**
     * Source the editor draws with a registered Augmentation renderer (ADR 0022), drawn the same way
     * in a read-only quote: inline `$…$` math and a `math` or `mermaid` fence. The renderer turns
     * source into DOM and knows nothing of the editor, so the quote asks it exactly as the editor's
     * hosts do (math-inline.ts, fence-render.ts), with the theme at the time and again whenever it
     * changes.
     *
     * The children (the source, as the quote would show it without a renderer) stand in until the
     * drawing arrives, and for good when there is no renderer or it fails: the editor falls back to
     * the source the same way.
     */
    import type { Snippet } from "svelte";

    import { isDark } from "./augmentations/rendered-common";
    import { lookupAugmentationRenderer } from "./augmentations/renderers/contract";

    let {
        info,
        source,
        inline = false,
        children,
    }: {
        /** The renderer's id: a fence's info-string, or `math` for inline math. */
        info: string;
        source: string;
        inline?: boolean;
        children: Snippet;
    } = $props();

    const renderer = $derived(lookupAugmentationRenderer(info));
    const dark = $derived.by(() => {
        watchTheme();
        return isDark();
    });
    // Asked again only when the source, the renderer or the theme changes: a panel refresh that
    // leaves them alone keeps the drawing it has.
    const drawing = $derived(renderer ? renderer.render(source, { dark, inline }) : null);

    function mount(result: HTMLElement) {
        return (element: HTMLElement) => {
            element.replaceChildren(result);
        };
    }
</script>

<!-- The source until the drawing arrives, and for good when there is none or it fails. -->
{#if drawing}{#await drawing}{@render children()}{:then node}<svelte:element
            this={inline ? "span" : "div"}
            class={inline ? "rendered" : "rendered rendered--block"}
            data-testid="reference-rendered"
            data-info={info}
            {@attach mount(node)}
        ></svelte:element>{:catch}{@render children()}{/await}{:else}{@render children()}{/if}

<style>
    /* A drawing wider than the panel scrolls rather than pushing the card wider. */
    .rendered--block {
        display: block;
        margin: 0.2rem 0;
        overflow-x: auto;
    }
    .rendered--block :global(svg) {
        max-width: 100%;
        height: auto;
    }
</style>
