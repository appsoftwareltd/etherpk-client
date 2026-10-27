<script lang="ts">
    /**
     * The [[Find and Replace]] box over the top right of a document View (ADR 0153): the query,
     * the three match options, the count, next and previous, the [[Match List]]'s switch and
     * close, and below them, once shown, the replacement and its two buttons.
     *
     * Everything it shows is the controller's snapshot, and every control calls the controller,
     * so the rules are in `find-controller.ts`, where they are unit-tested. What this adds is the
     * keyboard: Enter and Shift+Enter step, Up and Down walk the session's earlier queries, Alt+C,
     * Alt+W and Alt+R switch the options (taking Alt+R from the right sidebar's toggle while focus is
     * here), Enter in the replacement replaces one and Mod+Alt+Enter all, and Esc closes.
     *
     * States: no query (no count), no matches (said in place of the count), an invalid regular
     * expression (said under the field, which is marked invalid), a locked body (said in a note),
     * a replace waiting on the rename question (said after a moment, the buttons doing nothing),
     * and what the last replace did. The count is announced once typing stops, never per key.
     */
    import { formatChordHint, isApplePlatform } from "$lib/surface";

    import type { FindOptions } from "../find/find-matches";
    import type { FindController, FindSnapshot } from "../find/find-controller";

    let {
        find,
        controller,
        entry = null,
        listId,
    }: {
        find: FindSnapshot;
        controller: FindController;
        /** In a Journal Roll, the older day find is in, to name it. Null for the tab's own entry. */
        entry?: string | null;
        /** The Match List's id, which the list switch controls. */
        listId: string;
    } = $props();

    const uid = $props.id();
    const apple = isApplePlatform();
    /** The chords as this keyboard writes them: Ctrl+H has no Mac equivalent the browser lets through. */
    const replaceChord = formatChordHint(apple ? "Mod+Alt+F" : "Ctrl+H", apple);
    const replaceAllChord = formatChordHint("Mod+Alt+Enter", apple);
    const replaceId = `${uid}-replace`;
    const errorId = `${uid}-error`;
    const countId = `${uid}-count`;

    /** A derived, so the attachment below runs when the request changes, not on every snapshot. */
    const focusRequest = $derived(find.focusRequest);

    /** The query field takes focus, its text selected, each time the box is asked to (Mod+F again). */
    function focusOnRequest(input: HTMLInputElement): void {
        if (focusRequest === 0) return;
        input.focus();
        input.select();
    }

    const count = $derived.by(() => {
        if (find.search === "" || find.error) return "";
        const total = find.matches.length;
        if (total === 0) return "No matches";
        return find.current >= 0 ? `${find.current + 1} of ${total.toLocaleString("en-GB")}` : `${total.toLocaleString("en-GB")} matches`;
    });

    /**
     * What a screen reader hears, in one polite region: the count once typing has stopped for a
     * moment, never per key (rule 8), and the outcome of a replace as it lands.
     */
    const settlingCount = $derived(count === "" || count === "No matches" ? count : `${find.matches.length} ${find.matches.length === 1 ? "match" : "matches"}`);
    // A timer is the one way to know typing has stopped, so the settled count is state an effect sets.
    let settledCount = $state("");
    $effect(() => {
        const text = settlingCount;
        const timer = setTimeout(() => (settledCount = text), 600);
        return () => clearTimeout(timer);
    });
    const announced = $derived(find.status ?? settledCount);

    const OPTIONS: { key: keyof FindOptions; label: string; text: string; code: string }[] = [
        { key: "caseSensitive", label: "Match case (Alt+C)", text: "Aa", code: "KeyC" },
        { key: "wholeWord", label: "Match whole word (Alt+W)", text: "ab", code: "KeyW" },
        { key: "regexp", label: "Use regular expression (Alt+R)", text: ".*", code: "KeyR" },
    ];

    /**
     * Alt+C, Alt+W and Alt+R switch an option, matched by the key's place on the keyboard, since
     * Option on a Mac types a character with it. Stopped here, so the window's own Alt chords
     * (Alt+R shows or hides the right sidebar) do not also run.
     */
    function optionKey(event: KeyboardEvent): boolean {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        const option = OPTIONS.find((o) => o.code === event.code);
        if (!option) return false;
        event.preventDefault();
        event.stopPropagation();
        controller.toggleOption(option.key);
        return true;
    }

    function onQueryKeydown(event: KeyboardEvent): void {
        if (event.isComposing || optionKey(event)) return;
        if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) controller.previous();
            else controller.next();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            controller.close({ focusEditor: true });
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            controller.stepHistory(event.key === "ArrowUp" ? -1 : 1);
        }
    }

    function onReplaceKeydown(event: KeyboardEvent): void {
        if (event.isComposing || optionKey(event)) return;
        if (event.key === "Enter") {
            event.preventDefault();
            if ((event.ctrlKey || event.metaKey) && event.altKey) void controller.replaceAll();
            else void controller.replaceOne();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            controller.close({ focusEditor: true });
        }
    }

    const nothingFound = $derived(find.matches.length === 0);
