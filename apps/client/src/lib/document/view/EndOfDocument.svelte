<script lang="ts">
    /**
     * The two buttons floating at the bottom left of a document's tab (ADR 0149, ADR 0168): one
     * starts a new line of text, the other a new bullet, each with the caret on it, after the
     * caret's block when the caret is in the document and at the end otherwise. For when placing the
     * caret is fiddly, most of all on a phone. What a press writes, and taking an untouched line back
     * out, are `end-of-document.ts`'s; DocumentView decides which editor a press goes to.
     *
     * Over the pane rather than in the editor's text, as the Lock button is on the right, so a screen
     * reader never reads it as the document's. One pair per tab: a Journal Roll's older days take
     * their presses from the tab's pair, through the caret.
     */
    import { iconSvg } from '#lib/surface/icons.js'

    import type { EndKind } from './end-of-document'

    let {
        onstart,
    }: {
        /** A button was pressed. */
        onstart: (kind: EndKind) => void
    } = $props()

    const buttons: { kind: EndKind; icon: string; label: string }[] = [
        { kind: 'line', icon: 'text-lines', label: 'Start a new line of text' },
        { kind: 'bullet', icon: 'bullet', label: 'Add a block' },
    ]

    /**
     * Keep the keyboard in the editor: a press on a button would otherwise take the focus from it
     * first, and the press would then find no caret to start after.
     */
    function keepEditorFocus(event: MouseEvent): void {
        event.preventDefault()
    }
</script>

<div class="end-buttons" role="group" aria-label="New line or block" data-end-of-document data-testid="end-of-document">
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
            {@html iconSvg(button.icon, { size: 18 })}
        </button>
    {/each}
</div>

<style>
    /* Bottom left, mirroring the Lock button on the right: the same distance from the pane's edges,
       above the Match List when it shows. Anchored to the pane, so on a phone it sits just above
       the Command Bar. */
    .end-buttons {
        position: absolute;
        left: 1rem;
        bottom: calc(1rem + var(--gk-match-list-height, 0px));
        z-index: 2;
        display: flex;
        gap: 0.25rem;
        padding: 0.25rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.75rem;
        background: var(--gk-surface-1);
        /* The Lock button's lift. */
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    }
    .end-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        padding: 0;
        border: 0;
        border-radius: 0.5rem;
        background: transparent;
        color: var(--gk-text-muted);
        cursor: pointer;
        touch-action: manipulation;
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
