<script lang="ts">
    /**
     * A [[Map View]] (ADR 0118): every [[Place]] and [[Route]] that answers to one concept, or
     * every one in the graph, on a map framed to fit them all, with a list beside it grouped by
     * the document each is written in. Loaded the first time a Map View is on screen
     * (MapViewShell.svelte).
     *
     * It changes nothing. A place is edited in its Map Block, which "Show in document" opens at,
     * with the place selected there. Panning and zooming are the person's own and never saved.
     * Places that share one spot on the map, the same place written in several documents most
     * often, are offered together in a dialog, since the pin on top hides the rest.
     *
     * Off screen it does nothing: it reads the index only while on screen, and only after an
     * update that touched a map, and the map itself is let go a short while after the View
     * leaves the screen, since a browser keeps only a few WebGL contexts alive at once. It comes
     * back looking where it was.
     */
    import { tick, untrack } from 'svelte'
    import { createSubscriber } from 'svelte/reactivity'

    import type { MapItemHit, MapItemsResult } from '$lib/document/index-map-items'
    import { formatMapPoint, type MapPoint } from '$lib/document/map-text'
    import { iconSvg } from '$lib/surface/icons'

    import { MAPBOX_REFUSED_NOTE } from './basemap'
    import { MAPS_OPEN_WHOLE } from './identity'
    import { type BasemapProblem, type MapCamera, MapEngine } from './map-engine'
    import { formatDistance, routeLengthMeters } from './map-geometry'
    import {
        engineItems,
        filterKeys,
        findSelection,
        groupByDocument,
        itemLabel,
        type MapViewSelection,
        sameAnswer,
        sharedName,
        spotHeading,
        spotSummary,
        summarise,
        touchesMaps,
    } from './map-view-model'
    import type { MapViewPanelProps } from './map-view-panel-props'
    import { mapsAppUrl } from './maps-app-link'
    import { mapViewServices } from './services'
    import './maps.css'

    const { concept, panelId, onScreen }: MapViewPanelProps = $props()
    const uid = $props.id()
    const services = mapViewServices()
    const extension = services?.extension ?? null

    /** How long a map out of sight keeps its WebGL context, so switching tabs does not rebuild it. */
    const OFF_SCREEN_GRACE_MS = 8000
    /** Rows the list draws at a time; a whole graph can hold thousands. */
    const LIST_PAGE = 200
    /** The filter waits for typing to pause. */
    const FILTER_DELAY_MS = 150
    /** Room left round the framed items: the button across the top, the credit across the bottom. */
    const FRAME_PADDING = { top: 56, bottom: 44, left: 40, right: 40 }

    // ── Reading the index ────────────────────────────────────────────────────────────────

    let answer = $state.raw<MapItemsResult | null>(null)
    /** The index changed since the map was read: read it again next time it is on screen. */
    let dirty = $state(true)
    /** One read at a time: an update heard during a read leaves `dirty` set for the next one. */
    let reading = $state(false)
    let failed = $state(false)

    // Listening costs nothing: an update marks the map out of date, and only an update that
    // touched a map does.
    $effect(() =>
        extension?.index.onUpdated((update) => {
            if (touchesMaps(update)) dirty = true
        }),
    )
    $effect(() => {
        if (!onScreen || !dirty || reading || !extension) return
        // The first read at once; a read after edits waits for typing to pause.
        const timer = setTimeout(read, untrack(() => answer) ? 400 : 0)
        return () => clearTimeout(timer)
    })

    async function read(): Promise<void> {
        if (!extension || reading) return
        dirty = false
        reading = true
        try {
            const next = await services!.mapItems(concept)
            // Most reads change nothing, and then nothing is drawn again.
            if (!answer || !sameAnswer(answer, next)) answer = next
            failed = false
        } catch {
            failed = true
        } finally {
            reading = false
        }
    }

    // ── What is shown ────────────────────────────────────────────────────────────────────

    const hits = $derived(answer?.items ?? [])
    let filterText = $state('')
    let filter = $state('')
    let filterTimer: ReturnType<typeof setTimeout> | undefined
    const shownKeys = $derived(filterKeys(hits, filter))
    const groups = $derived(groupByDocument(hits, shownKeys))
    const drawn = $derived(engineItems(hits, shownKeys))
    const summary = $derived(summarise(hits, shownKeys))

    let listLimit = $state(LIST_PAGE)
    /** The groups as far as the list draws them: the first `listLimit` rows. */
    const listed = $derived.by(() => {
        let left = listLimit
        const out: typeof groups = []
        for (const group of groups) {
            if (left <= 0) break
            const keys = group.keys.slice(0, left)
            out.push({ ...group, keys })
            left -= keys.length
        }
        return out
    })
    const unlisted = $derived(Math.max(0, shownKeys.length - listLimit))
    /** How many kept items each document holds, however many of them the list draws. */
    const groupSizes = $derived(new Map(groups.map((group) => [group.concept, group.keys.length])))

    let selection = $state<MapViewSelection | null>(null)
    const selectedKey = $derived(selection ? findSelection(hits, selection) : null)

    let note = $state<string | null>(null)
    let listElement = $state<HTMLElement>()

    /** The places at the spot chosen on the map, while the dialog offering them is open. */
    let spot = $state.raw<MapItemHit[] | null>(null)
    const spotName = $derived(spot ? sharedName(spot) : null)
    let spotDialog = $state<HTMLDialogElement>()

    function filterChanged(): void {
        clearTimeout(filterTimer)
        filterTimer = setTimeout(() => {
            filter = filterText
            listLimit = LIST_PAGE
        }, FILTER_DELAY_MS)
    }

    // ── The map ──────────────────────────────────────────────────────────────────────────

    // The app's theme, followed as it changes: the theme lives outside Svelte, on the root element.
    const watchTheme = createSubscriber((update) => extension?.events.on('theme:changed', update))
    const dark = $derived.by(() => {
        watchTheme()
        return extension?.theme.isDark() ?? false
    })
    // What the map is drawn over: the deployment's basemap, or the person's own Mapbox, with its
    // switch to satellite (basemap.ts).
    const watchBasemaps = createSubscriber((update) => services?.basemaps.subscribe(update))
    const basemap = $derived.by(() => {
        watchBasemaps()
        return services?.basemaps.current(dark) ?? null
    })
    const mapbox = $derived.by(() => {
        watchBasemaps()
        return services?.basemaps.mapbox() ?? false
    })
    const satellite = $derived.by(() => {
        watchBasemaps()
        return services?.basemaps.satellite() ?? false
    })
    const refused = $derived.by(() => {
        watchBasemaps()
        return services?.basemaps.refused() ?? false
    })

    /** The map exists while the View is on screen, and for a grace after it leaves. */
    let live = $state(false)
    $effect(() => {
        if (onScreen) {
            live = true
            return
        }
        const timer = setTimeout(() => (live = false), OFF_SCREEN_GRACE_MS)
        return () => clearTimeout(timer)
    })

    let engine = $state.raw<MapEngine | null>(null)
    /** The engine has drawn once, so it can be asked to show an item. */
    let ready = false
    let engineFailed = $state(false)
    let basemapProblem = $state<BasemapProblem | null>(null)
    /** Where the map was looking when it was last let go, so it comes back there. */
    let camera: MapCamera | null = null
    /** An item chosen in the list before the map had drawn, shown once it has. */
    let showWhenReady: number | null = null

    function attachEngine(node: HTMLElement) {
        let created: MapEngine
        try {
            created = new MapEngine(node, {
                basemap: untrack(() => basemap),
                dark: untrack(() => dark),
                // The Map View is the map's own surface, not a block in a scrolling page.
                cooperative: false,
                cluster: true,
                framePadding: FRAME_PADDING,
                onReady: () => {
                    ready = true
                    if (camera) created.setCamera(camera)
                    else created.frame()
                    if (showWhenReady !== null) created.showItem(showWhenReady, false)
                    showWhenReady = null
                },
                onBasemap: (problem) => (basemapProblem = problem),
                onMapClick: () => (selection = null),
                onItemClick: chooseOnMap,
                onSpotClick: (keys) => void offerSpot(keys),
            })
        } catch {
            // No WebGL 2 (an old browser, or one with graphics switched off): the list still works.
            engineFailed = true
            return
        }
        engine = created
        return () => {
            camera = created.camera()
            if (engine === created) {
                engine = null
                ready = false
            }
            created.destroy()
        }
    }

    $effect(() => {
        engine?.setItems(drawn, selectedKey, null)
    })
    $effect(() => {
        engine?.setDark(dark, basemap)
    })

    function online(): void {
        if (basemapProblem === 'offline') engine?.retryBasemap(basemap)
    }

    // ── Choosing an item ─────────────────────────────────────────────────────────────────

    async function select(key: number, from: 'map' | 'list'): Promise<void> {
        const hit = hits[key]
        if (!hit) return
        note = null
        selection = { concept: hit.concept, line: hit.line, text: hit.text }
        if (from === 'list') {
            if (engine && ready) engine.showItem(key)
            else showWhenReady = key
            // Its details open under its row: bring them into view, the actions included.
            await tick()
            document.getElementById(`${uid}-chosen`)?.scrollIntoView({ block: 'nearest' })
            return
        }
        // Chosen on the map: its row comes into the list's view.
        await revealRow(key)
    }

    /** Bring an item's row into the list's view, drawing more rows first when it is past the last drawn. */
    async function revealRow(key: number): Promise<void> {
        const position = shownKeys.indexOf(key)
        if (position >= listLimit) listLimit = Math.ceil((position + 1) / LIST_PAGE) * LIST_PAGE
        await tick()
        listElement?.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'nearest' })
    }

    /** A pin chosen on the map: its place, or every place at its spot when the pin hides others. */
    function chooseOnMap(key: number): void {
        const here = engine?.placesAt(key) ?? [key]
        if (here.length > 1) void offerSpot(here)
        else void select(key, 'map')
    }

    /**
     * Places that share one spot on the map: the list comes to the first of them, and a dialog
     * offers each with Show in document.
     */
    async function offerSpot(keys: readonly number[]): Promise<void> {
        const wanted = new Set(keys)
        const inOrder = shownKeys.filter((key) => wanted.has(key))
        if (inOrder.length === 0) return
        note = null
        selection = null
        spot = inOrder.map((key) => hits[key])
        await revealRow(inOrder[0])
    }

    /** Show in document, from the dialog, which closes first so the document takes the keyboard. */
    function showFromSpot(hit: MapItemHit): void {
        spotDialog?.close()
        showInDocument(hit)
    }

    /**
     * The dialog for a spot opens as a modal as it is drawn, so the page behind it waits and the
     * keyboard stays in it. Escape, its close button and a press outside it close it.
     */
    function modal(node: HTMLDialogElement) {
        node.showModal()
        // A press on the backdrop lands on the dialog itself, outside the box that fills it. Only
        // a press that started there counts, so a drag out of the dialog doesn't close it.
        let pressedOutside = false
        const down = (event: PointerEvent) => (pressedOutside = event.target === node)
        const click = (event: MouseEvent) => {
            if (pressedOutside && event.target === node) node.close()
            pressedOutside = false
        }
        const closed = () => (spot = null)
        node.addEventListener('pointerdown', down)
        node.addEventListener('click', click)
        node.addEventListener('close', closed)
        return () => {
            node.removeEventListener('pointerdown', down)
            node.removeEventListener('click', click)
            node.removeEventListener('close', closed)
            if (node.open) node.close()
        }
    }

    /**
     * Open the document at the Map Block holding the item, with the item selected there, in the
     * map's own pane: the map stays a tab behind it, and Back returns to it.
     */
    function showInDocument(hit: MapItemHit): void {
        services?.selectRequests.request({ document: hit.concept, text: hit.text })
        openDocument(hit.concept, hit.fenceLine)
    }

    /**
     * The document at the line, under the name it resolves to, in the map's own pane, on a desktop
     * as on a phone. It opened in a new pane beside the map on a desktop until 2026-10-09.
     */
    function openDocument(name: string, line: number): void {
        extension?.layout.openDocument(name, { line, inPaneOf: panelId })
    }

    async function copyCoordinates(point: MapPoint): Promise<void> {
        try {
            await services?.copy(formatMapPoint(point))
            services?.notify('Coordinates copied.')
        } catch {
            note = "The coordinates couldn't be copied. Your browser blocked the clipboard."
        }
    }

    function showEverything(): void {
        engine?.frame(true)
    }

    function openWhole(): void {
        void extension?.commands.execute(MAPS_OPEN_WHOLE, { panelId })
    }

    /** Escape lets go of the selected item, from anywhere in the View. */
    function listen(node: HTMLElement) {
        const keys = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || !selection) return
            event.preventDefault()
            event.stopPropagation()
            selection = null
        }
        node.addEventListener('keydown', keys)
        return () => node.removeEventListener('keydown', keys)
    }
