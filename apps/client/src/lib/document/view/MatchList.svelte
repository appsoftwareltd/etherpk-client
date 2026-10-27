<script lang="ts">
    /**
     * The [[Match List]] at the foot of a document View (ADR 0153): one row per line holding a
     * [[Match]], with its line number and the matches marked, and, while the replacement field is
     * shown, each match struck through with what would replace it. A row whose match a replace keeps
     * (one of the page's names, a frontmatter delimiter) says so.
     *
     * A listbox: Up and Down move through the rows, Enter goes to the row's first match and leaves
     * focus here, a click does the same, and Esc hands focus back to the box. The row of the current
     * match is marked, and kept in view as F3 and F4 move it. The strip's height can be changed by
     * dragging its top edge, or from the keyboard on that edge.
     */
    import { tick } from "svelte";

    import { FIND_HOST_ATTRIBUTE } from "../find/find-events";
    import { type MatchLine, rowPieces } from "../find/find-matches";
    import { replacementFor } from "../find/find-replace";
    import type { FindController, FindSnapshot } from "../find/find-controller";

    let {
        find,
        controller,
        id,
        onescape,
    }: {
        find: FindSnapshot;
        controller: FindController;
        id: string;
        /** Esc in the list: focus goes back to the box. */
        onescape: () => void;
    } = $props();

    const uid = $props.id();
    const rowId = (index: number) => `${uid}-row-${index}`;

    /** The row holding the current match. */
    const currentRow = $derived(find.current < 0 ? -1 : find.rows.findIndex((row) => row.line === find.matches[find.current]?.line));
    /** The row Up and Down have moved to, while focus is in the list. */
    let keyed = $state<number | null>(null);
    const activeRow = $derived(keyed ?? currentRow);

    const summary = $derived.by(() => {
        const matches = find.matches.length;
        const lines = new Set(find.matches.map((match) => match.line)).size;
        const counted = `${matches.toLocaleString("en-GB")} ${matches === 1 ? "match" : "matches"} on ${lines.toLocaleString("en-GB")} ${lines === 1 ? "line" : "lines"}.`;
        return find.truncated ? `${counted} Showing the first ${find.rows.length.toLocaleString("en-GB")} lines.` : counted;
    });

    /** The replacements to preview on `row`, or null while no replacement is shown. */
    function replacementsFor(row: MatchLine): (string | null)[] | null {
        if (!find.replaceShown || !find.writable) return null;
        const query = { search: find.search, replace: find.replace, ...find.options };
        return row.matches.map((_, i) => {
            const match = find.matches[row.first + i];
            return match && !match.keep ? replacementFor(query, match) : null;
        });
    }

    let list: HTMLElement | undefined = $state();

    /** Keep the active row in view as it moves. */
    function scrollActiveIntoView(): void {
        if (activeRow < 0) return;
        list?.querySelector(`#${CSS.escape(rowId(activeRow))}`)?.scrollIntoView({ block: "nearest" });
    }
    $effect(() => {
        void activeRow;
        void tick().then(scrollActiveIntoView);
    });

    function onKeydown(event: KeyboardEvent): void {
        if (find.rows.length === 0) return;
        const from = activeRow < 0 ? 0 : activeRow;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            keyed = Math.min(find.rows.length - 1, Math.max(0, activeRow < 0 ? 0 : from + step));
        } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            keyed = event.key === "Home" ? 0 : find.rows.length - 1;
        } else if (event.key === "Enter") {
            event.preventDefault();
            controller.goTo(find.rows[from].first);
            keyed = null;
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            keyed = null;
            onescape();
        }
    }

    // The strip's height, which the top edge changes. Kept for the View's life.
    const MIN_HEIGHT = 96;
    let height = $state(176);
    let maxHeight = $state(480);
    let section: HTMLElement | undefined = $state();

    function clampHeight(next: number): number {
        return Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, next)));
    }

    /**
     * At most two thirds of the View, so the text above stays readable. The View is the find host
     * the strip sits in, not the strip's own wrapper, which is only as tall as the strip.
     */
    function measureMax(): void {
        const view = section?.closest(`[${FIND_HOST_ATTRIBUTE}]`);
        if (view) maxHeight = Math.max(MIN_HEIGHT, Math.floor(view.clientHeight * 0.66));
    }

    function startResize(event: PointerEvent): void {
        if (event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        // A View made shorter since the last drag can leave the strip above the new limit. Keep the
        // limit at the strip's height for this drag, so it does not jump away from the pointer.
        measureMax();
        maxHeight = Math.max(maxHeight, startHeight);
        const handle = event.currentTarget as HTMLElement;
        handle.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) => (height = clampHeight(startHeight + startY - e.clientY));
        const end = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    function resizeKey(event: KeyboardEvent): void {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        measureMax();
        height = clampHeight(height + (event.key === "ArrowUp" ? 24 : -24));
    }
</script>

<section bind:this={section} {id} class="match-list" style:height="{height}px" aria-label="Matches" data-testid="match-list">
    <!-- A window splitter (WAI-ARIA): a focusable separator whose value is the strip's height. Svelte
         reads every separator as static, but a focusable one with a value is a control. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
        class="match-list__edge"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Height of the list of matches"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxHeight}
        tabindex="0"
        onpointerdown={startResize}
        onkeydown={resizeKey}
    ></div>
    <header class="match-list__header">
        <p class="match-list__summary" data-testid="match-list-summary">{find.search === "" ? "Type to find in this document." : find.matches.length === 0 ? "No matches." : summary}</p>
        <button type="button" class="match-list__hide" data-testid="match-list-hide" onclick={() => controller.setListShown(false)}>Hide</button>
    </header>
    {#if find.rows.length > 0}
        <div
            bind:this={list}
            class="match-list__rows"
            role="listbox"
            tabindex="0"
            aria-label="Matching lines"
            aria-activedescendant={activeRow >= 0 ? rowId(activeRow) : undefined}
            onkeydown={onKeydown}
            onblur={() => (keyed = null)}
            data-testid="match-list-rows"
        >
            {#each find.rows as row, index (row.line)}
                <!-- Each row is an option of the listbox, which holds the focus and the keys and names the
                     active row with aria-activedescendant, so a row takes no focus of its own. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
                <div
                    id={rowId(index)}
                    class={["match-list__row", index === currentRow && "match-list__row--current", index === activeRow && "match-list__row--active"]}
                    role="option"
                    aria-selected={index === currentRow}
                    data-testid="match-list-row"
                    data-line={row.line}
                    onclick={() => {
                        keyed = null;
                        controller.goTo(row.first);
                    }}
                >
                    <span class="match-list__line" aria-hidden="true">{row.line}</span>
                    <span class="match-list__text">
                        <span class="match-list__sr">Line {row.line}: </span>
                        {#each rowPieces(row, replacementsFor(row)) as piece, p (p)}
                            {#if piece.kind === "match"}<mark class="match-list__match">{piece.text}</mark>{:else if piece.kind === "old"}<del class="match-list__old">{piece.text}</del>{:else if piece.kind === "new"}<ins class="match-list__new">{piece.text}</ins>{:else}{piece.text}{/if}
                        {/each}
                    </span>
                    {#if row.keep}
                        <span class="match-list__kept">{row.keep === "name" ? "Page name, kept" : "Delimiter, kept"}</span>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</section>

<style>
    .match-list {
        position: relative;
        flex: none;
        display: flex;
        flex-direction: column;
        min-height: 6rem;
        border-top: 1px solid var(--gk-border-strong);
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        font-size: 0.875rem;
    }
    /* The top edge, which changes the strip's height: a band a pointer can take hold of. */
    .match-list__edge {
        position: absolute;
        top: -4px;
        left: 0;
        right: 0;
        height: 8px;
        cursor: ns-resize;
        z-index: 1;
        touch-action: none;
    }
    .match-list__edge:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -3px;
    }
    .match-list__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.25rem 0.5rem 0.25rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .match-list__summary {
        margin: 0;
        color: var(--gk-text-muted);
    }
    .match-list__hide {
        flex-shrink: 0;
        padding: 0.125rem 0.5rem;
        border-radius: 0.25rem;
        color: var(--gk-control-text);
        cursor: pointer;
    }
    .match-list__hide:hover {
        background: var(--gk-control-hover);
    }
    .match-list__hide:focus-visible,
    .match-list__rows:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    .match-list__rows {
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 0.25rem 0;
    }
    .match-list__row {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        padding: 0.1875rem 0.75rem;
        cursor: pointer;
        white-space: pre;
    }
    .match-list__row:hover {
        background: var(--gk-control-hover);
    }
    .match-list__row--current {
        background: var(--gk-selection);
        color: var(--gk-text-strong);
    }
    /* Muted ink falls under 4.5:1 on the selection tint in the dark theme. */
    .match-list__row--current .match-list__line,
    .match-list__row--current .match-list__kept {
        color: var(--gk-text-default);
    }
    .match-list__row--active {
        box-shadow: inset 2px 0 0 var(--gk-accent);
    }
    .match-list__line {
        flex-shrink: 0;
        min-width: 3ch;
        text-align: right;
        color: var(--gk-text-muted);
        font-variant-numeric: tabular-nums;
    }
    .match-list__text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: var(--gk-mono);
    }
    .match-list__match {
        background: var(--gk-find-current);
        color: inherit;
        border-radius: 2px;
    }
    .match-list__old {
        background: var(--gk-danger-surface);
        color: inherit;
    }
    .match-list__new {
        background: var(--gk-success-surface);
        color: inherit;
        text-decoration: none;
    }
    .match-list__kept {
        flex-shrink: 0;
        color: var(--gk-text-muted);
        font-style: italic;
    }
    /* Read by a screen reader only: which line a row is, since the number beside it is hidden. */
    .match-list__sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
    }
</style>
