<script lang="ts">
    /**
     * The two named buttons in a row at the foot of a document's tab (ADR 0149, ADR 0168 as amended
     * 2026-11-11): one starts a new line of text, the other a new bullet, each with the caret on it,
     * after the caret's block when the caret is in the document and at the end otherwise. For when
     * placing the caret is fiddly, most of all on a phone. What a press writes, and taking an
     * untouched line back out, are `end-of-document.ts`'s; DocumentView decides which editor a
     * press goes to.
     *
     * The row is the pane's, not the editor's: it takes its own height below the box the text
     * scrolls in, as the Match List does, so it is on screen however long the document is, covers no
     * line of it, and a screen reader never reads it as the document's. One pair per tab: a Journal
     * Roll's older days take their presses from the tab's pair, through the caret.
     */
    import { iconSvg } from '#lib/surface/icons.js'

    import type { EndKind } from './end-of-document'

    let {
        onstart,
        height = $bindable(0),
    }: {
        /** A button was pressed. */
        onstart: (kind: EndKind) => void
        /** The row's height in CSS pixels, for what the pane floats above it (the Lock button). */
        height?: number
    } = $props()

    /** `name` is what the button shows and is called; `hint` says what a press does, as its tooltip and description. */
    const buttons: { kind: EndKind; icon: string; name: string; hint: string }[] = [
        { kind: 'line', icon: 'text-lines', name: 'New line', hint: 'Start a new line of text' },
        { kind: 'bullet', icon: 'bullet', name: 'New block', hint: 'Add a block' },
    ]

    /**
     * Keep the keyboard in the editor: a press on a button would otherwise take the focus from it
     * first, and the press would then find no caret to start after.
     */
    function keepEditorFocus(event: MouseEvent): void {
        event.preventDefault()
    }
</script>

<div class="end-buttons" role="group" aria-label="New line or block" data-end-of-document data-testid="end-of-document" bind:offsetHeight={height}>
    {#each buttons as button (button.kind)}
        <button
            type="button"
            class="end-button"
            title={button.hint}
            data-testid={`end-of-document-${button.kind}`}
            onmousedown={keepEditorFocus}
            onclick={() => onstart(button.kind)}
        >
            <span class="end-button__icon" aria-hidden="true">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo icon markup, made trusted by icons.ts (ADR 0130) -->
                {@html iconSvg(button.icon, { size: 16 })}
            </span>
            {button.name}
        </button>
    {/each}
</div>

<style>
    /* A row of the pane's own below the text, never over it: the editor above gives up exactly this
       height. A rule marks where the text's box ends. The names line up with the text's left edge. */
    .end-buttons {
        flex: none;
        display: flex;
        gap: 0.25rem;
        padding: 0.25rem 0.5rem;
        border-top: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-0);
    }
    /* The names are read, so they are 14px in the muted text colour (ADR 0106): fixed to the root
       size, so the document's zoom, which scales the text above, leaves them as they are. */
    .end-button {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        min-height: 2.25rem;
        padding: 0 0.625rem;
        border: 0;
        border-radius: 0.5rem;
        background: transparent;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
        white-space: nowrap;
        cursor: pointer;
        touch-action: manipulation;
        transition:
            background-color 120ms ease-out,
            color 120ms ease-out;
    }
    .end-button__icon {
        display: inline-flex;
        flex: none;
    }
    @media (hover: hover) {
        .end-button:hover {
            background: var(--gk-surface-2);
            color: var(--gk-text-default);
        }
    }
    .end-button:active {
        background: var(--gk-surface-2);
    }
    .end-button:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    /* A finger needs a 44 CSS px target. */
    @media (pointer: coarse) {
        .end-button {
            min-height: 2.75rem;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .end-button {
            transition: none;
        }
    }
</style>
