<script lang="ts">
    /**
     * The [[Graph View]] itself, loaded the first time a Graph View is on screen
     * (GraphViewShell.svelte). One component serves both copies:
     *
     * - **local**, the right Sidebar's resident: the active document and what is within one to
     *   three lines of it. Clicking a dot opens that document in the main region, which moves
     *   the centre with it.
     * - **whole**, in the main region: every concept the filters keep, coloured by [[Cluster]],
     *   with the lists beside it ([[Hub]]s, [[Pageless Concept]]s, [[Isolated Document]]s,
     *   Clusters, [[Bridge]]s), a path finder and a replay of the graph's journal days. Clicking a
     *   dot or a list row opens its document in the whole graph's own Pane.
     *
     * Off screen it does nothing. It reads the index only while on screen, after an update it
     * heard while hidden; the layout pauses; nothing is drawn; and the local copy does not even
     * follow the active document until it is back, when it catches up once.
     */
    import { untrack } from "svelte";

    import { dev } from "$app/environment";
    import { THEME_CHANGE_EVENT } from "@appsoftwareltd/etherpk-shared/theme";
    import { conceptKey } from "$lib/document/backlinks/backlink-index";
    import { canonicalConceptName, openConcept } from "$lib/document/open-concept";
    import { iconSvg } from "$lib/surface/icons";

    import ConceptPicker from "./ConceptPicker.svelte";
    import { linkGraphSource, type LinkGraphSnapshot } from "./link-graph-source";
    import { type GraphFilter, neighbourhood, sameLinkGraph, shortestPath, subgraph, visibleGraph } from "./model/graph-model";
    import { bridges, findClusters, hubs, isolatedDocuments, pagelessByDocuments, type RankedConcept } from "./model/insights";
    import { timelineOf } from "./model/timeline";
    import type { GraphViewPanelProps } from "./panel-props";
    import { loadPreferences, savePreferences, type GraphViewPreferences } from "./preferences";
    import { readMapColours } from "./render/map-colours";
    import { drawGraph } from "./render/map-graph";
    import { createMapHost, type MapHost } from "./render/map-host";
    import { graphViewContext, onWholeGraphFocus } from "./services";

    const { mode, panelId, onScreen }: GraphViewPanelProps = $props();
    const uid = $props.id();
    const context = graphViewContext();

    // ── Reading the index ────────────────────────────────────────────────────────────────
    // Both copies read through one source, so with both on screen an edit costs one request to
    // the index and one model build, and each copy is handed the same snapshot.
    const source = context ? linkGraphSource(context) : null;
    let snapshot = $state.raw<LinkGraphSnapshot | null>(null);
    const data = $derived(snapshot?.graph ?? null);
    /** The index changed since the picture was read: read it again next time it is on screen. */
    let dirty = $state(true);
    let failed = $state(false);
    /** One read at a time: an update heard during a read leaves `dirty` set for the next one. */
    let reading = $state(false);

    // Listening costs nothing: an update only marks the picture out of date, and the source
    // reports only an update that touched a concept or a document's wikilinks.
    $effect(() => source?.onStale(() => (dirty = true)));
    $effect(() => {
        // Never two reads at once: the index answers in order, so a second read only repeats
        // the first, and during a burst of edits each would be thrown away by the next.
        if (!onScreen || !dirty || reading || !source) return;
        // The first read at once; a refresh after edits waits for typing to pause.
        const timer = setTimeout(read, untrack(() => snapshot) ? 400 : 0);
        return () => clearTimeout(timer);
    });

    async function read() {
        if (!source || reading) return;
        dirty = false;
        reading = true;
        try {
            const next = await source.read();
            // Most edits change no line, and the source then hands back the same snapshot. A copy
            // that was off screen while a line came and went again keeps its own, so neither
            // redraws for nothing.
            if (!snapshot || (next !== snapshot && !sameLinkGraph(snapshot.graph, next.graph))) snapshot = next;
            failed = false;
        } catch {
            failed = true;
        } finally {
            reading = false;
        }
    }

    // ── What is shown ────────────────────────────────────────────────────────────────────
    let preferences = $state<GraphViewPreferences>(loadPreferences(untrack(() => mode)));
    $effect(() => savePreferences(mode, $state.snapshot(preferences)));
    const filter = $derived<GraphFilter>({ journals: preferences.journals, pageless: preferences.pageless });

    const model = $derived(snapshot?.model ?? null);

    let activeDocument = $state<string | null>(context?.activeDocument() ?? null);
    $effect(() => context?.events.on("document:active-changed", ({ documentId }) => (activeDocument = documentId)));
    /** The active document's key in the model; an alias resolves to its page. */
    const activeKey = $derived.by(() => {
        if (!activeDocument || !model) return null;
        const key = conceptKey(canonicalConceptName(activeDocument));
        return model.concepts.has(key) ? key : null;
    });
    // The local copy follows the active document only while on screen: off screen it keeps the
    // last centre, so navigating with the Graph View hidden costs nothing at all.
    let lastCentre: string | null = null;
    const centre = $derived.by(() => {
        if (onScreen) lastCentre = activeKey;
        return lastCentre;
    });

    const distance = $derived(mode === "local" && model && centre ? neighbourhood(model, centre, preferences.depth, filter) : null);
    const shown = $derived.by(() => {
        if (!model) return null;
        if (mode === "whole") return visibleGraph(model, filter);
        return distance ? subgraph(model.graph, (key) => distance.has(key)) : null;
    });
    const clusters = $derived(mode === "whole" && shown ? findClusters(shown) : null);
    const timeline = $derived(mode === "whole" && data ? timelineOf(data) : null);

    // ── Drawing ──────────────────────────────────────────────────────────────────────────
    let colours = $state.raw(readMapColours());
    $effect(() => {
        const follow = () => (colours = readMapColours());
        window.addEventListener(THEME_CHANGE_EVENT, follow);
        return () => window.removeEventListener(THEME_CHANGE_EVENT, follow);
    });

    let host = $state.raw<MapHost | null>(null);
    function attachMap(element: HTMLElement) {
        const created = createMapHost(element, {
            colours: untrack(() => colours),
            dense: mode === "local",
            onOpen: open,
            onHover: (key) => (hovered = key),
        });
        host = created;
        // Dev only, absent from production builds: what the canvas draws, for the Playwright specs.
        const hooks = dev ? ((window as unknown as { __etherpkGraphView?: Record<string, MapHost> }).__etherpkGraphView ??= {}) : null;
        if (hooks) hooks[mode] = created;
        return () => {
            created.kill();
            if (hooks?.[mode] === created) delete hooks[mode];
            if (host === created) host = null;
        };
    }

    let hovered = $state<string | null>(null);
    // What the picture was last drawn from, so showing it again redraws nothing that has not changed.
    let drawnFrom: { graph: unknown; colours: unknown; centre: string | null; order: number } | null = null;

    $effect(() => {
        const target = host;
        if (!target) return;
        if (!onScreen) {
            target.setPaused(true);
            return;
        }
        target.setPaused(false);
        const graph = shown;
        if (!graph) return;
        const next = { graph, colours, centre, order: graph.order };
        if (drawnFrom && drawnFrom.graph === next.graph && drawnFrom.colours === next.colours) return;
        const recoloured = drawnFrom !== null && drawnFrom.graph === next.graph;
        const newCentre = mode === "local" && drawnFrom?.centre !== centre;
        // A refresh that kept nearly every dot (an edit, a link added) only needs to fit the
        // change in; a filter that adds or removes many dots needs the full layout.
        const small = drawnFrom !== null && Math.abs(graph.order - drawnFrom.order) <= Math.max(5, drawnFrom.order * 0.05);
        const drawn = drawGraph(graph, {
            colours,
            mode,
            active: mode === "local" ? centre : null,
            // A new centre starts afresh; anything else keeps every dot where it was.
            positions: newCentre ? new Map() : target.positions(),
            clusterOf: clusters?.clusterOf,
            distance: distance ?? undefined,
        });
        target.setColours(colours);
        target.setGraph(drawn, {
            resetCamera: drawnFrom === null || newCentre,
            layout: recoloured ? "none" : drawnFrom === null || newCentre || !small ? "full" : "brief",
        });
        drawnFrom = next;
    });

    // ── Picking things out ───────────────────────────────────────────────────────────────
    type Pick = { kind: "concept"; key: string } | { kind: "cluster"; id: number } | { kind: "path"; keys: string[] };
    let pick = $state<Pick | null>(null);

    const emphasis = $derived.by((): ReadonlySet<string> | null => {
        if (!pick || !shown) return null;
        if (pick.kind === "path") return new Set(pick.keys);
        if (pick.kind === "cluster") {
            const id = pick.id;
            return new Set([...(clusters?.clusterOf ?? [])].filter(([, cluster]) => cluster === id).map(([key]) => key));
        }
        if (!shown.hasNode(pick.key)) return null;
        return new Set([pick.key, ...shown.neighbors(pick.key)]);
    });
    $effect(() => {
        if (onScreen) host?.setEmphasis(emphasis);
    });
    $effect(() => {
        if (onScreen) host?.setActive(mode === "whole" ? activeKey : null);
    });

    function centreOn(key: string) {
        pick = { kind: "concept", key };
        host?.focus(key);
    }

    // "Show in Graph View" on a document tab: centre on it once the picture holds it.
    let focusRequest = $state<string | null>(null);
    $effect(() => {
        if (mode !== "whole") return;
        return onWholeGraphFocus((concept) => (focusRequest = conceptKey(canonicalConceptName(concept))));
    });
    $effect(() => {
        const key = focusRequest;
        if (!key || !host || !shown || !onScreen) return;
        if (shown.hasNode(key)) {
            // After this frame's draw, so the camera moves to where the dot actually is.
            requestAnimationFrame(() => centreOn(key));
        } else if (dirty || reading) {
            // A page made a moment ago is not in the picture until the next read lands.
            return;
        }
        focusRequest = null;
    });

    // ── Opening documents ────────────────────────────────────────────────────────────────
    function nameOf(key: string): string {
        return model?.concepts.get(key)?.name ?? key;
    }

    /**
     * Open a dot's or a list row's document. The local copy opens it in the main region, as
     * Backlinks does, which makes it the new centre. The whole graph opens it in its own Pane, as
     * a tab in front of the picture, the way any View opens what is clicked in it; a document
     * already open in another Pane is brought to the front there.
     */
    function open(key: string) {
        const name = nameOf(key);
        if (mode === "local") openConcept(name);
        else openConcept(name, panelId);
    }

    // ── The lists beside the whole graph ─────────────────────────────────────────────────
    const LIST_LENGTH = 12;
    const hubList = $derived(mode === "whole" && model ? hubs(model, LIST_LENGTH) : []);
    const pagelessList = $derived(mode === "whole" && model ? pagelessByDocuments(model, LIST_LENGTH) : []);
    const isolatedList = $derived(mode === "whole" && model ? isolatedDocuments(model) : []);
    const bridgeList = $derived(mode === "whole" && shown && clusters ? bridges(shown, clusters, LIST_LENGTH) : []);
    let isolatedShown = $state(LIST_LENGTH);

    /** The concepts the pickers offer: what the picture holds now. */
    const pickable = $derived(shown ? shown.mapNodes((key, concept) => ({ key, name: concept.name })) : []);

    // Path finder.
    let pathFrom = $state<string | null>(null);
    let pathTo = $state<string | null>(null);
    let fromText = $state("");
    let toText = $state("");
    const path = $derived(shown && pathFrom && pathTo ? shortestPath(shown, pathFrom, pathTo) : undefined);
    /** Name one end of the path; once both are named, pick the route out in the picture. */
    function setPathEnd(end: "from" | "to", key: string) {
        if (end === "from") pathFrom = key;
        else pathTo = key;
        if (path && path.length > 0) pick = { kind: "path", keys: path };
    }

    let findText = $state("");

    // ── Replay of the journal days ───────────────────────────────────────────────────────
    let replayIndex = $state<number | null>(null);
    let playing = $state(false);
    const replayDay = $derived(timeline && replayIndex !== null ? (timeline.days[replayIndex] ?? null) : null);
    $effect(() => {
        const day = replayDay;
        const dates = timeline;
        if (!onScreen) return;
        host?.setHidden(day && dates ? (key) => {
            const appears = dates.conceptDay(key);
            return appears !== null && appears > day;
        } : null);
    });
    // Stepping through the days takes about twelve seconds whatever their number. Only while on
    // screen: a hidden replay simply waits where it is.
    $effect(() => {
        if (!playing || !onScreen || !timeline) return;
        const days = timeline.days.length;
        const timer = setInterval(() => {
            const next = (replayIndex ?? -1) + 1;
            if (next >= days) {
                playing = false;
                return;
            }
            replayIndex = next;
        }, Math.max(40, 12_000 / Math.max(1, days)));
        return () => clearInterval(timer);
    });
    function togglePlay() {
        if (!timeline || timeline.days.length === 0) return;
        if (!playing && (replayIndex === null || replayIndex >= timeline.days.length - 1)) replayIndex = 0;
        playing = !playing;
    }
    function stopReplay() {
        playing = false;
        replayIndex = null;
    }
    const replayCount = $derived.by(() => {
        if (!replayDay || !timeline || !shown) return null;
        const day = replayDay;
        return shown.filterNodes((key) => {
            const appears = timeline.conceptDay(key);
            return appears === null || appears <= day;
        }).length;
    });

    // ── The local copy's list ────────────────────────────────────────────────────────────
    const nearby = $derived.by(() => {
        if (!distance || !model) return [];
        return [...distance]
            .filter(([, hops]) => hops > 0)
            .map(([key, hops]) => ({ key, hops, name: nameOf(key), kind: model.concepts.get(key)?.kind }))
            .sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));
    });

    /** What the "Clear" control says it will undo. */
    const pickLabel = $derived.by(() => {
        if (!pick) return "";
        if (pick.kind === "path") return "path";
        if (pick.kind === "cluster") return clusters?.clusters[pick.id]?.name ?? "Cluster";
        return nameOf(pick.key);
    });

    const status = $derived.by(() => {
        if (failed && !data) return "error";
        if (!data) return "loading";
        if (mode === "local" && !activeDocument) return "no-document";
        if (mode === "local" && !centre) return "not-indexed";
        if (mode === "local" && nearby.length === 0) return "unlinked";
        if (mode === "whole" && (shown?.order ?? 0) === 0) return "empty";
        return "ready";
    });
    const summary = $derived(shown ? `${shown.order.toLocaleString()} ${shown.order === 1 ? "concept" : "concepts"}, ${shown.size.toLocaleString()} ${shown.size === 1 ? "line" : "lines"}` : "");
