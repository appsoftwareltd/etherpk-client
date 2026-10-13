<script lang="ts">
    /**
     * The graph [[Sidebar]]: a group of action buttons ([[Search]], today's [[Journal Entry]],
     * the buttons extensions add), the [[Journal Calendar]], [[Favourite]]s, [[Recents]], the way
     * into [[All Documents]], and a synced graph's sync status at its foot (ADR 0139).
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
     * as Search's row for a [[Pageless Concept]] does (ADR 0050). Nothing here asks the
     * store whether a concept resolves before letting it be clicked.
     *
     * A [[Protected Document]]'s Favourite row wears the tab strip's padlock, minus its state;
     * a protected document is left out of Recents altogether. The flag comes from the
     * [[Derived Index]]'s concept snapshot - the same synchronous read Search ranks names over -
     * never from opening the document, which on a Server Backend retains a sync engine (Store
     * decorator costs). It therefore trails a protect by one ingest, which is fine for a list you
     * glance at; the tab, where the state matters, stays immediate.
     */
    import { onDestroy, onMount, tick } from "svelte";
    import { createSubscriber } from "svelte/reactivity";

    import {
        getActiveDocument,
        getActiveDocumentStore,
        getActiveGraphSettings,
    } from "$lib/document";
    import { todayISO } from "$lib/document/calendar/month-grid-core";
    import JournalCalendar from "./JournalCalendar.svelte";
    import { FAVOURITE_MOVE } from "$lib/document/commands/document-commands";
    import { subscribeFavourites } from "$lib/document/favourites";
    import { getActiveLayoutController, type ViewRef } from "$lib/layout";
    import { prefersMobileLayout } from "$lib/layout/breakpoint";
    import { getActiveRecents } from "$lib/navigation/active-recents";
    import type { FilesystemDocumentStore } from "$lib/storage";
    import { recentCountOf } from "$lib/storage/fs/graph-settings";
    import {
        attachContextMenu,
        createControlHelp,
        GRAPH_SIDEBAR_BUTTON_KIND,
        type GraphSidebarButton,
        graphSidebarButtons,
        openContextMenu,
        sidebarButtonColumns,
        tryGetActiveCommandRegistry,
        tryGetActiveContributionRegistry,
        tryGetActiveEventBus,
        type DocumentContextMenuTarget,
    } from "$lib/surface";
    import { getActiveGraphIndex } from "$lib/document/backlinks/active-index";
    import { openConcept } from "$lib/document/open-concept";
    import { iconSvg } from "$lib/surface/icons";
    import SyncStatus from "$lib/sync/ui/SyncStatus.svelte";
    import {
        currentWorkspaceServices,
        type ProtectionControls,
        workspaceService,
    } from "$lib/workspace/workspace-services";

    const { view: _view }: { view: ViewRef } = $props();

    const store = getActiveDocumentStore() as FilesystemDocumentStore;

    let documents = $state<{ concept: string; kind: string }[]>([]);
    let favourites = $state.raw<string[]>([]);
    let recents = $state.raw<string[]>([]);
    /** The active document, so the [[Journal Calendar]] can follow it when it is a day. */
    let activeConcept = $state<string | null>(getActiveDocument());
    let calendarOpen = $state(true);

    /** Stable id base for the Favourites handle's hint. */
    const listId = $props.id();

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

    /**
     * A synced graph's sync status, for the foot of the Sidebar. Its fields are getters over the
     * workspace's runes, so reading them in the template follows every change. Read once: the
     * workspace publishes it with the graph's services, before any presenter mounts this View.
     * Absent in the dev harnesses, which have no workspace.
     */
    const syncStatus = currentWorkspaceServices()?.sync;

    const recentLimit = $derived(recentCountOf(getActiveGraphSettings()));
    /** Concepts that currently resolve, for the [[Journal Calendar]]'s bold days. */
    const known = $derived(
        new Set(documents.map((d) => d.concept.toLowerCase())),
    );
    /**
     * Not filtered to `known`: a Recent that no longer resolves - or never did, because it was
     * a Draft nothing was typed into - is still somewhere the user was, and opens the same
     * Draft it would from Search. A delete forgets its Recent explicitly (document-mutations).
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

    /**
     * Open a Recents, Favourites or calendar entry by the name the index resolves it to: an entry
     * can hold an alias, or the old name of a page renamed elsewhere, and opens the page it names.
     */
    function open(concept: string) {
        openConcept(concept);
    }

    /**
     * Today's [[Journal Concept]], resolved at the click and never cached: a tab left open
     * overnight must reach the new day, not the one it mounted on. Computed, never created:
     * reaching a day writes nothing until something is typed into it (ADR 0056), so this
     * replaced an awaited `ensureTodayJournal` that minted an empty entry on every open. The
     * button that calls this reads "Today" rather than the date, so nothing on it has to change at
     * midnight.
     */
    function openToday() {
        open(todayISO());
    }

    // ---- The action buttons -----------------------------------------------------------
    /**
     * The buttons extensions add after Search and Today (the maps extension's Graph Map,
     * the kanban extension's Graph Kanban), read again whenever one is added or taken back, as an
     * extension starts or is switched off.
     */
    const contributions = tryGetActiveContributionRegistry();
    const watchButtons = createSubscriber((update) => contributions?.subscribe(GRAPH_SIDEBAR_BUTTON_KIND, update) ?? (() => {}));
    const extensionButtons = $derived.by<GraphSidebarButton[]>(() => {
        watchButtons();
        return contributions ? graphSidebarButtons(contributions) : [];
    });

    /** Run a button's Command, as the Command Menu runs a row's. A Command gone with its extension does nothing. */
    function runButton(button: GraphSidebarButton) {
        const commands = tryGetActiveCommandRegistry();
        if (commands?.has(button.command)) void commands.execute(button.command, button.args);
    }

    /**
     * Search, the first button: the modal that looks across the whole graph, by name and by text
     * (ADR 0139). Drawn only where the Command exists; the dev harnesses register none.
     */
    const SEARCH_OPEN = "search.open";
    const canSearch = tryGetActiveCommandRegistry()?.has(SEARCH_OPEN) ?? false;

    function openSearch() {
        void tryGetActiveCommandRegistry()?.execute(SEARCH_OPEN);
    }

    /**
     * Help text for a button: what it does, and every chord bound to its Command (ADR 0139), read
     * from the live keybinding table so a chord an extension binds after this View has drawn
     * shows too. The table is absent in the dev harnesses, where the text names no chord.
     */
    const helpFor = createControlHelp(workspaceService("keybindings"));
    /** The Command Alt+J runs, whose chord today's button names. The button opens the same day. */
    const OPEN_TODAY = "document.openTodayJournal";

    /**
     * Every button, one look and one spacing: a solid grey fill and no visible border, darker on
     * hover in the light theme and lighter in the dark. The border stays, transparent, for the
     * outline a forced-colours mode draws. The padding is kept tight so that the default 304px
     * Sidebar fits two buttons side by side, with a classic scrollbar beside them.
     * `overflow-hidden` clips a label that cannot fit even in one column (the Sidebar at its
     * narrowest, an extension's long title), rather than letting it spill into the next button.
     */
    const sidebarButton =
        "flex min-w-0 items-center overflow-hidden rounded-md border border-transparent bg-(--gk-surface-2) px-1.5 py-1.5 text-left text-sm font-medium text-(--gk-text-strong) hover:bg-(--gk-border-strong) pointer-coarse:min-h-11";

    /**
     * Under the phone layout the buttons are their icons alone, sharing one row across the
     * drawer's width (ADR 0139): a phone's drawer is narrow, and a row of icons keeps the top of it
     * short. Each keeps its name for a screen reader and its help text. Read once, because the
     * Sidebar mounts afresh with its presenter when the layout crosses the breakpoint.
     */
    const iconsOnly = prefersMobileLayout();
    /**
     * The row: as many columns as fit at the narrowest a button may be (36px, 44px under a
     * finger), with `auto-fit` collapsing the columns no button fills, so the buttons stretch
     * across the whole width and start a second row only when one more would be narrower than
     * that.
     */
    const iconRow =
        "grid grid-cols-[repeat(auto-fit,minmax(2.25rem,1fr))] gap-2 pointer-coarse:grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))]";
    /** The same fill as `sidebarButton`, as wide as its column, and 44px tall under a finger. */
    const sidebarIconButton =
        "flex h-9 min-w-0 items-center justify-center rounded-md border border-transparent bg-(--gk-surface-2) text-(--gk-text-default) hover:bg-(--gk-border-strong) pointer-coarse:h-11";

    /**
     * How many columns the buttons take (`sidebarButtonColumns`): one row when every button fits
     * at the widest one's natural width, two columns when two fit, otherwise one, so no label is
     * cut short. Two to start, the default Sidebar's layout, until the first measure. Not used
     * under the phone layout, where the buttons are icons in a wrapping row.
     */
    let columns = $state(2);
    let buttonsEl = $state<HTMLElement>();
    /** What the measure depends on besides sizes: which buttons there are and what they say. */
    const buttonLabels = $derived(
        [canSearch ? "Search" : "", "Today", ...extensionButtons.map((button) => button.title)].join("\n"),
    );

    /**
     * Measure each button's natural width and the width the group has, and pick the columns.
     *
     * The ResizeObserver watches the Sidebar's own box and each button's content, never the group:
     * the group's height changes with its columns, and watching it would report that change back
     * to this callback in the same frame. Each content box is as wide as its icon and label
     * whatever the column, so it changes only with the label or a font arriving. The Sidebar is
     * watched by its border box, which a scrollbar appearing does not change.
     */
    $effect(() => {
        const group = buttonsEl;
        const root = group?.parentElement;
        if (iconsOnly || !group || !root) return;
        void buttonLabels;
        const measure = () => {
            const buttons = [...group.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
            const first = buttons[0];
            if (!first) return;
            const style = getComputedStyle(first);
            const chrome =
                parseFloat(style.paddingLeft) +
                parseFloat(style.paddingRight) +
                parseFloat(style.borderLeftWidth) +
                parseFloat(style.borderRightWidth);
            const widest = Math.max(
                ...buttons.map((button) => button.querySelector("[data-button-content]")?.getBoundingClientRect().width ?? 0),
            );
            columns = sidebarButtonColumns({
                count: buttons.length,
                // Rounded up: a fraction of a pixel short would clip the last letter.
                widest: Math.ceil(widest + chrome),
                available: group.clientWidth,
                gap: parseFloat(getComputedStyle(group).columnGap) || 0,
            });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(root, { box: "border-box" });
        for (const content of group.querySelectorAll("[data-button-content]")) observer.observe(content);
        measure();
        return () => observer.disconnect();
    });

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
        // The Favourites' padlocks follow the index as it learns of a protect or an unprotect.
        const index = getActiveGraphIndex();
        if (index) {
            refreshProtected();
            unsubscribers.push(index.onUpdated(scheduleRefreshProtected));
        }
        unsubscribers.push(subscribeFavourites((next) => (favourites = next)));
        unsubscribers.push(
            getActiveRecents().subscribe((next) => (recents = next)),
        );
    });
    onDestroy(() => {
        detachProtectionWatch?.();
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
     * Whether the workspace offers its Settings modal as a Command. Read once at mount: the
     * registry is not reactive, the Sidebar is remounted with its presenter, and the dev harness
     * registers no such command, so the row is simply absent there.
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
    <!-- ── The action buttons: Search, Today, the extensions' buttons (ADR 0139) ── -->
    <!--
        One row, two columns or one, whichever keeps every label whole (`columns`). Search and
        Today come first, so they lead the row and head the grid and the stack. Every
        column is the same width, so a button left on its own keeps the width of one. Under the
        phone layout, icons alone sharing the row's width (`iconsOnly`).
    -->
    {#snippet buttonContent(icon: string, label: string)}
        {#if iconsOnly}
            <span class="inline-flex" aria-hidden="true">
                <!-- Markup from the icon table: the Client's own, or an extension's, sanitised as it was registered. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html iconSvg(icon, { size: 18 })}
            </span>
        {:else}
            <!-- Measured for its natural width (`data-button-content`), so it never shrinks. -->
            <span class="inline-flex shrink-0 items-center gap-1.5" data-button-content>
                <span class="inline-flex shrink-0 text-(--gk-text-subtle)" aria-hidden="true">
                    <!-- Markup from the icon table: the Client's own, or an extension's, sanitised as it was registered. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html iconSvg(icon, { size: 16 })}
                </span>
                <span class="whitespace-nowrap">{label}</span>
            </span>
        {/if}
    {/snippet}
    <div
        bind:this={buttonsEl}
        class={iconsOnly ? iconRow : "grid gap-2"}
        style:grid-template-columns={iconsOnly ? undefined : `repeat(${columns}, minmax(0, 1fr))`}
        data-testid="sidebar-buttons"
        data-columns={iconsOnly ? undefined : columns}
        data-icons-only={iconsOnly || undefined}
    >
        {#if canSearch}
            <button
                type="button"
                data-testid="sidebar-search"
                onclick={openSearch}
                class={iconsOnly ? sidebarIconButton : sidebarButton}
                aria-label={iconsOnly ? "Search" : undefined}
                {...helpFor("Open graph search modal", SEARCH_OPEN)}
            >
                {@render buttonContent("search", "Search")}
            </button>
        {/if}
        <!-- The label says Today; the accessible name says what it opens. -->
        <button
            type="button"
            data-testid="sidebar-today"
            onclick={openToday}
            class={iconsOnly ? sidebarIconButton : sidebarButton}
            aria-label="Today's journal"
            {...helpFor("Open today's journal", OPEN_TODAY)}
        >
            <!-- The calendar at the same line weight as the buttons beside it. -->
            {@render buttonContent("todays-journal", "Today")}
        </button>
        {#each extensionButtons as button (button.id)}
            <button
                type="button"
                data-testid="sidebar-extension-button"
                data-command={button.command}
                onclick={() => runButton(button)}
                class={iconsOnly ? sidebarIconButton : sidebarButton}
                aria-label={iconsOnly ? button.title : undefined}
                {...helpFor(button.description ?? button.title, button.command)}
            >
                {@render buttonContent(button.icon ?? "default", button.title)}
            </button>
        {/each}
    </div>

    <!-- ── Journal Calendar ───────────────────────────────────────────────────── -->
    <section>
        <button
            type="button"
            data-testid="calendar-toggle"
            onclick={() => (calendarOpen = !calendarOpen)}
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase pointer-coarse:min-h-11"
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
                class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase pointer-coarse:min-h-11"
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
                    class="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors pointer-coarse:min-h-11 {unlocked
                        ? 'border-transparent bg-(--gk-accent,#2563eb) text-(--gk-surface-0) hover:bg-(--gk-accent-hover,#1d4ed8)'
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
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase pointer-coarse:min-h-11"
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
                            class="flex w-full touch-manipulation select-none items-center gap-1.5 rounded-md py-1.5 pr-14 pl-6 text-left text-sm hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
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
                            class="absolute top-1/2 right-1 -translate-y-1/2 touch-none rounded px-0.5 py-1 text-(--gk-text-subtle) hover:bg-(--gk-surface-2) {drag
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
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase pointer-coarse:min-h-11"
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
                            class="flex w-full touch-manipulation select-none items-center gap-1.5 rounded-md py-1.5 pr-8 pl-6 text-left text-sm hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
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
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
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
                class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
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
        {#if syncStatus?.isSynced}
            <!-- Last in the footer, on every presenter: the toolbar and the phone's top bar have
                 no room for it, and the foot of the Sidebar is where a status line is looked for. -->
            <SyncStatus
                indicator={syncStatus.indicator}
                actions={syncStatus.actions}
            />
        {/if}
    </div>
</div>
