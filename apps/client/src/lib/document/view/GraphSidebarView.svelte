<script lang="ts">
    /**
     * The graph [[Sidebar]]: [[Quick Find]], today's [[Journal Entry]], [[Favourite]]s,
     * [[Recents]], and the way into [[All Documents]].
     *
     * Replaces the old `document-tree`, which listed every journal and every page flat -
     * unusable at real scale (2838 documents on the graph this was built against) and, until
     * All Documents landed, the app's only browse-everything surface.
     *
     * Mounted through the dockview adapter, so like DocumentTreeView before it this cannot
     * read Svelte context and reaches the active store, layout controller and command
     * registry through their module accessors (Document Editor.md → Why a module accessor).
     *
     * Favourites are shared graph content; Recents are per-device (ADR 0036). Both are read
     * here through their own stores, never from the layout.
     *
     * Every row opens the same way, whether or not a document exists behind it: a Favourite
     * whose page was deleted, or a Recent that was only ever a [[Draft]], opens a Draft exactly
     * as a Quick Find row for a [[Pageless Concept]] does (ADR 0050). Nothing here asks the
     * store whether a concept resolves before letting it be clicked.
     *
     * A [[Protected Document]]'s Favourite or Quick Find row wears the tab strip's padlock, minus
     * its state; a protected document is left out of Recents altogether. The flag comes from the
     * [[Derived Index]]'s concept snapshot - the same synchronous read Quick Find ranks over -
     * never from opening the document, which on a Server Backend retains a sync engine (Store
     * decorator costs). It therefore trails a protect by one ingest, which is fine for a list you
     * glance at; the tab, where the state matters, stays immediate.
     */
    import { onDestroy, onMount, tick } from "svelte";

    import {
        getActiveDocument,
        getActiveDocumentStore,
        getActiveGraphSettings,
    } from "$lib/document";
    import { todayISO } from "$lib/document/calendar/month-grid-core";
    import JournalCalendar from "./JournalCalendar.svelte";
    import { FAVOURITE_MOVE } from "$lib/document/commands/document-commands";
    import { subscribeFavourites } from "$lib/document/favourites";
    import {
        rankQuickFind,
        stepQuickFindHighlight,
        type QuickFindRow,
    } from "$lib/document/quick-find";
    import { getActiveLayoutController, type ViewRef } from "$lib/layout";
    import { getActiveRecents } from "$lib/navigation/active-recents";
    import type { FilesystemDocumentStore } from "$lib/storage";
    import { recentCountOf } from "$lib/storage/fs/graph-settings";
    import {
        attachContextMenu,
        openContextMenu,
        tryGetActiveCommandRegistry,
        tryGetActiveEventBus,
        type DocumentContextMenuTarget,
    } from "$lib/surface";
    import { getActiveGraphIndex } from "$lib/document/backlinks/active-index";
    import { iconSvg } from "$lib/surface/icons";
    import {
        currentWorkspaceServices,
        type ProtectionControls,
    } from "$lib/workspace/workspace-services";

    const { view: _view }: { view: ViewRef } = $props();

    const store = getActiveDocumentStore() as FilesystemDocumentStore;

    /** Debounce matches the wikilink popover's feel: long enough not to rank on every keystroke. */
    const QUICK_FIND_DEBOUNCE_MS = 120;

    let documents = $state<{ concept: string; kind: string }[]>([]);
    let favourites = $state.raw<string[]>([]);
    let recents = $state.raw<string[]>([]);
    /** The active document, so the [[Journal Calendar]] can follow it when it is a day. */
    let activeConcept = $state<string | null>(getActiveDocument());
    let calendarOpen = $state(true);

    let query = $state("");
    let rows = $state.raw<QuickFindRow[]>([]);
    /**
     * The row the arrow keys (or the mouse) have chosen, or `null` for none: the resting state,
     * where Enter hands the typed text to [[Search]] rather than opening a row. Only a
     * deliberate choice opens a row, so the list never pre-highlights its first one.
     */
    let activeRow = $state<number | null>(null);
    /** Stable id base so the input can point at the highlighted row (aria-activedescendant). */
    const listId = $props.id();
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    let favouritesOpen = $state(true);
    let recentsOpen = $state(true);

    /**
     * The graph's lock control. Raw: its two readable fields are getters over the session's runes,
     * and a template that reads them re-renders on a lock transition without a proxy in the way.
     * Re-read on every lock event, because the record is read off the graph-open critical path
     * and this View can mount before it has landed.
     */
    let detachProtectionWatch: (() => void) | undefined;
    let protection = $state.raw<ProtectionControls | undefined>(
        currentWorkspaceServices()?.protection,
    );
    const unlocked = $derived(
        protection?.status === "unlocked" || protection?.status === "masked",
    );

    const recentLimit = $derived(recentCountOf(getActiveGraphSettings()));
    /** Concepts that currently resolve, for the [[Journal Calendar]]'s bold days. */
    const known = $derived(
        new Set(documents.map((d) => d.concept.toLowerCase())),
    );
    /**
     * Not filtered to `known`: a Recent that no longer resolves - or never did, because it was
     * a Draft nothing was typed into - is still somewhere the user was, and opens the same
     * Draft it would from Quick Find. A delete forgets its Recent explicitly (document-mutations).
     *
     * Filtered to leave out Protected Documents. Recents is an activity trail, and "what was
     * read lately" is exactly what protection should not advertise from a drawer anyone can
     * flick open on a shared phone. A Favourite is the user's own deliberate pin, so it stays.
     * Filtered at display rather than at `touch`, so a document protected AFTER it was visited
     * drops out too, once the index has seen the fence.
     */
    const visibleRecents = $derived(
        recents
            .filter((c) => !protectedConcepts.has(c.toLowerCase()))
            .slice(0, recentLimit),
    );

    /**
     * Case-insensitive identity keys of every candidate the index flags as protected - pages,
     * journals and the aliases that open them (`ConceptCandidate.protected`). Rebuilt from the
     * pushed snapshot, throttled the way [[Search]] throttles its own re-run: opening a graph
     * re-verifies every document, and that arrives as a long burst of index updates.
     */
    let protectedConcepts = $state.raw<Set<string>>(new Set());
    let protectedTimer: ReturnType<typeof setTimeout> | undefined;
    const PROTECTED_REFRESH_THROTTLE_MS = 250;

    function refreshProtected() {
        const next = new Set<string>();
        for (const candidate of getActiveGraphIndex()?.allConcepts() ?? []) {
            if (candidate.protected) next.add(candidate.key);
        }
        protectedConcepts = next;
    }

    function scheduleRefreshProtected() {
        if (protectedTimer) return;
        protectedTimer = setTimeout(() => {
            protectedTimer = undefined;
            refreshProtected();
        }, PROTECTED_REFRESH_THROTTLE_MS);
    }

    /**
     * Whether a day already holds something, for the [[Journal Calendar]]'s bold days.
     *
     * Asked about **resolution**, not about document kind: the registry keys on concept and a
     * page wins a collision, so a day whose only document is an ISO-named page still opens
     * something. Marking by kind would leave that day looking empty while clicking it opened a
     * full document (ADR 0056). `known` is the same set the Favourites rows test against, and it
     * refreshes with the registry.
     */
    function hasEntry(iso: string): boolean {
        return known.has(iso);
    }

    function refresh() {
        documents = store
            .listDocuments()
            .map((d) => ({ concept: d.concept, kind: d.kind }));
    }

    function open(concept: string) {
        getActiveLayoutController().openView({
            kind: "document",
            target: concept,
        });
    }

    /**
     * Today's [[Journal Concept]], resolved at the click and never cached: a tab left open
     * overnight must reach the new day, not the one it mounted on. Computed, never created:
     * reaching a day writes nothing until something is typed into it (ADR 0056), so this
     * replaced an awaited `ensureTodayJournal` that minted an empty entry on every open.
     */
    function openToday() {
        open(todayISO());
    }

    // ---- Quick Find -----------------------------------------------------------------
    function rank() {
        rows = rankQuickFind(getActiveGraphIndex()?.allConcepts() ?? [], query);
        // A re-rank can shorten the list under a chosen row; nothing is chosen then.
        if (activeRow !== null && activeRow >= rows.length) activeRow = null;
    }

    function scheduleRank() {
        // Let go of a chosen row at the keystroke, not when the debounced rank lands: the row
        // was chosen for the old text, and an Enter pressed in between must search for the
        // new text rather than open it.
        activeRow = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            rank();
        }, QUICK_FIND_DEBOUNCE_MS);
    }

    /**
     * Open the chosen row. Every kind opens the SAME way now, including a `draft` row for a
     * name nothing matches: opening writes nothing, and the page is created only once the
     * user types into the [[Draft]] (ADR 0050). That is what makes a typo here free.
     */
    function chooseRow(index: number) {
        const row = rows[index];
        if (!row) return;
        clearQuery();
        open(row.target);
    }

    /**
     * Hand over to [[Search]], carrying whatever has been typed, trimmed. An empty box carries
     * nothing, and Search then restores its own last query.
     *
     * Quick Find's text is deliberately NOT cleared: closing the modal should return the
     * Sidebar exactly as it was left. That cuts against `chooseRow`'s clear-first rule, but
     * that rule exists to stop a slow write landing over newly typed text, and opening a modal
     * is not a write.
     */
    function openSearch() {
        searchOpenedHere = true;
        void tryGetActiveCommandRegistry()?.execute("search.open", query.trim());
    }

    /**
     * Set while a [[Search]] this box handed its text to is open. A result opened there finishes
     * the errand the box was on, so the box empties as it does when one of its own rows is
     * opened; a dismissed Search leaves it as it was, and gives it focus back.
     */
    let searchOpenedHere = false;

    function onSearchClosed(outcome: "opened" | "dismissed") {
        if (searchOpenedHere && outcome === "opened") clearQuery();
        searchOpenedHere = false;
    }

    /**
     * A pointer press on a hand-off control leaves focus where it is. When that is the box,
     * Search hands it back there on Escape, so clicking the search button behaves like pressing
     * Enter. A keyboard user who tabbed to the control gets focus back on the control itself.
     */
    function keepFocus(event: PointerEvent) {
        event.preventDefault();
    }

    function clearQuery() {
        query = "";
        rows = [];
        activeRow = null;
    }

    /**
     * Up and Down move through the rows and back to the box (`stepQuickFindHighlight`). Enter
     * opens the chosen row, or with none chosen hands the text to [[Search]]: a name you can
     * see is one arrow away, and anything else is one key away from a full search.
     */
    function onQuickFindKeydown(event: KeyboardEvent) {
        // An IME confirms a composition with Enter; that keystroke belongs to the IME.
        if (event.isComposing) return;
        if (event.key === "Escape") {
            event.preventDefault();
            clearQuery();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (rows.length === 0) return;
            event.preventDefault();
            activeRow = stepQuickFindHighlight(
                activeRow,
                rows.length,
                event.key === "ArrowDown" ? 1 : -1,
            );
            // Focus stays in the box, so nothing scrolls the list on its own, and one Up from
            // the box lands on the bottom row. Every row is already rendered; only its
            // highlight changes, so the element can be scrolled to at once. The keys scroll
            // and the mouse does not: the pointer is already over the row it chose.
            if (activeRow !== null) {
                document
                    .getElementById(`${listId}-row-${activeRow}`)
                    ?.scrollIntoView({ block: "nearest" });
            }
        } else if (event.key === "Enter") {
            event.preventDefault();
            if (activeRow === null) openSearch();
            else chooseRow(activeRow);
        }
    }

    /**
     * The mouse chooses a row by MOVING onto it. Not `pointerenter`: the list appears under
     * wherever the pointer happens to rest, and a row that slid under a still mouse would take
     * Enter away from Search. Not touch either, where a scroll gesture is not a choice and a
     * tap opens the row outright.
     */
    function pointRow(event: PointerEvent, index: number) {
        if (event.pointerType !== "touch") activeRow = index;
    }

    // ---- Favourites order -----------------------------------------------------------
    /**
     * A favourite being dragged by its handle. Rows keep their DOM order for the whole gesture:
     * the dragged row follows the pointer and the rows it has passed slide aside by its height,
     * so nothing is written - or re-rendered under the pointer - until the handle is released.
     * The row is addressed by concept, not index, because the shared list can change under a
     * gesture (a peer's edit arriving over sync) and `favourites.move` then lands it as near as
     * the list allows rather than moving something else.
     */
    interface FavouriteDrag {
        pointerId: number;
        concept: string;
        from: number;
        /** Where the row lands if released now. */
        to: number;
        /** Pointer travel since the press, px. */
        dy: number;
        startY: number;
        /** Every row's centre as laid out at the press; the list is not re-measured mid-drag. */
        mids: number[];
        /** The dragged row's height: what the rows it passes slide aside by. */
        height: number;
    }
    let drag = $state.raw<FavouriteDrag | null>(null);
    let favouritesList = $state<HTMLUListElement>();
    /** A keyboard move, said once for screen readers; the list itself already shows it. */
    let favouritesAnnouncement = $state("");
    const handleHintId = `${listId}-handle-hint`;

    /** Through the Command, so a refused write reports the way a refused add does. */
    function moveFavouriteTo(concept: string, toIndex: number): void {
        void tryGetActiveCommandRegistry()?.execute(FAVOURITE_MOVE, {
            concept,
            toIndex,
        });
    }

    function startFavouriteDrag(
        event: PointerEvent,
        concept: string,
        index: number,
    ) {
        // The primary button only: a right-click on the handle is not a drag.
        if (event.button !== 0 || !favouritesList) return;
        // No text selection from the press, and no scroll from a touch (with `touch-none`).
        event.preventDefault();
        const rows = [...favouritesList.children].map((row) =>
            row.getBoundingClientRect(),
        );
        const mine = rows[index];
        if (!mine) return;
        // The handle keeps receiving the pointer wherever it goes, so the move and release
        // handlers below can stay on the handle rather than on the window.
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        drag = {
            pointerId: event.pointerId,
            concept,
            from: index,
            to: index,
            dy: 0,
            startY: event.clientY,
            mids: rows.map((r) => r.top + r.height / 2),
            height: mine.height,
        };
    }

    function moveFavouriteDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dy = event.clientY - drag.startY;
        // The row lands after every other row whose centre its own centre has passed.
        const centre = drag.mids[drag.from] + dy;
        let to = 0;
        for (let k = 0; k < drag.mids.length; k++) {
            if (k !== drag.from && drag.mids[k] < centre) to++;
        }
        drag = { ...drag, dy, to };
    }

    function endFavouriteDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const { concept, from, to } = drag;
        drag = null;
        if (to !== from) moveFavouriteTo(concept, to);
    }

    function cancelFavouriteDrag() {
        drag = null;
    }

    /** Escape abandons a drag where it was; the handle's release then writes nothing. */
    function onWindowKeydown(event: KeyboardEvent) {
        if (drag && event.key === "Escape") {
            event.preventDefault();
            cancelFavouriteDrag();
        }
    }

    /** How a row is displaced while a drag is in progress; nothing outside one. */
    function favouriteRowTransform(index: number): string | undefined {
        if (!drag) return undefined;
        if (index === drag.from) return `translateY(${drag.dy}px)`;
        if (drag.from < index && index <= drag.to)
            return `translateY(${-drag.height}px)`;
        if (drag.to <= index && index < drag.from)
            return `translateY(${drag.height}px)`;
        return undefined;
    }

    /**
     * The keyboard half of the handle: the arrow keys move the row a step, Home and End to
     * either end. Focus is put back on the handle afterwards - the keyed list moves the row's
     * element, and moving a focused element drops the focus - so a run of presses keeps going.
     */
    async function onFavouriteHandleKeydown(
        event: KeyboardEvent,
        concept: string,
        index: number,
    ) {
        const last = favourites.length - 1;
        const to =
            event.key === "ArrowUp"
                ? index - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? last
                      : null;
        if (to === null) return;
        event.preventDefault();
        if (to < 0 || to > last || to === index) return;
        moveFavouriteTo(concept, to);
        // The list re-renders on the model's synchronous emit; the persist behind it may
        // still be in flight, and a refusal rolls the order back with its own notice.
        await tick();
        favouritesList?.children[to]
            ?.querySelector<HTMLElement>('[data-testid="favourite-handle"]')
            ?.focus();
        favouritesAnnouncement = `${concept} moved to position ${to + 1} of ${favourites.length}`;
    }

    // ---- Context menus --------------------------------------------------------------
    /**
     * `attachContextMenu` wires right-click AND long-press; the visible ⋯ opens the same
     * menu from a pointer position, which is what makes any of this discoverable on touch
     * where a long press advertises nothing.
     */
    function menuTarget(
        kind: DocumentContextMenuTarget["kind"],
        concept: string,
    ) {
        // An attachment returns its cleanup DIRECTLY (not `{ destroy }` — that is the old
        // `use:action` contract, and returning it would leak a listener per re-render).
        return (node: HTMLElement) =>
            attachContextMenu(node, () => ({ kind, concept }));
    }

    function openMenuFromButton(
        event: MouseEvent,
        kind: DocumentContextMenuTarget["kind"],
        concept: string,
    ) {
        event.stopPropagation();
        const rect = (
            event.currentTarget as HTMLElement
        ).getBoundingClientRect();
        openContextMenu({ kind, concept }, rect.right, rect.bottom);
    }

    // ---- Wiring ---------------------------------------------------------------------
    let unsubscribers: (() => void)[] = [];
    onMount(() => {
        detachProtectionWatch = tryGetActiveEventBus()?.on(
            "protection:changed",
            () => {
                protection = currentWorkspaceServices()?.protection;
            },
        );
        refresh();
        const bus = tryGetActiveEventBus();
        if (bus) {
            unsubscribers.push(bus.on("documents:changed", refresh));
            unsubscribers.push(
                bus.on("search:closed", ({ outcome }) => onSearchClosed(outcome)),
            );
            unsubscribers.push(
                bus.on(
                    "document:active-changed",
                    ({ documentId }) => (activeConcept = documentId),
                ),
            );
        }
        // Read again now that the subscription is live: a restored layout (a reload) names the tab
        // in front after this View is created and before this onMount runs, and the bus has no
        // replay (BacklinksView has the same gap and the same fix).
        activeConcept = getActiveDocument();
        // Re-rank when the concept index rebuilds. Ranking only on keystroke left results
        // stale against a graph that had changed underneath them: a document created a
        // moment ago was simply unfindable until the user typed another character.
        const index = getActiveGraphIndex();
        if (index) {
            refreshProtected();
            unsubscribers.push(
                index.onUpdated(() => {
                    scheduleRefreshProtected();
                    if (query.trim() !== "") rank();
                }),
            );
        }
        unsubscribers.push(subscribeFavourites((next) => (favourites = next)));
        unsubscribers.push(
            getActiveRecents().subscribe((next) => (recents = next)),
        );
    });
    onDestroy(() => {
        detachProtectionWatch?.();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (protectedTimer) clearTimeout(protectedTimer);
        for (const dispose of unsubscribers) dispose();
        unsubscribers = [];
    });

    function openAllDocuments() {
        getActiveLayoutController().openView({
            kind: "all-documents",
            target: "all-documents",
        });
    }

    /**
     * Whether the workspace offers its Settings modal as a Command. Read once at mount, like the
     * mobile presenter's Tasks button: the Sidebar is remounted with its presenter, and the dev
     * harness registers no such command, so the row is simply absent there.
     */
    const hasSettingsCommand =
        tryGetActiveCommandRegistry()?.has("graph.settings.open") ?? false;
    const hasResetCommand =
        tryGetActiveCommandRegistry()?.has("workspace.reset") ?? false;

    function resetWorkspace() {
        void tryGetActiveCommandRegistry()?.execute("workspace.reset");
    }

    function openSettings() {
        void tryGetActiveCommandRegistry()?.execute("graph.settings.open");
    }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
    class="flex h-full flex-col gap-2 overflow-y-auto p-2 text-(--gk-text-default)"
    style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
    data-testid="graph-sidebar"