</script>

<div class="find" role="search" aria-label="Find in this document" data-testid="find-box">
    <!-- The order here is the Tab order: the find field, then the replace field and its two buttons,
         then the match options, the steps, the list switch and Close. The grid draws them in rows as
         before, the options over the right end of the find field. -->
    <div class="find__grid">
        <button
            type="button"
            class={["find__icon", "find__expand", find.replaceShown && "find__expand--open"]}
            aria-expanded={find.replaceShown}
            aria-controls={replaceId}
            aria-label={find.replaceShown ? "Hide replace" : "Show replace"}
            title={find.replaceShown ? "Hide replace" : `Show replace (${replaceChord})`}
            data-testid="find-toggle-replace"
            onclick={() => controller.showReplace(!find.replaceShown)}
        >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <div class="find__field find__field--query">
            <input
                {@attach focusOnRequest}
                class="find__input"
                type="text"
                value={find.search}
                oninput={(event) => controller.setSearch(event.currentTarget.value)}
                onkeydown={onQueryKeydown}
                placeholder="Find"
                aria-label="Find"
                aria-invalid={find.error ? true : undefined}
                aria-describedby={[find.error ? errorId : null, count ? countId : null].filter(Boolean).join(" ") || undefined}
                autocomplete="off"
                spellcheck="false"
                data-testid="find-input"
            />
        </div>

        {#if find.error}
            <p id={errorId} class="find__note find__note--error find__error" data-testid="find-error">The regular expression cannot be used: {find.error}</p>
        {/if}

        {#if find.replaceShown}
            {#if find.writable}
                <div class="find__field find__field--replace">
                    <input
                        id={replaceId}
                        class="find__input"
                        type="text"
                        value={find.replace}
                        oninput={(event) => controller.setReplace(event.currentTarget.value)}
                        onkeydown={onReplaceKeydown}
                        placeholder="Replace"
                        aria-label="Replace with"
                        autocomplete="off"
                        spellcheck="false"
                        data-testid="replace-input"
                    />
                </div>
                <div class="find__actions">
                    <button
                        type="button"
                        class="find__button"
                        disabled={nothingFound}
                        aria-disabled={find.busy || undefined}
                        title="Replace (Enter)"
                        data-testid="replace-one"
                        onclick={() => void controller.replaceOne()}
                    >Replace</button>
                    <button
                        type="button"
                        class="find__button"
                        disabled={nothingFound}
                        aria-disabled={find.busy || undefined}
                        title="Replace all ({replaceAllChord})"
                        data-testid="replace-all"
                        onclick={() => void controller.replaceAll()}
                    >Replace all</button>
                </div>
            {:else}
                <p id={replaceId} class="find__note find__replace-locked" data-testid="replace-locked">This document is locked. Unlock it to replace.</p>
            {/if}
        {/if}

        <div class="find__options">
            {#each OPTIONS as option (option.key)}
                <button
                    type="button"
                    class="find__option"
                    aria-pressed={find.options[option.key]}
                    aria-label={option.label}
                    title={option.label}
                    data-testid="find-option-{option.key}"
                    onclick={() => controller.toggleOption(option.key)}
                ><span aria-hidden="true" class={[option.key === "wholeWord" && "find__option-word"]}>{option.text}</span></button>
            {/each}
        </div>
        <span id={countId} class={["find__count", count === "No matches" && "find__count--none"]} data-testid="find-count">{count}</span>
        <button type="button" class="find__icon find__nav find__previous" aria-label="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)" disabled={nothingFound} data-testid="find-previous" onclick={() => controller.previous()}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M8 12.5v-9M4 7.5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button type="button" class="find__icon find__nav find__next" aria-label="Next match (Enter)" title="Next match (Enter)" disabled={nothingFound} data-testid="find-next" onclick={() => controller.next()}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M8 3.5v9M4 8.5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        <button
            type="button"
            class="find__icon find__nav find__list"
            aria-pressed={find.listShown}
            aria-controls={listId}
            aria-label="List the matches"
            title="List the matches"
            data-testid="find-toggle-list"
            onclick={() => controller.setListShown(!find.listShown)}
        >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M3 4.5h10M3 8h10M3 11.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
        <button type="button" class="find__icon find__close" aria-label="Close find (Esc)" title="Close (Esc)" data-testid="find-close" onclick={() => controller.close({ focusEditor: true })}>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        </button>
    </div>

    {#if find.bodyLocked}
        <p class="find__note" data-testid="find-locked">This document is locked. Find reads only its frontmatter until you unlock it.</p>
    {/if}
    {#if entry}
        <p class="find__note" data-testid="find-entry">Finding in {entry}.</p>
    {/if}
    {#if find.status}
        <p class="find__note" data-testid="find-status">{find.status}</p>
    {/if}
    <p class="find__announce" aria-live="polite" data-testid="find-announce">{announced}</p>
</div>

<style>
    .find {
        position: absolute;
        top: 0.5rem;
        right: calc(1rem + var(--gk-scrollbar-inset, 0px));
        z-index: 3;
        width: min(30rem, calc(100% - 2rem));
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.375rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        box-shadow: var(--gk-menu-shadow);
        font-size: 0.875rem;
    }
    /*
     * Three rows: the find field and the buttons beside it, an error, and the replace field with its
     * buttons. Rows after the first are spaced by a margin, not a gap, so a row that is empty (no
     * error, replace hidden) takes no room.
     */
    .find__grid {
        /* One match option button, which the end of the find field leaves room for. */
        --find-option: 1.75rem;
        /* The space between the option buttons and the field's border, the same on three sides. */
        --find-option-inset: 0.1875rem;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto auto auto auto auto;
        grid-template-areas:
            "expand query count previous next list close"
            ". error error error error error error"
            ". replace actions actions actions actions actions";
        column-gap: 0.125rem;
        align-items: center;
    }
    .find__expand {
        grid-area: expand;
    }
    .find__field--query,
    .find__options {
        grid-area: query;
    }
    .find__error {
        grid-area: error;
    }
    .find__field--replace {
        grid-area: replace;
    }
    .find__actions {
        grid-area: actions;
        display: flex;
        gap: 0.375rem;
        margin-left: 0.25rem;
    }
    .find__replace-locked {
        grid-row: replace;
        grid-column: replace-start / -1;
    }
    .find__count {
        grid-area: count;
    }
    .find__previous {
        grid-area: previous;
    }
    .find__next {
        grid-area: next;
    }
    .find__list {
        grid-area: list;
    }
    .find__close {
        grid-area: close;
    }
    .find__error,
    .find__field--replace,
    .find__actions,
    .find__replace-locked {
        margin-top: 0.25rem;
    }
    /* As tall as its row, so the option buttons drawn over its end fill it evenly. */
    .find__field {
        align-self: stretch;
        min-width: 0;
        display: flex;
        align-items: center;
        border: 1px solid var(--gk-control-border);
        border-radius: 0.375rem;
        background: var(--gk-field-bg);
    }
    .find__field:focus-within {
        border-color: var(--gk-field-focus);
        box-shadow: 0 0 0 1px var(--gk-field-focus);
    }
    .find__input {
        flex: 1;
        min-width: 0;
        border: 0;
        background: transparent;
        padding: 0.3125rem 0.5rem;
        font-size: 0.9375rem;
        color: var(--gk-field-text);
    }
    /* The query's text stops short of the option buttons over the field's end. */
    .find__field--query .find__input {
        padding-right: calc(3 * var(--find-option) + 2 * 0.125rem + var(--find-option-inset) + 0.375rem);
    }
    .find__input:focus {
        outline: none;
    }
    .find__input[aria-invalid="true"] {
        color: var(--gk-text-danger);
    }
    /* Over the find field's end, inside its border, the buttons filling its height less the inset. */
    .find__options {
        align-self: stretch;
        justify-self: end;
        display: flex;
        gap: 0.125rem;
        padding: calc(1px + var(--find-option-inset));
        padding-left: 0;
    }
    .find__option {
        min-width: var(--find-option);
        border-radius: 0.25rem;
        font-family: var(--gk-mono);
        font-size: 0.875rem;
        color: var(--gk-text-muted);
        cursor: pointer;
    }
    .find__option:hover {
        background: var(--gk-control-hover);
    }
    .find__option[aria-pressed="true"] {
        background: var(--gk-selection);
        color: var(--gk-text-strong);
        box-shadow: inset 0 0 0 1px var(--gk-accent);
    }
    .find__option-word {
        text-decoration: underline;
        text-underline-offset: 2px;
    }
    .find__count {
        min-width: 5.5rem;
        padding: 0 0.375rem;
        text-align: center;
        white-space: nowrap;
        color: var(--gk-text-muted);
        font-variant-numeric: tabular-nums;
    }
    .find__count--none {
        color: var(--gk-text-danger);
    }
    .find__icon {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        border-radius: 0.375rem;
        color: var(--gk-control-text);
        cursor: pointer;
    }
    .find__icon:hover:not(:disabled) {
        background: var(--gk-control-hover);
    }
    .find__icon:disabled {
        color: var(--gk-text-subtle);
        cursor: default;
    }
    .find__icon[aria-pressed="true"] {
        background: var(--gk-selection);
        color: var(--gk-text-strong);
    }
    .find__expand svg {
        transition: transform 150ms ease-out;
    }
    .find__expand--open svg {
        transform: rotate(90deg);
    }
    .find__button {
        flex-shrink: 0;
        height: 2rem;
        padding: 0 0.625rem;
        border: 1px solid var(--gk-control-border);
        border-radius: 0.375rem;
        background: var(--gk-surface-0);
        color: var(--gk-control-text);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
    }
    .find__button:hover:not(:disabled) {
        background: var(--gk-menu-hover);
    }
    .find__button:disabled {
        color: var(--gk-text-subtle);
        cursor: default;
    }
    .find__button[aria-disabled="true"] {
        cursor: progress;
    }
    .find button:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
    .find__note {
        margin: 0;
        padding: 0 0.375rem 0 2.125rem;
        line-height: 1.4;
        color: var(--gk-text-muted);
    }
    .find__note--error {
        color: var(--gk-text-danger);
    }
    /* In the grid, under the field they belong to, so no indent past the expand button. */
    .find__error,
    .find__replace-locked {
        padding: 0 0.375rem;
    }
    /* Read by a screen reader only: the count once typing has stopped. */
    .find__announce {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
    }
    /*
     * A phone (below the layout breakpoint): the width of the View, under its top edge, on two
     * lines, since nine controls at a finger's size do not fit across one. The query and Close
     * first, then the replace switch, the count, and the step and list buttons.
     */
    @media (max-width: 1023px) {
        .find {
            left: 0.5rem;
            right: 0.5rem;
            width: auto;
        }
        .find__grid {
            grid-template-columns: auto minmax(0, 1fr) auto auto auto;
            grid-template-areas:
                "query query query query close"
                "expand count previous next list"
                "error error error error error"
                "replace replace replace replace replace"
                "actions actions actions actions actions";
        }
        .find__expand,
        .find__count,
        .find__nav {
            margin-top: 0.25rem;
        }
        .find__count {
            min-width: 0;
            text-align: left;
        }
        .find__actions {
            margin-left: 0;
        }
        .find__note {
            padding-left: 0.375rem;
        }
    }
    @media (pointer: coarse) {
        .find__icon {
            width: 2.75rem;
            height: 2.75rem;
        }
        .find__button {
            height: 2.75rem;
        }
        .find__grid {
            --find-option: 2.25rem;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .find__expand svg {
            transition: none;
        }
    }
</style>