</script>

{#snippet icon(name: string, size = 16)}
    <!-- In-repo constant markup from the icon table, never user content. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html iconSvg(name, { size })}
{/snippet}

{#snippet toggles()}
    <label class="flex items-center gap-1.5 text-sm text-(--gk-text-default)">
        <input type="checkbox" bind:checked={preferences.journals} data-testid="graph-view-journals" />
        Journal entries
    </label>
    <label class="flex items-center gap-1.5 text-sm text-(--gk-text-default)">
        <span class="text-(--gk-text-muted)">Pageless</span>
        <select
            bind:value={preferences.pageless}
            class="rounded-md border border-(--gk-border-strong) bg-(--gk-surface-0) px-1.5 py-1 text-sm text-(--gk-text-default)"
            data-testid="graph-view-pageless"
        >
            <option value="all">All</option>
            <option value="mentioned-twice">Mentioned twice or more</option>
            <option value="none">None</option>
        </select>
    </label>
{/snippet}

{#snippet rankedRow(row: RankedConcept, detail: string)}
    <li class="group flex items-center gap-1">
        <button
            type="button"
            class={[
                "min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-1)",
                pick?.kind === "concept" && pick.key === row.key && "bg-(--gk-selection)",
            ]}
            onclick={() => centreOn(row.key)}
            title="Show {row.name} in the picture"
        >
            <span class="block truncate">{row.name}</span>
            {#if detail}<span class="block truncate text-(--gk-text-muted)">{detail}</span>{/if}
        </button>
        <button
            type="button"
            class="shrink-0 rounded px-1.5 py-1 text-sm text-(--gk-accent) hover:bg-(--gk-surface-1)"
            onclick={() => open(row.key)}
            aria-label="Open {row.name}"
        >
            Open
        </button>
    </li>
{/snippet}

<div
    class={["flex h-full min-h-0 bg-(--gk-surface-0) text-(--gk-text-default)", mode === "local" ? "flex-col" : "flex-row"]}
    data-testid="graph-view-panel"
    data-status={status}
    data-concepts={shown?.order ?? 0}
    data-lines={shown?.size ?? 0}
    aria-busy={reading}
>
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- The controls above the picture. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--gk-border-soft) px-3 py-2">
            {#if mode === "local"}
                <div class="flex items-center gap-1.5" role="group" aria-label="Steps out from the document">
                    <span class="text-sm text-(--gk-text-muted)">Steps</span>
                    {#each [1, 2, 3] as const as depth (depth)}
                        <button
                            type="button"
                            class={[
                                "min-w-7 rounded-md border px-2 py-0.5 text-sm",
                                preferences.depth === depth
                                    ? "border-(--gk-accent) bg-(--gk-accent) text-(--gk-surface-0)"
                                    : "border-(--gk-border-strong) text-(--gk-text-default) hover:bg-(--gk-surface-1)",
                            ]}
                            aria-pressed={preferences.depth === depth}
                            onclick={() => (preferences.depth = depth)}
                            data-testid="graph-view-depth-{depth}">{depth}</button
                        >
                    {/each}
                </div>
                <label class="flex items-center gap-1.5 text-sm text-(--gk-text-default)">
                    <input type="checkbox" bind:checked={preferences.journals} data-testid="graph-view-journals" />
                    Journal entries
                </label>
                <button
                    type="button"
                    class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-(--gk-accent) hover:bg-(--gk-surface-1)"
                    onclick={() => context?.commands.execute("graph-view.openWhole")}
                    data-testid="graph-view-open-whole"
                >
                    {@render icon("graph-view")}
                    Whole graph
                </button>
            {:else}
                {@render toggles()}
                {#if pick}
                    <button
                        type="button"
                        class="flex max-w-56 items-center gap-1 rounded-md border border-(--gk-border-strong) px-2 py-0.5 text-sm hover:bg-(--gk-surface-1)"
                        onclick={() => (pick = null)}
                        data-testid="graph-view-clear-pick"
                    >
                        <span class="truncate">Showing {pickLabel}</span>
                        {@render icon("close", 14)}
                        <span class="sr-only">Clear</span>
                    </button>
                {/if}
                <span class="ml-auto text-sm text-(--gk-text-muted)" data-testid="graph-view-summary">{summary}</span>
            {/if}
        </div>

        {#if failed && data}
            <div role="alert" class="mx-3 mt-2 flex items-center gap-3 rounded-lg bg-(--gk-warning-surface) px-3 py-2 text-sm text-(--gk-text-warning)">
                <span class="min-w-0 flex-1">Couldn't refresh the picture from the index, so it may be out of date.</span>
                <button type="button" class="shrink-0 rounded-md border border-current px-2 py-1 font-medium" onclick={read}>Try again</button>
            </div>
        {/if}

        <!-- The picture. Kept in the page for every state, so sigma keeps its context and camera.
             Clipped, so a canvas that has not caught up with a shrinking box never covers the
             list beneath it. -->
        <div class="relative min-h-0 flex-1 overflow-hidden">
            <!-- A picture to a screen reader: what it shows is named in the list beneath it (the
                 local copy) or the lists beside it (the whole graph), which are also the keyboard's
                 way to every concept; the zoom buttons are the keyboard's way to the camera. -->
            <div
                class="absolute inset-0"
                {@attach attachMap}
                role="img"
                aria-label={mode === "local"
                    ? `Graph View of ${centre ? nameOf(centre) : "the active document"}: ${summary}. The list below names them.`
                    : `Graph View of the whole graph: ${summary}. The lists beside it name what it shows.`}
                aria-describedby="{uid}-hover"
                data-testid="graph-view-map"
            ></div>
            <p id="{uid}-hover" class="sr-only" aria-live="polite">{hovered ? nameOf(hovered) : ""}</p>

            {#if status !== "ready"}
                <div class="pointer-events-none absolute inset-0 flex items-center justify-center p-6" data-testid="graph-view-state">
                    {#if status === "loading"}
                        <p class="graph-view-wait m-0 text-sm text-(--gk-text-muted)">Reading the graph…</p>
                    {:else if status === "error"}
                        <div class="pointer-events-auto flex flex-col items-center gap-3 text-center" role="alert">
                            <p class="m-0 max-w-xs text-sm text-(--gk-text-muted)">
                                Couldn't read the graph's index. It may still be building.
                            </p>
                            <button
                                type="button"
                                class="rounded-md border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium hover:bg-(--gk-surface-1)"
                                onclick={read}
                                data-testid="graph-view-retry-read">Try again</button
                            >
                        </div>
                    {:else if status === "no-document"}
                        <p class="m-0 max-w-xs text-center text-sm text-(--gk-text-muted)">
                            Open a document to see what it links to and what links to it.
                        </p>
                    {:else if status === "not-indexed"}
                        <p class="m-0 max-w-xs text-center text-sm text-(--gk-text-muted)">
                            {activeDocument} isn't in the index yet. It appears here once it has been saved.
                        </p>
                    {:else if status === "unlinked"}
                        <p class="m-0 max-w-xs text-center text-sm text-(--gk-text-muted)" data-testid="graph-view-unlinked">
                            {centre ? nameOf(centre) : activeDocument} has no wikilinks in or out{preferences.journals ? "" : " outside journal entries"}.
                            Link it to another page with [[ ]] and the link appears here.
                        </p>
                    {:else if status === "empty"}
                        <p class="m-0 max-w-xs text-center text-sm text-(--gk-text-muted)">
                            Nothing to show. The graph has no documents{filter.journals ? "" : " outside journal entries"} yet.
                        </p>
                    {/if}
                </div>
            {/if}

            <!-- Zoom: the buttons a mouse needs, and what the keys do for a keyboard. -->
            <div class="absolute right-2 bottom-2 flex flex-col gap-1">
                <button type="button" class="map-button" onclick={() => host?.zoom(1)} aria-label="Zoom in" data-testid="graph-view-zoom-in">
                    {@render icon("zoom-in")}
                </button>
                <button type="button" class="map-button" onclick={() => host?.zoom(-1)} aria-label="Zoom out">
                    {@render icon("zoom-out")}
                </button>
                <button type="button" class="map-button" onclick={() => host?.zoom(0)} aria-label="Fit the whole picture">
                    {@render icon("fit")}
                </button>
            </div>
        </div>

        {#if mode === "whole" && timeline && timeline.days.length > 0}
            <!-- The replay: journal days from first to last, the picture growing as it goes. -->
            <div class="flex items-center gap-3 border-t border-(--gk-border-soft) px-3 py-2" data-testid="graph-view-replay">
                <button
                    type="button"
                    class="rounded-md border border-(--gk-border-strong) px-2.5 py-1 text-sm font-medium hover:bg-(--gk-surface-1)"
                    onclick={togglePlay}
                    data-testid="graph-view-replay-play"
                >
                    {playing ? "Pause" : replayIndex === null ? "Replay" : "Play"}
                </button>
                <input
                    type="range"
                    min="0"
                    max={timeline.days.length - 1}
                    value={replayIndex ?? timeline.days.length - 1}
                    oninput={(event) => {
                        playing = false;
                        replayIndex = Number(event.currentTarget.value);
                    }}
                    class="min-w-0 flex-1 accent-(--gk-accent)"
                    aria-label="Journal day"
                    aria-valuetext={replayDay ?? "Today"}
                    data-testid="graph-view-replay-day"
                />
                <span class="w-48 shrink-0 text-sm text-(--gk-text-muted)" aria-live="polite" data-testid="graph-view-replay-label">
                    {#if replayDay}{replayDay}, {replayCount?.toLocaleString()} concepts{:else}Every day{/if}
                </span>
                {#if replayIndex !== null}
                    <button type="button" class="rounded-md px-2 py-1 text-sm text-(--gk-accent) hover:bg-(--gk-surface-1)" onclick={stopReplay}>Show all</button>
                {/if}
            </div>
        {/if}

        {#if mode === "local" && nearby.length > 0}
            <!-- The keyboard's way to everything the picture shows, closest first. -->
            <details class="max-h-[40%] shrink-0 overflow-y-auto border-t border-(--gk-border-soft)" data-testid="graph-view-nearby">
                <summary class="cursor-pointer px-3 py-2 text-sm font-medium text-(--gk-text-muted)">
                    Shown here ({nearby.length})
                </summary>
                <ul class="m-0 list-none px-2 pb-2">
                    {#each nearby as row (row.key)}
                        <li>
                            <button
                                type="button"
                                class="w-full truncate rounded px-1.5 py-1 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-1)"
                                onclick={() => open(row.key)}
                                data-testid="graph-view-nearby-row"
                            >
                                {row.name}
                                <span class="text-(--gk-text-muted)">
                                    ({row.hops === 1 ? "linked" : `${row.hops} steps`}{row.kind === "pageless" ? ", no page yet" : ""})
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
            </details>
        {/if}
    </div>

    {#if mode === "whole"}
        <aside class="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-(--gk-border-soft)" aria-label="What the picture shows" data-testid="graph-view-insights">
            <div class="border-b border-(--gk-border-soft) p-3">
                <ConceptPicker
                    label="Find a concept"
                    concepts={pickable}
                    bind:value={findText}
                    onPick={centreOn}
                    testid="graph-view-find"
                    placeholder="Type part of a name"
                />
            </div>

            <details open class="border-b border-(--gk-border-soft)" data-testid="graph-view-hubs">
                <summary class="insight-heading">Hubs</summary>
                <p class="insight-note">Linked from the most documents.</p>
                <ul class="insight-list">
                    {#each hubList as row (row.key)}{@render rankedRow(row, `${row.count} ${row.count === 1 ? "document" : "documents"}`)}{/each}
                </ul>
            </details>

            <details open class="border-b border-(--gk-border-soft)" data-testid="graph-view-clusters">
                <summary class="insight-heading">Clusters</summary>
                <p class="insight-note">Concepts that link to one another more than to the rest, named after their biggest Hub.</p>
                <ul class="insight-list">
                    {#each clusters?.clusters.slice(0, LIST_LENGTH) ?? [] as cluster (cluster.id)}
                        <li>
                            <button
                                type="button"
                                class={[
                                    "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-(--gk-surface-1)",
                                    pick?.kind === "cluster" && pick.id === cluster.id && "bg-(--gk-selection)",
                                ]}
                                onclick={() => (pick = pick?.kind === "cluster" && pick.id === cluster.id ? null : { kind: "cluster", id: cluster.id })}
                                aria-pressed={pick?.kind === "cluster" && pick.id === cluster.id}
                            >
                                <span class="size-3 shrink-0 rounded-full" style:background={colours.clusters[cluster.id] ?? colours.muted}></span>
                                <span class="min-w-0 flex-1 truncate">{cluster.name}</span>
                                <span class="text-(--gk-text-muted)">{cluster.size}</span>
                            </button>
                        </li>
                    {:else}
                        <li class="insight-note">No groups of three or more yet.</li>
                    {/each}
                </ul>
            </details>

            <details open class="border-b border-(--gk-border-soft)" data-testid="graph-view-bridges">
                <summary class="insight-heading">Bridges</summary>
                <p class="insight-note">Concepts carrying the links between two Clusters.</p>
                <ul class="insight-list">
                    {#each bridgeList as bridge (bridge.key)}
                        {@render rankedRow({ key: bridge.key, name: bridge.name, kind: "page", count: 0 }, `joins ${bridge.between[0]} and ${bridge.between[1]}`)}
                    {:else}
                        <li class="insight-note">None: the Clusters don't link to each other yet.</li>
                    {/each}
                </ul>
            </details>

            <details open class="border-b border-(--gk-border-soft)" data-testid="graph-view-pageless-list">
                <summary class="insight-heading">Pageless concepts</summary>
                <p class="insight-note">Mentioned the most, with no page yet. Opening one starts its page.</p>
                <ul class="insight-list">
                    {#each pagelessList as row (row.key)}{@render rankedRow(row, `${row.count} ${row.count === 1 ? "document" : "documents"}`)}{:else}
                        <li class="insight-note">None. Every wikilink names a page.</li>
                    {/each}
                </ul>
            </details>

            <details class="border-b border-(--gk-border-soft)" data-testid="graph-view-isolated">
                <summary class="insight-heading">Isolated documents ({isolatedList.length})</summary>
                <p class="insight-note">Pages with no wikilinks in or out.</p>
                <ul class="insight-list">
                    {#each isolatedList.slice(0, isolatedShown) as row (row.key)}{@render rankedRow(row, "")}{:else}
                        <li class="insight-note">None. Every page links or is linked.</li>
                    {/each}
                </ul>
                {#if isolatedList.length > isolatedShown}
                    <button type="button" class="mx-3 mb-2 text-sm text-(--gk-accent) hover:underline" onclick={() => (isolatedShown += 50)}>
                        Show {Math.min(50, isolatedList.length - isolatedShown)} more
                    </button>
                {/if}
            </details>

            <details class="border-b border-(--gk-border-soft)" data-testid="graph-view-path">
                <summary class="insight-heading">Path</summary>
                <div class="flex flex-col gap-2 px-3 pb-3">
                    <p class="insight-note !px-0">The fewest steps from one concept to another, through what the picture shows.</p>
                    <ConceptPicker label="From" concepts={pickable} bind:value={fromText} onPick={(key) => setPathEnd("from", key)} testid="graph-view-path-from" />
                    <ConceptPicker label="To" concepts={pickable} bind:value={toText} onPick={(key) => setPathEnd("to", key)} testid="graph-view-path-to" />
                    {#if pathFrom && pathTo}
                        {#if path}
                            <ol class="m-0 list-decimal pl-6 text-sm" data-testid="graph-view-path-steps">
                                {#each path as key (key)}
                                    <li>
                                        <button type="button" class="text-left text-(--gk-text-default) hover:underline" onclick={() => host?.focus(key)}>{nameOf(key)}</button>
                                    </li>
                                {/each}
                            </ol>
                        {:else}
                            <p class="m-0 text-sm text-(--gk-text-muted)" data-testid="graph-view-path-none">
                                Nothing joins {nameOf(pathFrom)} and {nameOf(pathTo)} in what the picture shows.
                            </p>
                        {/if}
                    {/if}
                </div>
            </details>
        </aside>
    {/if}
</div>

<style>
    .map-button {
        display: flex;
        width: 2rem;
        height: 2rem;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.375rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 1rem;
    }
    .map-button:hover {
        background: var(--gk-surface-1);
    }
    .insight-heading {
        cursor: pointer;
        padding: 0.5rem 0.75rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--gk-text-default);
    }
    .insight-note {
        margin: 0 0 0.25rem;
        padding: 0 0.75rem;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .insight-list {
        margin: 0;
        padding: 0 0.5rem 0.5rem;
        list-style: none;
    }
    /* Say nothing for a moment, so a quick read never flashes a message. */
    .graph-view-wait {
        animation: graph-view-appear 160ms ease-out 400ms both;
    }
    @keyframes graph-view-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .graph-view-wait {
            animation-duration: 0ms;
        }
    }
</style>