</script>

<svelte:window ononline={online} />

{#snippet icon(name: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo icon markup (icons.ts), never content -->
    {@html iconSvg(name)}
{/snippet}

<div
    class="gk-map-view"
    data-testid="map-view-panel"
    data-state={answer === null ? (failed ? 'failed' : 'loading') : hits.length === 0 ? 'empty' : engineFailed ? 'no-map' : engine ? 'live' : 'resting'}
    data-items={hits.length}
    {@attach listen}
>
    {#if answer === null && failed}
        <div class="centred" role="alert" data-testid="map-view-failed">
            <p>The places couldn't be read from this graph's index.</p>
            <button type="button" class="gk-map-button" onclick={() => (dirty = true)}>Try again</button>
        </div>
    {:else if answer === null}
        <!-- The same frame the map and list will fill, so nothing moves when they arrive. -->
        <div class="layout" aria-busy="true" data-testid="map-view-loading">
            <div class="map resting"><p class="loading-text">Loading places…</p></div>
            <div class="list resting"></div>
        </div>
    {:else if hits.length === 0}
        <div class="centred" data-testid="map-view-empty">
            {@render icon('maps.map')}
            {#if concept !== null}
                <p class="empty-title" data-testid="map-view-empty-title">No places or routes belong to {concept} yet.</p>
                <p>Maps on its page, or nested under a link to it, appear here. Type <kbd>/map</kbd> in a document to add one.</p>
                <button type="button" class="gk-map-link-button" onclick={openWhole}>Show the Graph Map View</button>
            {:else}
                <p class="empty-title" data-testid="map-view-empty-title">No document in this graph has a map yet.</p>
                <p>Type <kbd>/map</kbd> in any document to add one.</p>
            {/if}
        </div>
    {:else}
        <div class="layout">
            <section class="map" aria-label="Map">
                {#if engineFailed}
                    <div class="centred" data-testid="map-view-no-webgl">
                        <p>This browser can't draw maps. The places and routes are listed beside it.</p>
                    </div>
                {:else if live}
                    <div class="canvas" data-testid="map-view-canvas" {@attach attachEngine}></div>
                {:else}
                    <div class="canvas resting" aria-hidden="true"></div>
                {/if}

                <div class="top">
                    {#if mapbox}
                        <button
                            type="button"
                            class="gk-map-button"
                            aria-pressed={satellite}
                            onclick={() => services?.basemaps.setSatellite(!satellite)}
                            data-testid="map-view-satellite"
                        >
                            {@render icon('maps.layers')}<span>Satellite</span>
                        </button>
                    {/if}
                    {#if engine}
                        <button type="button" class="gk-map-button" onclick={showEverything} data-testid="map-view-fit">
                            {@render icon('fit')}<span>Show everything</span>
                        </button>
                    {/if}
                </div>

                <div class="gk-map-notices notices">
                    {#if answer.truncated}
                        <p class="gk-map-notice" data-testid="map-view-truncated">Only the first {hits.length.toLocaleString()} places and routes are shown.</p>
                    {/if}
                    {#if failed}
                        <p class="gk-map-notice gk-map-notice--warn" role="status">
                            The map couldn't be brought up to date.
                            <button type="button" class="gk-map-link-button" onclick={() => (dirty = true)}>Try again</button>
                        </p>
                    {/if}
                    {#if note}
                        <p class="gk-map-notice gk-map-notice--warn" role="status">{note}</p>
                    {/if}
                    {#if refused}
                        <p class="gk-map-notice gk-map-notice--warn" role="status" data-testid="map-view-mapbox-refused">{MAPBOX_REFUSED_NOTE}</p>
                    {/if}
                    {#if basemapProblem === 'offline'}
                        <p class="gk-map-notice" role="status" data-testid="map-view-basemap">You're offline. Places and routes are shown without the map.</p>
                    {:else if basemapProblem === 'unavailable'}
                        <p class="gk-map-notice" role="status" data-testid="map-view-basemap">
                            The map couldn't load. Places and routes are shown without it.
                            <button type="button" class="gk-map-link-button" onclick={() => engine?.retryBasemap(basemap)}>Try again</button>
                        </p>
                    {/if}
                </div>

            </section>

            <aside class="list" aria-label="Places and routes">
                <header class="head">
                    <h2>{concept ?? 'Whole graph'}</h2>
                    <p class="summary" data-testid="map-view-summary">
                        {summary}
                        {#if reading}<span class="updating" aria-hidden="true">Updating…</span>{/if}
                    </p>
                    {#if concept !== null}
                        <button type="button" class="gk-map-link-button whole" onclick={openWhole} data-testid="map-view-whole">Show the Graph Map View</button>
                    {/if}
                    <label class="filter">
                        <span class="gk-map-search-icon">{@render icon('search')}</span>
                        <input
                            type="search"
                            placeholder="Filter by name or document"
                            aria-label="Filter places and routes by name or document"
                            autocomplete="off"
                            spellcheck="false"
                            bind:value={filterText}
                            oninput={filterChanged}
                            data-testid="map-view-filter"
                        />
                    </label>
                </header>
                <div class="rows" bind:this={listElement} data-testid="map-view-list">
                    {#if shownKeys.length === 0}
                        <p class="none">Nothing here matches "{filter}".</p>
                    {/if}
                    {#each listed as group (group.concept)}
                        <section class="group">
                            <h3>
                                <button type="button" class="document" onclick={() => openDocument(group.concept, hits[group.keys[0]].fenceLine)} title="Open {group.concept}">
                                    {group.concept}
                                </button>
                                <span class="count">{groupSizes.get(group.concept)}</span>
                            </h3>
                            <ul>
                                {#each group.keys as key (key)}
                                    {@const hit = hits[key]}
                                    <li>
                                        <button
                                            type="button"
                                            class="row"
                                            data-key={key}
                                            aria-pressed={selectedKey === key}
                                            aria-controls={selectedKey === key ? `${uid}-chosen` : undefined}
                                            onclick={() => select(key, 'list')}
                                            data-testid="map-view-item"
                                        >
                                            {@render icon(hit.item.kind === 'place' ? 'pin' : 'maps.route')}
                                            <span class="name">{itemLabel(hit.item)}</span>
                                            {#if hit.item.kind === 'route'}
                                                <span class="detail">{formatDistance(routeLengthMeters(hit.item.points))}</span>
                                            {/if}
                                        </button>
                                        {#if selectedKey === key}
                                            {@const item = hit.item}
                                            <!-- The chosen item's details and actions, under its row: nothing covers the map or its credit. -->
                                            <div id="{uid}-chosen" class="chosen" data-testid="map-view-selected">
                                                <p class="where">
                                                    {item.kind === 'place' ? formatMapPoint(item.point) : `A route of ${item.points.length} points`}
                                                </p>
                                                <div class="actions">
                                                    <button type="button" class="gk-map-button gk-map-button--primary" onclick={() => showInDocument(hit)} data-testid="map-view-show">Show in document</button>
                                                    {#if item.kind === 'place'}
                                                        <button type="button" class="gk-map-button" onclick={() => copyCoordinates(item.point)} data-testid="map-view-copy">{@render icon('copy')}Copy coordinates</button>
                                                        <a class="gk-map-button" href={mapsAppUrl(item.point, item.name, services?.apple ?? false)} target="_blank" rel="noopener noreferrer" data-testid="map-view-open-app">
                                                            {@render icon('open-external')}Open in maps app
                                                        </a>
                                                    {/if}
                                                </div>
                                            </div>
                                        {/if}
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/each}
                    {#if unlisted > 0}
                        <button type="button" class="gk-map-button more" onclick={() => (listLimit += LIST_PAGE)}>
                            Show {Math.min(unlisted, LIST_PAGE).toLocaleString()} more
                        </button>
                    {/if}
                </div>
            </aside>
        </div>
    {/if}

    {#if spot}
        <dialog class="spot" aria-labelledby="{uid}-spot-title" aria-describedby="{uid}-spot-summary" data-testid="map-view-spot" bind:this={spotDialog} {@attach modal}>
            <div class="spot-box">
                <header class="spot-head">
                    <h2 id="{uid}-spot-title">{spotHeading(spot)}</h2>
                    <button type="button" class="spot-close" aria-label="Close" onclick={() => spotDialog?.close()} data-testid="map-view-spot-close">
                        {@render icon('close')}
                    </button>
                </header>
                <p id="{uid}-spot-summary" class="spot-summary">{spotSummary(spot)}</p>
                <ul class="spot-list">
                    {#each spot as hit, i (`${hit.concept}\n${hit.line}`)}
                        <li class="spot-row" data-testid="map-view-spot-item">
                            <span id="{uid}-spot-{i}" class="spot-text">
                                <span class="spot-document" title={hit.concept}>{hit.concept}</span>
                                {#if spotName === null}<span class="spot-name">{itemLabel(hit.item)}</span>{/if}
                            </span>
                            <button type="button" class="gk-map-button" aria-describedby="{uid}-spot-{i}" onclick={() => showFromSpot(hit)} data-testid="map-view-spot-show">
                                Show in document
                            </button>
                        </li>
                    {/each}
                </ul>
            </div>
        </dialog>
    {/if}
</div>

<style>
    .gk-map-view {
        height: 100%;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-family: var(--gk-sans, ui-sans-serif, system-ui, sans-serif);
        font-size: 0.875rem;
        line-height: 1.4;
        container-type: inline-size;
    }

    .layout {
        display: flex;
        height: 100%;
    }

    .map {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        background: var(--gk-surface-1);
    }

    .canvas {
        position: absolute;
        inset: 0;
    }

    .resting {
        background: var(--gk-surface-1);
    }

    .loading-text {
        position: absolute;
        top: 50%;
        left: 50%;
        margin: 0;
        transform: translate(-50%, -50%);
        color: var(--gk-text-muted);
        /* Wait before saying anything, so a quick read never flashes a message. */
        animation: map-view-appear 160ms ease-out 400ms both;
    }

    @keyframes map-view-appear {
        from {
            visibility: hidden;
        }
        to {
            visibility: visible;
        }
    }

    .top {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 2;
        display: flex;
        gap: 6px;
    }

    .notices {
        top: 8px;
        max-width: min(26rem, calc(100% - 200px));
    }

    .list {
        display: flex;
        width: 20rem;
        flex: 0 0 auto;
        flex-direction: column;
        border-left: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-0);
    }

    .head {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px 12px 8px;
        border-bottom: 1px solid var(--gk-border-soft);
    }

    .head h2 {
        margin: 0;
        overflow: hidden;
        color: var(--gk-text-strong);
        font-size: 1rem;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .summary {
        margin: 0;
        color: var(--gk-text-muted);
    }

    .updating {
        margin-left: 6px;
        color: var(--gk-text-subtle);
    }

    .whole {
        align-self: flex-start;
        margin: 0;
    }

    .filter {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        padding: 0 8px;
        border: 1px solid var(--gk-border-strong);
        border-radius: 6px;
        background: var(--gk-surface-0);
    }

    .filter:focus-within {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }

    .filter input {
        width: 100%;
        min-width: 0;
        padding: 6px 0;
        border: 0;
        outline: none;
        background: none;
        color: inherit;
        font: inherit;
    }

    .rows {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 4px 8px 12px;
    }

    .none {
        margin: 12px 4px;
        color: var(--gk-text-muted);
    }

    .group h3 {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin: 10px 4px 2px;
        font-size: 0.875rem;
        font-weight: 600;
    }

    .document {
        overflow: hidden;
        padding: 0;
        border: 0;
        background: none;
        color: var(--gk-text-strong);
        font: inherit;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }

    .document:hover {
        text-decoration: underline;
    }

    .count {
        margin-left: auto;
        color: var(--gk-text-subtle);
        font-weight: 400;
        font-variant-numeric: tabular-nums;
    }

    .group ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .row {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border: 0;
        border-radius: 6px;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }

    .row:hover,
    .row[aria-pressed='true'] {
        background: var(--gk-surface-2);
    }

    .row[aria-pressed='true'] .name {
        font-weight: 600;
    }

    .row :global(svg) {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        color: var(--gk-text-muted);
    }

    .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .detail {
        margin-left: auto;
        color: var(--gk-text-muted);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
    }

    .more {
        margin: 12px 4px 0;
    }

    .chosen {
        margin: 2px 0 8px;
        padding: 8px 8px 10px 32px;
        border-left: 2px solid var(--gk-accent);
    }

    .where {
        margin: 0 0 8px;
        color: var(--gk-text-muted);
        font-variant-numeric: tabular-nums;
    }

    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }

    .row:focus-visible,
    .document:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }

    .centred {
        display: flex;
        height: 100%;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 24px;
        color: var(--gk-text-muted);
        text-align: center;
    }

    .centred p {
        max-width: 28rem;
        margin: 0;
    }

    .centred :global(svg) {
        width: 32px;
        height: 32px;
        color: var(--gk-text-subtle);
    }

    .empty-title {
        color: var(--gk-text-default);
        font-weight: 600;
    }

    /* The dialog offering the places at one spot, centred as a browser centres a modal dialog: the
       app's base styles take every element's margin away. */
    .spot {
        width: min(26rem, calc(100vw - 32px));
        max-width: none;
        max-height: calc(100dvh - 32px);
        margin: auto;
        padding: 0;
        overflow: hidden;
        border: 1px solid var(--gk-border-soft);
        border-radius: 12px;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        box-shadow: 0 20px 40px var(--gk-shadow);
    }

    .spot::backdrop {
        background: rgb(3 7 18 / 0.25);
    }

    :global(:root[data-theme='dark']) .spot::backdrop {
        background: rgb(0 0 0 / 0.5);
    }

    .spot-box {
        display: flex;
        max-height: calc(100dvh - 34px);
        flex-direction: column;
    }

    .spot-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 12px 2px 16px;
    }

    .spot-head h2 {
        margin: 0;
        overflow: hidden;
        color: var(--gk-text-strong);
        font-size: 1rem;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .spot-close {
        display: inline-flex;
        flex: 0 0 auto;
        padding: 6px;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--gk-text-muted);
        cursor: pointer;
    }

    .spot-close:hover {
        background: var(--gk-surface-2);
        color: var(--gk-text-default);
    }

    .spot-close :global(svg) {
        width: 16px;
        height: 16px;
    }

    .spot-summary {
        margin: 0;
        padding: 0 16px 10px;
        border-bottom: 1px solid var(--gk-border-soft);
        color: var(--gk-text-muted);
    }

    .spot-list {
        min-height: 0;
        margin: 0;
        padding: 6px 8px 10px;
        overflow-y: auto;
        list-style: none;
    }

    .spot-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 8px;
    }

    .spot-text {
        display: flex;
        min-width: 0;
        flex: 1 1 auto;
        flex-direction: column;
    }

    .spot-document,
    .spot-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .spot-document {
        color: var(--gk-text-strong);
        font-weight: 600;
    }

    .spot-name {
        color: var(--gk-text-muted);
    }

    .spot-row .gk-map-button {
        flex: 0 0 auto;
    }

    .spot-close:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }

    @media (pointer: coarse) {
        .spot-close,
        .spot-row .gk-map-button {
            min-width: 44px;
            min-height: 44px;
        }
    }

    kbd {
        padding: 0 4px;
        border: 1px solid var(--gk-border-strong);
        border-radius: 4px;
        background: var(--gk-surface-1);
        font-family: var(--gk-mono, ui-monospace, monospace);
    }

    /* A narrow View (a phone, a split pane): the list goes under the map. */
    @container (max-width: 719px) {
        .layout {
            flex-direction: column;
        }

        .map {
            flex: 0 0 55%;
            min-height: 240px;
        }

        .list {
            width: auto;
            min-height: 0;
            flex: 1 1 auto;
            border-top: 1px solid var(--gk-border-soft);
            border-left: 0;
        }

        .notices {
            max-width: calc(100% - 16px);
            top: 56px;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .loading-text {
            animation-duration: 0ms;
        }
    }
</style>