>
    <!-- ── Quick Find ─────────────────────────────────────────────────────────── -->
    <div class="relative">
        <!--
            Focus stays in the field while the arrow keys move the highlight, so without
            aria-activedescendant a screen reader never hears which row is selected.
        -->
        <!--
            The button stretches to the box's height (the row's default `align-items`), and its
            padding around the 16px icon makes it square. The gap matches the Sidebar's own
            padding (`p-2`), so the button sits as far from the box as both do from the edges.
        -->
        <div class="flex gap-2">
            <input
                data-testid="quick-find"
                placeholder="Quick find…"
                aria-label="Quick find"
                role="combobox"
                aria-expanded={rows.length > 0}
                aria-controls={listId}
                aria-activedescendant={rows.length > 0 && activeRow !== null
                    ? `${listId}-row-${activeRow}`
                    : undefined}
                autocomplete="off"
                enterkeyhint="search"
                bind:value={query}
                oninput={scheduleRank}
                onkeydown={onQuickFindKeydown}
                class="min-w-0 flex-1 rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5 text-sm text-(--gk-text-strong) placeholder:text-(--gk-text-subtle) focus:border-(--gk-border-strong) focus:outline-none"
            />
            <button
                type="button"
                data-testid="quick-find-search-button"
                aria-label="Search everything"
                title="Search everything"
                onpointerdown={keepFocus}
                onclick={openSearch}
                class="inline-flex shrink-0 items-center justify-center rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 text-(--gk-text-subtle) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong)"
            >
                <!-- In-repo constant markup from the icon table, never user or document content. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html iconSvg("search", { size: 16 })}
            </button>
        </div>
        {#if rows.length > 0}
            <ul
                id={listId}
                data-testid="quick-find-results"
                class="mt-1 max-h-72 overflow-y-auto rounded-t-md border border-b-0 border-(--gk-border-soft) bg-(--gk-surface-1) py-1 shadow-lg"
                role="listbox"
            >
                {#each rows as row, index (row.kind + row.label)}
                    <li>
                        <button
                            type="button"
                            id={`${listId}-row-${index}`}
                            role="option"
                            aria-selected={index === activeRow}
                            data-testid="quick-find-result"
                            data-kind={row.kind}
                            class="flex w-full gap-2 px-2 text-left text-sm {row.kind ===
                            'draft'
                                ? 'items-center py-2'
                                : 'items-baseline py-1.5'} {index === activeRow
                                ? 'bg-(--gk-surface-2)'
                                : ''}"
                            onpointermove={(event) => pointRow(event, index)}
                            onclick={() => chooseRow(index)}
                        >
                            <span
                                class="min-w-0 flex-1 truncate {row.kind ===
                                    'draft' || row.kind === 'pageless'
                                    ? 'italic'
                                    : ''}">{row.label}</span
                            >
                            {#if row.protected}
                                <span
                                    class="inline-flex shrink-0 self-center text-(--gk-text-subtle)"
                                    data-testid="quick-find-protected"
                                >
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                    {@html iconSvg("lock", {
                                        size: 13,
                                        label: "Protected document",
                                    })}
                                </span>
                            {/if}
                            {#if row.kind === "draft"}
                                <!--
                                    The row itself is the button, so the label is drawn as one
                                    rather than nested: a button-in-button is invalid HTML and
                                    would split the click target.
                                -->
                                <span
                                    data-testid="quick-find-new-page"
                                    class="inline-flex shrink-0 items-center rounded-md border border-(--gk-accent) px-3 py-1.5 text-sm leading-tight font-medium whitespace-nowrap text-(--gk-accent) {index ===
                                    activeRow
                                        ? 'bg-(--gk-accent) text-(--gk-surface-0)'
                                        : ''}">+ {row.detail}</span
                                >
                            {:else if row.detail}
                                <span
                                    class="shrink-0 text-sm text-(--gk-text-subtle)"
                                    >{row.detail}</span
                                >
                            {/if}
                        </button>
                    </li>
                {/each}
            </ul>
            <!--
                The handoff at the point the intent actually forms: the user has typed, scanned,
                and not found it. The help line below is for DISCOVERY - it is above their eyes
                by now, detached from the list they are reading.

                OUTSIDE the listbox, and not part of the arrow-key selection: everything inside
                `role="listbox"` must be an option, and this is an escape hatch rather than a
                result. Its keyboard route is Enter with no row chosen, which is why the hint
                shows only then.
            -->
            <button
                type="button"
                data-testid="quick-find-search-all"
                onpointerdown={keepFocus}
                onclick={openSearch}
                class="flex w-full items-baseline gap-2 rounded-b-md border border-t-0 border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5 text-left text-sm text-(--gk-text-subtle) shadow-lg hover:bg-(--gk-surface-2)"
            >
                <span class="min-w-0 flex-1 truncate"
                    >Search everything for “{query.trim()}”</span
                >
                {#if activeRow === null}
                    <span class="shrink-0 text-sm">Enter</span>
                {/if}
            </button>
        {/if}
        <!--
            Always visible, so someone who has never opened Search still learns it exists
            without having to fail at Quick Find first.
        -->
        <p class="mt-1 px-1 text-sm text-(--gk-text-subtle)">
            <button
                type="button"
                data-testid="quick-find-search-link"
                onpointerdown={keepFocus}
                onclick={openSearch}
                class="underline underline-offset-2 hover:text-(--gk-text-default)"
                >Search everything</button
            >
            <span class="opacity-70">(Ctrl+K)</span>
        </p>
    </div>

    <!-- ── Today's journal ────────────────────────────────────────────────────── -->
    <button
        type="button"
        data-testid="sidebar-today"
        onclick={openToday}
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-(--gk-surface-2)"
    >
        <svg
            class="h-4 w-4 shrink-0 text-(--gk-text-subtle)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
        >
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0V11.25A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"
            />
        </svg>
        Today's journal
    </button>

    <!-- ── Journal Calendar ───────────────────────────────────────────────────── -->
    <section>
        <button
            type="button"
            data-testid="calendar-toggle"
            onclick={() => (calendarOpen = !calendarOpen)}
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase"
            aria-expanded={calendarOpen}
        >
            <span
                class="inline-block motion-safe:transition-transform {calendarOpen
                    ? 'rotate-90'
                    : ''}">›</span
            >
            Calendar
        </button>
        {#if calendarOpen}
            <JournalCalendar
                {hasEntry}
                {activeConcept}
                onPick={(iso) => open(iso)}
            />
        {/if}
    </section>

    <!-- ── Protected documents ────────────────────────────────────────────────── -->
    <!-- One control for the whole graph, because the key is the unit (ADR 0058): unlocking
         anywhere unlocks every protected note on this device, and locking here locks them all.
         Shown only once the graph has a Protection Key; the Settings tab is the front door. -->
    {#if protection?.isConfigured}
        <section data-testid="protection-section">
            <div
                class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase"
            >
                Protected documents
            </div>
            <!-- A button rather than a full-width row: the icon says which state the graph is
                 in, and the label is the verb that leaves it, so there is nothing else to say.
                 Filled with the accent while unlocked - the same fill the Tasks View's active
                 filter wears - because that is the state worth noticing, and Lock now the action
                 worth reaching for; Unlock is the quiet outline. -->
            <div class="px-2 pb-2">
                <button
                    type="button"
                    data-testid={unlocked
                        ? "protection-lock"
                        : "protection-unlock"}
                    data-state={unlocked ? "unlocked" : "locked"}
                    onclick={() =>
                        unlocked
                            ? protection?.lockNow()
                            : protection?.requestUnlock()}
                    class="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors {unlocked
                        ? 'border-transparent bg-(--gk-accent,#2563eb) text-white hover:bg-(--gk-accent-hover,#1d4ed8)'
                        : 'border-(--gk-border-soft) text-(--gk-text-default) hover:bg-(--gk-surface-2)'}"
                >
                    <span class="inline-flex shrink-0" aria-hidden="true">
                        <!-- In-repo constant markup from the icon table, never user or document
                             content — the same justification the Command Bar's icons carry. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html iconSvg(unlocked ? "lock-open" : "lock", {
                            size: 16,
                        })}
                    </span>
                    <span>{unlocked ? "Lock now" : "Unlock"}</span>
                </button>
            </div>
        </section>
    {/if}

    <!-- ── Favourites ─────────────────────────────────────────────────────────── -->
    <section>
        <button
            type="button"
            data-testid="favourites-toggle"
            onclick={() => (favouritesOpen = !favouritesOpen)}
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase"
            aria-expanded={favouritesOpen}
        >
            <span
                class="inline-block motion-safe:transition-transform {favouritesOpen
                    ? 'rotate-90'
                    : ''}">›</span
            >
            Favourites
        </button>
        <!-- Read by every handle (aria-describedby): the keyboard path, which nothing visible
             advertises. The live region says where a keyboard move put the row. -->
        <span id={handleHintId} class="sr-only"
            >Drag to reorder, or press the arrow keys while the handle is
            focused.</span
        >
        <span
            class="sr-only"
            aria-live="polite"
            data-testid="favourites-announcement">{favouritesAnnouncement}</span
        >
        {#if favouritesOpen}
            <ul data-testid="favourites-list" bind:this={favouritesList}>
                {#each favourites as concept, i (concept)}
                    <!-- Rows hold their DOM order through a drag and are displaced by transform;
                         the dragged row rides above its neighbours and does not animate, so it
                         tracks the pointer without lag. -->
                    <li
                        class="group/row relative rounded-md {drag?.concept ===
                        concept
                            ? 'z-10 bg-(--gk-surface-1) shadow-md'
                            : 'motion-safe:transition-transform motion-safe:duration-150'}"
                        style:transform={favouriteRowTransform(i)}
                    >
                        <button
                            type="button"
                            data-testid="favourite-row"
                            {@attach menuTarget("favourite", concept)}
                            onclick={() => open(concept)}
                            class="flex w-full touch-manipulation select-none items-center gap-1.5 rounded-md py-1.5 pr-14 pl-6 text-left text-sm hover:bg-(--gk-surface-2)"
                            title={concept}
                        >
                            <span class="min-w-0 flex-1 truncate"
                                >{concept}</span
                            >
                            {#if protectedConcepts.has(concept.toLowerCase())}
                                <span
                                    class="inline-flex shrink-0 text-(--gk-text-subtle)"
                                    data-testid="favourite-protected"
                                >
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                    {@html iconSvg("lock", {
                                        size: 13,
                                        label: "Protected document",
                                    })}
                                </span>
                            {/if}
                        </button>
                        <button
                            type="button"
                            data-testid="favourite-menu"
                            aria-label="Actions for {concept}"
                            onclick={(e) =>
                                openMenuFromButton(e, "favourite", concept)}
                            class="absolute top-1/2 right-7 -translate-y-1/2 rounded px-1 text-(--gk-text-subtle) opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:bg-(--gk-surface-2) max-lg:opacity-100"
                            >⋯</button
                        >
                        <!-- The grip: visible at rest, because a handle nobody can see reorders
                             nothing. Pointer events, not HTML drag-and-drop, so a finger works the
                             same as a mouse; `touch-none` keeps the drawer from scrolling instead. -->
                        <button
                            type="button"
                            data-testid="favourite-handle"
                            data-concept={concept}
                            aria-label="Reorder {concept}"
                            aria-describedby={handleHintId}
                            onpointerdown={(e) =>
                                startFavouriteDrag(e, concept, i)}
                            onpointermove={moveFavouriteDrag}
                            onpointerup={endFavouriteDrag}
                            onpointercancel={cancelFavouriteDrag}
                            onkeydown={(e) =>
                                void onFavouriteHandleKeydown(e, concept, i)}
                            class="absolute top-1/2 right-1 -translate-y-1/2 touch-none rounded px-0.5 py-1 text-(--gk-text-subtle) opacity-60 group-hover/row:opacity-100 hover:bg-(--gk-surface-2) focus-visible:opacity-100 {drag
                                ? 'cursor-grabbing'
                                : 'cursor-grab'}"
                        >
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                            {@html iconSvg("grip", { size: 14 })}
                        </button>
                    </li>
                {:else}
                    <li
                        class="px-6 py-1 text-sm text-(--gk-text-subtle)"
                        data-testid="favourites-empty"
                    >
                        Right-click a document tab to add one.
                    </li>
                {/each}
            </ul>
        {/if}
    </section>

    <!-- ── Recents ────────────────────────────────────────────────────────────── -->
    <section>
        <button
            type="button"
            data-testid="recents-toggle"
            onclick={() => (recentsOpen = !recentsOpen)}
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase"
            aria-expanded={recentsOpen}
        >
            <span
                class="inline-block motion-safe:transition-transform {recentsOpen
                    ? 'rotate-90'
                    : ''}">›</span
            >
            Recents
        </button>
        {#if recentsOpen}
            <ul data-testid="recents-list">
                {#each visibleRecents as concept (concept)}
                    <li class="group/row relative">
                        <button
                            type="button"
                            data-testid="recent-row"
                            {@attach menuTarget("recent", concept)}
                            onclick={() => open(concept)}
                            class="flex w-full touch-manipulation select-none items-center gap-1.5 rounded-md py-1.5 pr-8 pl-6 text-left text-sm hover:bg-(--gk-surface-2)"
                            title={concept}
                        >
                            <span class="min-w-0 flex-1 truncate"
                                >{concept}</span
                            >
                        </button>
                        <button
                            type="button"
                            data-testid="recent-menu"
                            aria-label="Actions for {concept}"
                            onclick={(e) =>
                                openMenuFromButton(e, "recent", concept)}
                            class="absolute top-1/2 right-1 -translate-y-1/2 rounded px-1 text-(--gk-text-subtle) opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:bg-(--gk-surface-2) max-lg:opacity-100"
                            >⋯</button
                        >
                    </li>
                {:else}
                    <li
                        class="px-6 py-1 text-sm text-(--gk-text-subtle)"
                        data-testid="recents-empty"
                    >
                        Nothing opened yet.
                    </li>
                {/each}
            </ul>
        {/if}
    </section>

    <!-- ── All Documents ──────────────────────────────────────────────────────── -->
    <div class="mt-auto border-t border-(--gk-border-soft) pt-2">
        <button
            type="button"
            data-testid="open-all-documents"
            onclick={openAllDocuments}
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2)"
        >
            <span>All documents</span>
            <span class="text-sm text-(--gk-text-subtle)"
                >{documents.length}</span
            >
        </button>
        {#if hasSettingsCommand}
            <!--
                Below the layout breakpoint only (`lg`, the same 1024px the presenters swap at):
                the desktop toolbar carries the cog, and the mobile presenter's own chrome has no
                room for one, so on a phone the drawer is where Settings is reached. The glyph is
                the toolbar's, so the two read as the same door.
            -->
            <button
                type="button"
                data-testid="open-graph-settings"
                onclick={openSettings}
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2) lg:hidden"
            >
                <svg
                    class="h-4 w-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"
                    />
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                    />
                </svg>
                <span>Settings</span>
            </button>
        {/if}
        {#if hasResetCommand}
            <!-- On every presenter, unlike Settings: the phone top bar has no room for it, and on
                 a desktop it is the one control that still works when the toolbar's own button
                 is what the user is trying to get back to. Opens the confirmation. -->
            <button
                type="button"
                data-testid="reset-workspace"
                onclick={resetWorkspace}
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2)"
            >
                <svg
                    class="h-4 w-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                    />
                </svg>
                <span>Reset workspace</span>
            </button>
        {/if}
    </div>
</div>
