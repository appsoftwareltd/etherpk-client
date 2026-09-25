<script lang="ts">
    /**
     * The [[Search]] modal: name matching and text matching, run separately, stacked.
     *
     * The layout is shaped by one fact (see `search.ts`): names are answered synchronously
     * and text is a worker round trip, so names always paint first. Left alone, the instant
     * group would push the slow one — the reason the modal exists — below the fold on every
     * keystroke. Two things stop that: the Names group is capped at five rows per page, and
     * the Text group reserves its first page's height as a skeleton before anything arrives.
     */
    import { untrack } from "svelte";

    import LoadingSweep from "$lib/components/LoadingSweep.svelte";
    import { getActiveLayoutController } from "$lib/layout";
    import {
        namePageCount,
        namePageRows,
        pageTurnFor,
        stepSearchHighlight,
        type SearchController,
        type SearchState,
    } from "../search";
    import { revealLine } from "../reveal";
    import { tryGetActiveEventBus } from "$lib/surface";
    import { iconSvg } from "$lib/surface/icons";

    const { controller }: { controller: SearchController } = $props();

    let search = $state<SearchState>(untrack(() => controller.getState()));
    let input = $state<HTMLInputElement>();
    let results = $state<HTMLDivElement>();
    /**
     * The highlighted result, or `null` for the search box itself: nothing highlighted, the
     * caret in the field. The box is where a search starts and where a query edit or a click in
     * the field returns to; Up from the top result goes back to it (`stepSearchHighlight`).
     *
     * Which one it is decides what the keys mean. In the box, Left and Right move the caret and
     * Enter opens the top result, which shows an Enter hint to say so. On a result, Left and
     * Right turn its group's page and Enter opens that result.
     */
    let activeIndex = $state<number | null>(null);
    /**
     * Whether the highlight last moved by KEY rather than by pointer. Only keyboard movement
     * scrolls: the pointer is already in view by definition, and scrolling under a moving
     * mouse makes the list run away from the cursor.
     */
    let movedByKey = false;
    /**
     * What had focus when Search opened, handed back when it is dismissed: the Quick Find box it
     * was opened from, caret and all, or the editor. Opening a result hands nothing back, because
     * the document it opens takes focus.
     */
    let returnFocusTo: HTMLElement | null = null;

    /**
     * The mouse highlights a row by MOVING onto it, never by a row arriving under a still
     * pointer. Rows slide under a stationary mouse all the time - the list renders where the
     * pointer rests, and arrowing scrolls it - and the browser dispatches `pointerenter` for
     * them, so a row that took the highlight on enter would steal it from the keyboard (and
     * from the box). `pointermove` fires only for real movement.
     */
    function pointRow(index: number) {
        activeIndex = index;
    }

    // Returning the unsubscribe makes it the effect's cleanup, so a controller swap (never
    // expected, but the prop is reactive) re-subscribes instead of leaking.
    $effect(() =>
        controller.subscribe((next) => {
            const queryChanged = next.query !== untrack(() => search.query);
            search = next;
            // A query change returns to the box, and so does closing. Text rows are not
            // selectable until they land, so an arrow press during the gap cannot select a row
            // about to be replaced.
            if (queryChanged || !next.open) activeIndex = null;
        }),
    );

    const nameRows = $derived(namePageRows(search));
    const namePages = $derived(namePageCount(search));

    /**
     * One continuous selection across BOTH groups — ArrowDown from the last name row enters
     * the text results. A name row opens a document; a text hit opens one at the block that
     * matched, which is why the two carry different payloads.
     */
    type Selectable =
        | { kind: "name"; target: string }
        | { kind: "hit"; target: string; line: number };

    const selectable = $derived.by<Selectable[]>(() => {
        const items: Selectable[] = nameRows.map((row) => ({ kind: "name", target: row.target }));
        for (const group of search.textGroups) {
            for (const hit of group.hits) {
                items.push({ kind: "hit", target: group.concept, line: hit.line });
            }
        }
        return items;
    });

    /** Index of the first text hit, so the template can mark the right row active. */
    const hitOffset = $derived(nameRows.length);

    // Results can change under a stationary highlight — the index catching up, a collaborator's
    // edit arriving — and a highlight must not point past the end. With nothing left at all, it
    // goes back to the box.
    $effect(() => {
        const count = selectable.length;
        if (activeIndex !== null && activeIndex >= count) {
            activeIndex = count > 0 ? count - 1 : null;
        }
    });

    function choose(item: Selectable | undefined) {
        if (!item) return;
        // Close FIRST: navigation must not be able to leave the modal covering the document
        // it just opened, whatever happens downstream.
        controller.close();
        returnFocusTo = null;
        tryGetActiveEventBus()?.emit("search:closed", { outcome: "opened" });
        if (item.kind === "hit") revealLine(item.target, item.line);
        getActiveLayoutController().openView({ kind: "document", target: item.target });
    }

    /** Escape, or a click on the backdrop: close, and give focus back to where it came from. */
    function dismiss() {
        const target = returnFocusTo;
        returnFocusTo = null;
        // Closes without first clearing the query — reopening restores it anyway.
        controller.close();
        tryGetActiveEventBus()?.emit("search:closed", { outcome: "dismissed" });
        // It had focus a moment ago, so it is already on screen: nothing to scroll to.
        if (target?.isConnected) target.focus({ preventScroll: true });
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
            return;
        }
        // An IME confirms a composition with Enter; that keystroke belongs to the IME.
        if (event.isComposing) return;
        if (event.key === "Enter") {
            event.preventDefault();
            // From the box, the top result: the one wearing the Enter hint.
            choose(selectable[activeIndex ?? 0]);
            return;
        }
        if (selectable.length === 0) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // Claimed in the box too: Down from anywhere in the text goes to the top result,
            // rather than first moving the caret to the end as a text field would.
            event.preventDefault();
            const from = activeIndex;
            activeIndex = stepSearchHighlight(
                from,
                selectable.length,
                event.key === "ArrowDown" ? 1 : -1,
            );
            if (activeIndex !== null) {
                // Only when it moved. A press against the bottom changes nothing, and a flag left
                // set would make the next HOVER scroll the list.
                if (activeIndex !== from) movedByKey = true;
            } else if (from !== null && input) {
                // Up from the top result: back in the box, ready to carry on typing.
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
        } else if (
            (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
            activeIndex !== null &&
            // Shift+Arrow and the word-jump chords stay with the field.
            !(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
        ) {
            // Claimed even at the first or last page, so the caret does not move instead.
            event.preventDefault();
            turnPage(activeIndex, event.key === "ArrowRight" ? 1 : -1);
        }
    }

    /**
     * Turn the page of the group the highlight is in, and put the highlight on that group's
     * first row so the new page reads from the top. A turned text page is a worker round trip:
     * the old page stays on screen, highlighted at its first hit, until the new one lands in
     * the same place.
     */
    function turnPage(from: number, step: 1 | -1) {
        const turn = pageTurnFor(search, from, step);
        if (!turn) return;
        if (turn.group === "names") controller.setNamePage(turn.page);
        else controller.setTextPage(turn.page);
        const first = turn.group === "names" ? 0 : hitOffset;
        if (from !== first) {
            movedByKey = true;
            activeIndex = first;
        }
    }

    /**
     * Keep the highlighted row in view. Focus stays in the input while the arrows move the
     * highlight, so nothing scrolls the list on its own — without this the selection walks off
     * the bottom of the panel and the last results are unreachable by keyboard.
     *
     * `block: "nearest"` scrolls the minimum needed, so a row already visible does not jerk the
     * list; the rows carry a `scroll-margin` so "nearest" clears the sticky group headers
     * rather than tucking the row underneath one.
     */
    $effect(() => {
        const index = activeIndex;
        if (!movedByKey || index === null) return;
        movedByKey = false;
        results
            ?.querySelector(`[data-search-index="${index}"]`)
            ?.scrollIntoView({ block: "nearest" });
    });

    // Once per OPENING, not per state change. `search` is replaced wholesale on every
    // keystroke, so an unguarded effect re-selected the whole field between characters and
    // each one overwrote the last — typing "quokka" left "a".
    let focusedForThisOpening = false;
    $effect(() => {
        if (!search.open) {
            focusedForThisOpening = false;
            return;
        }
        if (focusedForThisOpening || !input) return;
        focusedForThisOpening = true;
        // Read before the field takes focus. The body is not somewhere to go back to.
        const previous = document.activeElement;
        returnFocusTo =
            previous instanceof HTMLElement && previous !== document.body ? previous : null;
        input.focus();
        // Selected, not merely inserted: a query handed over from Quick Find is usually one
        // the user wants to amend, so typing replaces it and → keeps it.
        input.select();
    });

    const countLabel = $derived(
        search.textCountCapped ? `${search.textCount}+` : `${search.textCount}`,
    );
</script>

{#if search.open}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="search__scrim" data-testid="search-modal" onclick={dismiss}>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="search__panel"
            role="dialog"
            tabindex="-1"
            aria-modal="true"
            aria-label="Search"
            onclick={(event) => event.stopPropagation()}
        >
            <input
                bind:this={input}
                data-testid="search-input"
                class="search__input"
                placeholder="Search this graph…"
                aria-label="Search this graph"
                autocomplete="off"
                value={search.query}
                oninput={(event) => controller.setQuery(event.currentTarget.value)}
                onkeydown={onKeydown}
                onpointerdown={() => (activeIndex = null)}
            />

            <div class="search__results" bind:this={results}>
                <!-- ── Names ──────────────────────────────────────────────── -->
                <section data-testid="search-names">
                    <header class="search__group-head">
                        <h2>Names</h2>
                        {#if search.nameBuilding}
                            <span class="search__muted" data-testid="search-names-building">
                                Still indexing this graph
                            </span>
                        {:else}
                            <span class="search__muted">{search.nameTotal}</span>
                        {/if}
                        {#if namePages > 1}
                            <span class="search__pager">
                                <button
                                    type="button"
                                    data-testid="search-names-prev"
                                    aria-label="Previous page of names"
                                    disabled={search.namePage === 0}
                                    onclick={() => controller.setNamePage(search.namePage - 1)}>‹</button
                                >
                                <span data-testid="search-names-page">{search.namePage + 1} / {namePages}</span>
                                <button
                                    type="button"
                                    data-testid="search-names-next"
                                    aria-label="Next page of names"
                                    disabled={search.namePage >= namePages - 1}
                                    onclick={() => controller.setNamePage(search.namePage + 1)}>›</button
                                >
                            </span>
                        {/if}
                    </header>
                    <ul>
                        {#each nameRows as row, index (row.kind + row.label)}
                            <li>
                                <button
                                    type="button"
                                    data-testid="search-name-row"
                                    data-kind={row.kind}
                                    data-search-index={index}
                                    class="search__row"
                                    class:search__row--active={index === activeIndex}
                                    class:search__row--draft={row.kind === "draft"}
                                    onpointermove={() => pointRow(index)}
                                    onclick={() => choose(selectable[index])}
                                >
                                    <span
                                        class="search__row-label"
                                        class:search__row-label--faint={row.kind === "draft" ||
                                            row.kind === "pageless"}>{row.label}</span
                                    >
                                    {#if row.protected}
                                        <!-- The tab strip's padlock, minus its state: whether the
                                             document is READABLE is per graph and belongs on the
                                             tab, not on a jump list. Constant in-repo markup from
                                             the icon table, never document content. -->
                                        <span class="search__padlock" data-testid="search-name-protected">
                                            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                            {@html iconSvg("lock", { size: 13, label: "Protected document" })}
                                        </span>
                                    {/if}
                                    {#if row.kind === "draft"}
                                        <!--
                                            The row itself is the button, so the label is drawn as
                                            one rather than nested: a button-in-button is invalid
                                            HTML and would split the click target.
                                        -->
                                        <span class="search__new-page" data-testid="search-new-page"
                                            >+ {row.detail}</span
                                        >
                                    {:else}
                                        <span class="search__muted">{row.detail}</span>
                                    {/if}
                                    {#if activeIndex === null && index === 0}
                                        <!--
                                            What Enter opens from the box. A name row is always
                                            the top result while there is a query: Names offers
                                            at least the create row for any text. Hidden from
                                            assistive tech, where it would only repeat "Enter"
                                            inside every announcement of the row.
                                        -->
                                        <kbd class="search__enter-hint" data-testid="search-enter-hint" aria-hidden="true"
                                            >Enter</kbd
                                        >
                                    {/if}
                                </button>
                            </li>
                        {:else}
                            <li class="search__empty" data-testid="search-names-empty">
                                {search.query.trim() === "" ? "Type to search." : "No names match."}
                            </li>
                        {/each}
                    </ul>
                </section>

                <!-- ── Text ───────────────────────────────────────────────── -->
                <section data-testid="search-text">
                    <header class="search__group-head">
                        <h2>Text</h2>
                        {#if search.textStatus.kind === "ready"}
                            <span class="search__muted" data-testid="search-text-count"
                                >{countLabel}</span
                            >
                        {/if}
                        {#if search.textStatus.kind === "ready" && (search.textPage > 0 || search.textHasMore)}
                            <span class="search__pager">
                                <button
                                    type="button"
                                    data-testid="search-text-prev"
                                    aria-label="Previous page of text results"
                                    disabled={search.textPage === 0}
                                    onclick={() => controller.setTextPage(search.textPage - 1)}>‹</button
                                >
                                <span data-testid="search-text-page">{search.textPage + 1}</span>
                                <!-- `textHasMore` describes the page on screen, so a second
                                     click before the first page lands must not step past it. -->
                                <button
                                    type="button"
                                    data-testid="search-text-next"
                                    aria-label="Next page of text results"
                                    disabled={!search.textHasMore}
                                    onclick={() => {
                                        if (search.textShownPage === search.textPage) {
                                            controller.setTextPage(search.textPage + 1);
                                        }
                                    }}>›</button
                                >
                            </span>
                        {/if}
                    </header>

                    {#if search.textStatus.kind === "building"}
                        <div class="search__skeleton" data-testid="search-text-building" role="status">
                            <div class="search__waiting">
                                <LoadingSweep label="Indexing this graph" />
                                <span>
                                    Still indexing this graph ({search.textStatus.done.toLocaleString()}
                                    of {search.textStatus.total.toLocaleString()}). Text results are
                                    hidden until it finishes, so a search cannot wrongly say "not
                                    found".
                                </span>
                            </div>
                        </div>
                    {:else if search.textStatus.kind === "too-short"}
                        <p class="search__empty" data-testid="search-text-short">
                            Type at least two characters to search inside your notes.
                        </p>
                    {:else if search.textStatus.kind === "failed"}
                        <p class="search__empty" data-testid="search-text-failed">
                            {search.textStatus.message}
                        </p>
                    {:else if search.textStatus.kind === "loading"}
                        <!-- Reserved height, so the instant Names group cannot push the text
                             results below the fold the moment they arrive. -->
                        <div class="search__skeleton" data-testid="search-text-skeleton" role="status">
                            <div class="search__waiting">
                                <LoadingSweep label="Searching your notes" />
                                <span>Searching your notes…</span>
                            </div>
                            {#each Array.from({ length: 3 }) as _, row (row)}
                                <div class="search__skeleton-row"></div>
                            {/each}
                        </div>
                    {:else if search.textStatus.kind === "idle"}
                        <p class="search__empty">Type to search inside your notes.</p>
                    {:else if search.textGroups.length === 0}
                        <p class="search__empty" data-testid="search-text-empty">
                            No notes contain that.
                        </p>
                    {:else}
                        <ul>
                            {#each search.textGroups as group, groupIndex (group.concept)}
                                {@const before = search.textGroups
                                    .slice(0, groupIndex)
                                    .reduce((n, g) => n + g.hits.length, 0)}
                                <li class="search__group" data-testid="search-text-group">
                                    <p class="search__group-title">
                                        <span>{group.concept}</span>
                                        <span class="search__muted"
                                            >{group.matches}
                                            {group.matches === 1 ? "match" : "matches"}</span
                                        >
                                    </p>
                                    {#each group.hits as hit, hitIndex (hit.line)}
                                        {@const index = hitOffset + before + hitIndex}
                                        <button
                                            type="button"
                                            data-testid="search-text-hit"
                                            data-search-index={index}
                                            class="search__row search__hit"
                                            class:search__row--active={index === activeIndex}
                                            onpointermove={() => pointRow(index)}
                                            onclick={() => choose(selectable[index])}
                                        >
                                            {#if hit.breadcrumb.length > 0}
                                                <span class="search__crumb"
                                                    >{hit.breadcrumb.join(" › ")}</span
                                                >
                                            {/if}
                                            <span class="search__snippet">
                                                <!-- Segments, never HTML: this is the user's
                                                     own text and the one place an injection
                                                     would land. -->
                                                {#each hit.snippet as segment, part (part)}
                                                    {#if segment.match}
                                                        <mark>{segment.text}</mark>
                                                    {:else}{segment.text}{/if}
                                                {/each}
                                            </span>
                                        </button>
                                    {/each}
                                    {#if group.matches > group.hits.length}
                                        <p class="search__more" data-testid="search-text-more">
                                            + {group.matches - group.hits.length} more in this document
                                        </p>
                                    {/if}
                                </li>
                            {/each}
                        </ul>
                    {/if}

                    {#if search.hasEncryptedContent}
                        <p class="search__note" data-testid="search-encrypted-note">
                            Encrypted content is not searched.
                        </p>
                    {/if}
                </section>
            </div>
        </div>
    </div>
{/if}

<style>
    .search__scrim {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        justify-content: center;
        padding: 8vh 1rem 1rem;
        background: rgb(0 0 0 / 0.35);
    }
    .search__panel {
        display: flex;
        width: min(46rem, 100%);
        max-height: 80vh;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 0.25);
    }
    .search__input {
        border: 0;
        border-bottom: 1px solid var(--gk-border-soft);
        background: transparent;
        padding: 0.875rem 1rem;
        font-size: 1rem;
        color: var(--gk-text-strong);
    }
    .search__input:focus {
        outline: none;
    }
    .search__results {
        min-height: 0;
        overflow-y: auto;
    }
    .search__group-head {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-2);
        padding: 0.375rem 1rem;
    }
    /* Nothing here is below 14px, the app's minimum for text a person reads. Secondary text is
       set apart by colour and weight instead of size. */
    .search__group-head h2 {
        font-size: 0.875rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--gk-text-subtle);
    }
    .search__muted {
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
    }
    .search__pager {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        margin-left: auto;
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
    }
    .search__pager button {
        border-radius: 0.25rem;
        padding: 0 0.375rem;
        cursor: pointer;
    }
    .search__pager button:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .search__row {
        display: flex;
        width: 100%;
        align-items: baseline;
        gap: 0.5rem;
        padding: 0.375rem 1rem;
        text-align: left;
        font-size: 0.875rem;
    }
    .search__row--active {
        background: var(--gk-surface-2);
    }
    /* Clears the sticky group header when scrollIntoView({ block: "nearest" }) brings a row
       up from below, and leaves a row's group title visible when coming back down. */
    .search__row {
        scroll-margin-block: 2.5rem;
    }
    .search__row-label {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .search__row-label--faint {
        font-style: italic;
    }
    .search__padlock {
        flex-shrink: 0;
        display: inline-flex;
        align-self: center;
        color: var(--gk-text-subtle);
    }
    /* The draft row carries a real-sized button, so it is taller than a match row and centres
       its label on the button rather than sharing the text baseline. */
    .search__row--draft {
        align-items: center;
        padding-block: 0.5rem;
    }
    /* Drawn as a button so the draft row reads as "create this", not as another match. */
    .search__new-page {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--gk-accent);
        border-radius: 0.375rem;
        padding: 0.3125rem 0.75rem;
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1.25;
        color: var(--gk-accent);
        white-space: nowrap;
    }
    /* A key cap rather than bare text, so it does not read as part of the row's detail. */
    .search__enter-hint {
        flex-shrink: 0;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.25rem;
        padding: 0 0.375rem;
        font-family: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        color: var(--gk-text-subtle);
    }
    .search__row:hover .search__new-page,
    .search__row--active .search__new-page {
        background: var(--gk-accent);
        color: var(--gk-surface-0);
    }
    .search__group {
        border-bottom: 1px solid var(--gk-border-soft);
        padding: 0.375rem 0;
    }
    .search__group-title {
        display: flex;
        gap: 0.5rem;
        padding: 0.25rem 1rem;
        font-size: 0.875rem;
        font-weight: 600;
    }
    .search__group-title span:last-child {
        margin-left: auto;
        font-weight: 400;
    }
    .search__hit {
        flex-direction: column;
        gap: 0.125rem;
        padding-left: 1.75rem;
    }
    .search__crumb {
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
    }
    .search__snippet {
        font-size: 0.875rem;
        line-height: 1.4;
        /* Two lines of context, as the design says; a multi-line bullet is one block. */
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
    .search__snippet mark {
        background: var(--gk-accent-soft, #fde68a);
        color: inherit;
    }
    .search__more,
    .search__empty,
    .search__note {
        padding: 0.375rem 1rem;
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
    }
    .search__more {
        padding-left: 1.75rem;
    }
    .search__note {
        border-top: 1px solid var(--gk-border-soft);
    }
    .search__skeleton {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
    }
    .search__waiting {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
    }
    .search__skeleton-row {
        height: 2.5rem;
        border-radius: 0.25rem;
        background: var(--gk-surface-2);
    }
    @media (prefers-reduced-motion: no-preference) {
        .search__skeleton-row {
            animation: search-pulse 1.4s ease-in-out infinite;
        }
    }
    @keyframes search-pulse {
        50% {
            /* Deep enough to read as movement against a subtle surface colour; the old 0.55
               was very nearly invisible. */
            opacity: 0.35;
        }
    }
</style>
