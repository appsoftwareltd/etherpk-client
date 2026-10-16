<script lang="ts">
    /**
     * The two buttons after a document's text (ADR 0149): one starts a new line at the end, the
     * other a new top-level bullet, each with the caret on it. For when placing the caret at the
     * bottom is fiddly, most of all on a phone. What a press writes, and taking an untouched line
     * back out, are `end-of-document.ts`'s.
     *
     * DocumentView mounts this inside the editor's scroller, after its content and before any
     * Journal Panels and Backlinks, as it does the Backlinks (ADR 0135): not in the editable text,
     * so a screen reader never reads it as the document's, and not in the editor's height map.
     * Shown while the document can be written; DocumentView says when.
     */
    import { iconSvg } from '$lib/surface/icons'

    import { CONTENT_PAD_X } from './cm-document'
    import type { EndKind } from './end-of-document'

    let {
        shown,
        onstart,
    }: {
        /** Whether the buttons are drawn: the body takes edits and its content is in. */
        shown: boolean
        /** A button was pressed. */
        onstart: (kind: EndKind) => void
    } = $props()

    const buttons: { kind: EndKind; icon: string; label: string }[] = [
        { kind: 'line', icon: 'text-lines', label: 'Start a new line at the end' },
        { kind: 'bullet', icon: 'bullet', label: 'Add a block at the end' },
    ]

    /** Keep the keyboard in the editor: a press on a button would otherwise take the focus from it first. */
    function keepEditorFocus(event: MouseEvent): void {
        event.preventDefault()
    }
</script>

{#if shown}
    <div class="end-of-document" style:--content-pad-x={CONTENT_PAD_X} role="group" aria-label="End of document" data-end-of-document data-testid="end-of-document">
        {#each buttons as button (button.kind)}
            <button
                type="button"
                class="end-button"
                aria-label={button.label}
                title={button.label}
                data-testid={`end-of-document-${button.kind}`}
                onmousedown={keepEditorFocus}
                onclick={() => onstart(button.kind)}
            >
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo icon markup, made trusted by icons.ts (ADR 0130) -->
                {@html iconSvg(button.icon, { size: 16 })}
            </button>
        {/each}
    </div>
{/if}

<style>
    /* A row of its own in the editor's scroller, in the text's column, as the Backlinks below it
       are (DocumentBacklinks.svelte): DocumentView wraps the scroller's flex row while this is
       drawn. Small and quiet, so it reads as part of the page's chrome and not its text. */
    .end-of-document {
        flex: 0 0 calc(100% - 2 * var(--content-pad-x));
        min-width: 0;
        box-sizing: border-box;
        margin: 0 var(--content-pad-x);
        padding: 0 0 1rem;
        display: flex;
        gap: 0.25rem;
        cursor: default;
    }
    .end-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        padding: 0;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.5rem;
        background: transparent;
        color: var(--gk-text-muted);
        cursor: pointer;
        transition:
            background-color 120ms ease-out,
            color 120ms ease-out;
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
        outline-offset: 2px;
    }
    /* A finger needs a 44 CSS px target. */
    @media (pointer: coarse) {
        .end-button {
            width: 2.75rem;
            height: 2.75rem;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .end-button {
            transition: none;
        }
    }
</style>
