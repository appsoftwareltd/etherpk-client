<script lang="ts">
    /**
     * One bar of a [[Journal Roll]] (ADR 0136), full width and filled like the sidebar's Today's
     * journal button, in one of three states:
     *
     * - **unloaded**: "Scroll down for 2026-10-10", a button that loads the day (the roll also
     *   loads it when the reader scrolls down with the bar in view);
     * - **open**: the roll is at its cap, so the button opens the day in a tab of its own instead;
     * - **loaded**: the day's heading, its date with **Hide** (unload it and every older day) and
     *   **Open** (the day in a tab of its own, marked with the open-in-a-tab icon so it does not
     *   read as Hide's opposite). Focusable, so the roll can hand the focus to it.
     *
     * The bar that offered a day becomes that day's heading where it stands, so every state draws
     * the same box: the same height, the same icon slot and the label starting at the same point.
     * A loaded bar that sat a little lower, a little taller or with its text further left jolted the
     * page as the day loaded.
     */
    import { iconSvg } from "$lib/surface/icons";

    let {
        mode,
        day,
        onload,
        onhide,
        onopen,
        element = $bindable(),
    }: {
        mode: "unloaded" | "open" | "loaded";
        day: string;
        onload?: () => void;
        onhide?: () => void;
        onopen?: () => void;
        /** The bar's outer element, for the roll to watch and focus. */
        element?: HTMLElement;
    } = $props();

    const ICON = { unloaded: "move-down", open: "open-external", loaded: "todays-journal" } as const;
</script>

<!-- In-repo constant markup from the icon table, never document content. -->
{#snippet icon(name: string)}
    <span class="bar__icon" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html iconSvg(name, { size: 16, strokeWidth: 1.4 })}
    </span>
{/snippet}

{#if mode === "loaded"}
    <div
        bind:this={element}
        class="bar"
        tabindex="-1"
        data-testid="journal-roll-bar"
        data-state="loaded"
        data-day={day}
    >
        {@render icon(ICON.loaded)}
        <h2 class="bar__label" data-testid="journal-roll-label">{day}</h2>
        <div class="bar__actions">
            <button type="button" class="bar__action" data-testid="journal-roll-hide" aria-label="Hide {day}" onclick={onhide}>
                Hide
            </button>
            <button
                type="button"
                class="bar__action"
                data-testid="journal-roll-open"
                aria-label="Open {day} in its own tab"
                title="Open in its own tab"
                onclick={onopen}
            >
                Open
                <span class="bar__action-icon" aria-hidden="true">
                    <!-- In-repo constant markup from the icon table, never document content. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html iconSvg("open-external", { size: 14, strokeWidth: 1.4 })}
                </span>
            </button>
        </div>
    </div>
{:else}
    <button
        bind:this={element}
        type="button"
        class="bar bar--button"
        data-testid="journal-roll-bar"
        data-state={mode}
        data-day={day}
        onclick={mode === "open" ? onopen : onload}
    >
        {@render icon(ICON[mode])}
        <span class="bar__label" data-testid="journal-roll-label">
            {mode === "open" ? `Open ${day}` : `Scroll down for ${day}`}
        </span>
    </button>
{/if}

<style>
    /* The sidebar's Today's journal button: a solid fill with no visible border (kept, transparent,
       for forced colours), strong text at the 14px floor. One fixed height for every state, so the
       bar keeps its box when its day loads. */
    .bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        box-sizing: border-box;
        width: 100%;
        height: 2.5rem;
        margin: 0;
        padding: 0 0.75rem;
        border: 1px solid transparent;
        border-radius: 0.375rem;
        background: var(--gk-surface-2);
        color: var(--gk-text-strong);
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1.4;
        text-align: left;
    }
    .bar--button {
        cursor: pointer;
    }
    @media (hover: hover) {
        .bar--button:hover {
            background: var(--gk-border-strong);
        }
    }
    .bar__icon {
        display: inline-flex;
        flex-shrink: 0;
        color: var(--gk-text-subtle);
    }
    .bar__label {
        flex: 1;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        font: inherit;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .bar__actions {
        display: flex;
        gap: 0.25rem;
    }
    .bar__action {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        height: 1.75rem;
        padding: 0 0.6rem;
        border: 1px solid transparent;
        border-radius: 0.25rem;
        background: transparent;
        color: var(--gk-text-strong);
        font: inherit;
        cursor: pointer;
    }
    .bar__action-icon {
        display: inline-flex;
        color: var(--gk-text-subtle);
    }
    @media (hover: hover) {
        .bar__action:hover {
            background: var(--gk-border-strong);
        }
    }
    .bar:focus-visible,
    .bar__action:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 2px;
    }
    /* A finger needs a 44 CSS px target: every state grows alike, and the buttons fill the bar. */
    @media (pointer: coarse) {
        .bar {
            height: 2.75rem;
        }
        .bar__action {
            height: 2.75rem;
            min-width: 2.75rem;
        }
    }
</style>
