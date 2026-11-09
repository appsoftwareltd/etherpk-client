<script lang="ts">
    /**
     * A tool's colours, and a drawing tool's thicknesses, over the page of a PDF or an EBook. On every screen
     * they tuck to the page's right edge, behind a button that shows the colour in hand and points to where
     * they come out, because a row across the top would cover the words a person is reading.
     */
    import type { Snippet } from "svelte";

    import { iconSvg } from "#lib/surface/icons.js";

    let {
        open,
        colour,
        label,
        testid,
        ontoggle,
        children,
    }: {
        open: boolean;
        /** The colour in hand, shown on the button while the options are tucked away. */
        colour: string;
        label: string;
        /** The reader's prefix for test ids: `pdf` or `ebook`. */
        testid: string;
        ontoggle: () => void;
        children: Snippet;
    } = $props();

    const listId = $props.id();
</script>

<div class="etherpk-tool-options" data-open={open || undefined} data-testid={`${testid}-tool-options`}>
    <button type="button" class="etherpk-tool-options-toggle" aria-label={label} title={label} aria-expanded={open} aria-controls={listId} onclick={ontoggle} data-testid={`${testid}-tool-options-toggle`}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg(open ? "pdf-page-next" : "pdf-page-previous")}
        <span class="size-5 rounded-full border border-neutral-400" style:background-color={colour} data-testid={`${testid}-tool-options-colour`}></span>
    </button>
    <div id={listId} class="etherpk-tool-options-list flex flex-wrap items-center justify-center gap-1 rounded-2xl border border-(--gk-surface-2) bg-(--gk-surface-0) p-1 shadow">
        {@render children()}
    </div>
</div>

<style>
    /* Over the page, so opening them never moves the page under the pointer. */
    .etherpk-tool-options {
        position: absolute;
        top: 0.5rem;
        right: 0;
        z-index: 10;
        display: flex;
        flex-direction: row-reverse;
        align-items: flex-start;
        gap: 0.25rem;
        max-width: calc(100% - 0.75rem);
    }
    /* Held against the page's edge, as a tab to pull out. */
    .etherpk-tool-options-toggle {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        gap: 0.125rem;
        height: 2.75rem;
        padding: 0 0.5rem 0 0.25rem;
        border: 1px solid var(--gk-border-strong, var(--gk-surface-2));
        border-right: 0;
        border-radius: 0.75rem 0 0 0.75rem;
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        color: var(--gk-text-default);
    }
    .etherpk-tool-options-toggle:hover {
        background: var(--gk-surface-2);
    }
    .etherpk-tool-options-toggle:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    .etherpk-tool-options-list {
        min-width: 0;
    }
    .etherpk-tool-options:not([data-open]) .etherpk-tool-options-list {
        display: none;
    }
</style>
