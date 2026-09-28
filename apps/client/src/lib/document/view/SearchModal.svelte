<script lang="ts">
    /**
     * The [[Search]] modal: name matching and text matching, run separately, stacked.
     *
     * The layout is shaped by one fact (see `search.ts`): names are answered synchronously
     * and text is a worker round trip, so names always paint first. Left alone, the instant
     * group would push the slow one — the reason the modal exists — below the fold on every
     * keystroke. Two things stop that: the Names group is capped at five rows per page, and
     * the Text group reserves its first page's height as a skeleton before anything arrives.
     *
     * [[Property Filter]]s (ADR 0107) add two things around the box: a row of chips, one per
     * filter the query holds, and a suggestion list while a key or a key's value is typed. The
     * text in the box stays the only source of truth; a chip is a readout with a way to remove
     * its term, and a suggestion writes into the box.
     */
    import { tick, untrack } from "svelte";

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
    import type { PropertyValueInfo } from "../index-db";
    import { describePropertyFilter, removeSearchTerm, type PropertyFilterTerm } from "../search-query";
    import {
        applySearchSuggestion,
        keySuggestions,
        suggestionContext,
        valueSuggestions,
        type SearchSuggestion,
    } from "../search-suggest";
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
        if (suggestionKey(event)) {
            event.preventDefault();
            return;
        }
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
        // A restored query does not open the suggestion list by itself; typing does.
        suggestDismissed = true;
        suggestIndex = null;
        caret = search.query.length;
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

    // ── Property Filter suggestions ────────────────────────────────────────

    /** Where the caret is in the box, which decides what the suggestion list offers. */
    let caret = $state(0);
    /**
     * The suggestion the arrows have highlighted, or null: the list is showing, but Enter still
     * opens the top result until Down moves into it, so typing a word that happens to start a key
     * never changes what Enter does.
     */
    let suggestIndex = $state<number | null>(null);
    /** Esc closes the list for the term being typed; the next keystroke in the box reopens it. */
    let suggestDismissed = $state(true);
    let values = $state.raw<readonly PropertyValueInfo[]>([]);
    let valuesFor = $state<string | null>(null);

    const knownKeys = $derived(new Set(search.propertyKeys.map((info) => info.key.toLowerCase())));
    const suggestContext = $derived(search.open ? suggestionContext(search.query, caret, knownKeys) : null);
    const valueKey = $derived(suggestContext?.kind === "value" ? suggestContext.key.toLowerCase() : null);

    // The values a key has are a round trip, asked once per key per opening (the controller
    // caches them); a late answer for a key no longer being typed is dropped.
    $effect(() => {
        const key = valueKey;
        if (key === null) return;
        let live = true;
        void controller.propertyValues(key).then((list) => {
            if (!live) return;
            values = list;
            valuesFor = key;
        });
        return () => {
            live = false;
        };
    });

    const suggestions = $derived.by<SearchSuggestion[]>(() => {
        const context = suggestContext;
        if (!context) return [];
        if (context.kind === "key") return keySuggestions(context, search.propertyKeys);
        return valuesFor === context.key.toLowerCase() ? valueSuggestions(context, values) : [];
    });
    const showSuggestions = $derived(!suggestDismissed && suggestions.length > 0);

    function trackCaret(event: Event & { currentTarget: HTMLInputElement }) {
        caret = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
    }

    /** Write the suggestion into the box and put the caret where the next keystroke belongs. */
    async function accept(suggestion: SearchSuggestion | undefined) {
        const context = suggestContext;
        if (!suggestion || !context) return;
        const next = applySearchSuggestion(search.query, context, suggestion);
        suggestIndex = null;
        controller.setQuery(next.value);
        await tick();
        caret = next.caret;
        input?.focus();
        input?.setSelectionRange(next.caret, next.caret);
    }

    /** A chip's ×: take its term out of the box, and keep the caret in the box. */
    async function removeFilter(term: PropertyFilterTerm) {
        const next = removeSearchTerm(search.query, term);
        controller.setQuery(next);
        await tick();
        caret = next.length;
        input?.focus();
        input?.setSelectionRange(next.length, next.length);
    }

    /**
     * The suggestion list's keys, when it is showing. Returns true when the key was the list's.
     * Down enters the list and walks it, Up walks back and leaves it at the top, Enter or Tab
     * takes the highlighted row (Tab the first one when none is), and Esc closes the list
     * without closing Search.
     */
    function suggestionKey(event: KeyboardEvent): boolean {
        if (!showSuggestions || event.isComposing) return false;
        if (event.key === "Escape") {
            suggestDismissed = true;
            suggestIndex = null;
            return true;
        }
        if (event.key === "ArrowDown") {
            suggestIndex = suggestIndex === null ? 0 : Math.min(suggestIndex + 1, suggestions.length - 1);
            activeIndex = null;
            return true;
        }
        if (event.key === "ArrowUp" && suggestIndex !== null) {
            suggestIndex = suggestIndex === 0 ? null : suggestIndex - 1;
            return true;
        }
        if ((event.key === "Enter" && suggestIndex !== null) || (event.key === "Tab" && !event.shiftKey)) {
            void accept(suggestions[suggestIndex ?? 0]);
            return true;
        }
        return false;
    }

    /** The values a name row matched, as `key: value`, once per pair. */
    function propertyText(properties: { key: string; value: string }[]): string {
        return [...new Set(properties.map((p) => `${p.key}: ${p.value}`))].join(" · ");
    }
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
            <div class="search__box">
                <input
                    bind:this={input}
                    data-testid="search-input"
                    class="search__input"
                    placeholder="Search this graph…"
                    aria-label="Search this graph"
                    autocomplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showSuggestions}
                    aria-controls="search-suggestions"
                    aria-activedescendant={showSuggestions && suggestIndex !== null
                        ? `search-suggestion-${suggestIndex}`
                        : undefined}
                    value={search.query}
                    oninput={(event) => {
                        trackCaret(event);
                        suggestDismissed = false;
                        suggestIndex = null;
                        controller.setQuery(event.currentTarget.value);
                    }}
                    onkeydown={onKeydown}
                    onkeyup={trackCaret}
                    onclick={trackCaret}
                    onpointerdown={() => (activeIndex = null)}
                />
                {#if showSuggestions}
                    <!-- The combobox's list: keys go to the box (suggestionKey), so a row takes the
                         pointer only. pointerdown is cancelled so the box keeps focus and caret. -->
                    <ul
                        id="search-suggestions"
                        class="search__suggest"
                        role="listbox"
                        data-testid="search-suggestions"
                        aria-label={suggestContext?.kind === "value"
                            ? `Values of ${suggestContext.key}`
                            : "Property keys"}
                    >
                        {#each suggestions as suggestion, index (suggestion.kind + suggestion.text)}
                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                            <li
                                id="search-suggestion-{index}"
                                role="option"
                                aria-selected={index === suggestIndex}
                                data-testid="search-suggestion"
                                class={["search__suggestion", index === suggestIndex && "search__suggestion--active"]}
                                onpointerdown={(event) => event.preventDefault()}
                                onclick={() => void accept(suggestion)}
                            >
                                <span class="search__suggestion-text"
                                    >{suggestion.kind === "key" ? `${suggestion.text}:` : suggestion.text}</span
                                >
                                <span class="search__muted"
                                    >{suggestion.documents}
                                    {suggestion.documents === 1 ? "document" : "documents"}</span
                                >
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>

            {#if search.filterTerms.length > 0}
                <ul class="search__chips" aria-label="Property filters" data-testid="search-filter-chips">
                    {#each search.filterTerms as term (term.from)}
                        {@const label = describePropertyFilter(term.filter)}
                        <li class="search__chip" data-testid="search-filter-chip">
                            <span>{label}</span>
                            <button
                                type="button"
                                class="search__chip-remove"
                                data-testid="search-filter-chip-remove"
                                aria-label="Remove filter {label}"
                                onclick={() => void removeFilter(term)}>×</button
                            >
                        </li>
                    {/each}
                </ul>
            {/if}

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
                                    {#if row.properties && row.properties.length > 0}
                                        <span class="search__props" data-testid="search-name-properties"
                                            >{propertyText(row.properties)}</span
                                        >
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
                                {search.query.trim() === ""
                                    ? "Type to search."
                                    : search.filterTerms.length > 0
                                      ? "No documents match these filters."
                                      : "No names match."}
                            </li>
                        {/each}
                    </ul>
                </section>

                <!-- ── Text ───────────────────────────────────────────────── -->
                <!-- Filters and no words: there is nothing to match text against, and the names
                     group above is the whole answer. -->
                {#if search.textStatus.kind !== "hidden"}
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
                {/if}
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
    .search__box {
        position: relative;
        display: flex;
        flex-direction: column;
    }
    /* Over the results rather than above them, so the list opening and closing as keys are
       typed never moves the results under the pointer. */
    .search__suggest {
        position: absolute;
        top: 100%;
        left: 0.75rem;
        right: 0.75rem;
        z-index: 2;
        max-height: 18rem;
        overflow-y: auto;
        border: 1px solid var(--gk-border-soft);
        border-radius: 0.375rem;
        background: var(--gk-surface-1);
        box-shadow: 0 0.75rem 1.5rem rgb(0 0 0 / 0.2);
        padding: 0.25rem 0;
    }
    .search__suggestion {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        padding: 0.375rem 0.75rem;
        font-size: 0.875rem;
        cursor: pointer;
    }
    .search__suggestion:hover,
    .search__suggestion--active {
        background: var(--gk-surface-2);
    }
    .search__suggestion-text {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--gk-font-mono, ui-monospace, monospace);
    }
    .search__chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        border-bottom: 1px solid var(--gk-border-soft);
        padding: 0.5rem 1rem;
    }
    .search__chip {
        display: inline-flex;
        align-items: center;
        gap: 0.125rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 999px;
        background: var(--gk-surface-2);
        padding: 0 0.125rem 0 0.625rem;
        font-size: 0.875rem;
        color: var(--gk-text-default);
    }
    .search__chip-remove {
        display: inline-flex;
        min-width: 1.5rem;
        min-height: 1.5rem;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        font-size: 1rem;
        line-height: 1;
        color: var(--gk-text-subtle);
        cursor: pointer;
    }
    .search__chip-remove:hover,
    .search__chip-remove:focus-visible {
        background: var(--gk-surface-1);
        color: var(--gk-text-strong);
    }
    @media (pointer: coarse) {
        .search__chip-remove {
            min-width: 2.75rem;
            min-height: 2.75rem;
        }
        .search__suggestion {
            min-height: 2.75rem;
            align-items: center;
        }
    }
    /* The values a filtered row matched: shown beside the name, and the first to give way. */
    .search__props {
        min-width: 0;
        max-width: 50%;
        flex-shrink: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.875rem;
        color: var(--gk-text-subtle);
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
    /* The editor's own ==highlight== wash, translucent so the text keeps its colour and reads at
       4.5:1 or more in both themes (a solid pale fill under dark mode's light text did not). */
    .search__snippet mark {
        background: var(--gk-highlight-bg);
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
