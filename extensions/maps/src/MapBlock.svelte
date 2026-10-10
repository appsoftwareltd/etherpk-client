<script lang="ts">
    /**
     * A [[Map Block]]'s widget (ADR 0118): the live map the editor draws over a `map` fence
     * (`interactive-fence.ts`), with the controls that change what it holds.
     *
     * Everything the map shows comes from the fence's body, which the editor hands in as
     * `context.body`. Every change goes back as one line edit through `context.edit`, so it is an
     * ordinary editor change: undone with the editor's undo, synced and merged like typing, and
     * refused when the line no longer says what this widget read. Nothing about a map is kept
     * anywhere else except whether it is folded, which this device remembers.
     *
     * The map itself (`MapEngine`, MapLibre) exists only while the block is unfolded and on
     * screen: a block scrolled out of sight, or in a tab behind another, lets its WebGL context go
     * after a short grace, because a browser keeps only a few alive at once.
     */
    import { tick, untrack } from 'svelte'
    import { createSubscriber } from 'svelte/reactivity'

    import { appendFenceLine, removeFenceLine, replaceFenceLine, type FenceBodyEdit } from '$lib/document/fence-body'
    import { formatMapPoint, type MapItem, type MapPoint, readMapBody, writeMapLine, writeMapPlace, writeMapRoute } from '$lib/document/map-text'
    import type { InteractiveFenceContext } from '$lib/document/view/augmentations/interactive-fence-contract'
    import { iconSvg } from '$lib/surface/icons'

    import { MAPBOX_REFUSED_NOTE } from './basemap'
    import { readGpx } from './gpx'
    import type { PlaceSearchCredit } from '@appsoftwareltd/etherpk-shared'

    import type { MapBlockServices, PlaceSearchResult } from './map-block-services'
    import { type BasemapProblem, type EngineItem, MapEngine } from './map-engine'
    import { formatDistance, routeLengthMeters, simplifyPath } from './map-geometry'
    import { mapsAppUrl } from './maps-app-link'
    import { readSearchBox, type SearchBoxReading } from './place-input'
    import { recognisePostcode } from './postcode-search'
    import './maps.css'

    let { context, services }: { context: InteractiveFenceContext; services: MapBlockServices } = $props()
    /** This map's own, so two maps on one page never share an element id. */
    const uid = $props.id()

    /** How long a map out of sight keeps its WebGL context, so scrolling past does not rebuild it. */
    const OFF_SCREEN_GRACE_MS = 8000
    /** How long a removed place can be put back from the notice. */
    const UNDO_MS = 10000
    /** A recorded track is thinned to lie within this many metres of the recording. */
    const TRACK_TOLERANCE_M = 5
    /** And never kept at more points than this, so a long day's recording stays a short line of text. */
    const TRACK_MAX_POINTS = 2000

    /**
     * What waits for a name before it is added. A place keeps where it is in words (`detail`) and the
     * credits of the service that named it, both shown under its name and neither written down.
     */
    type Pending =
        | { kind: 'place'; point: MapPoint; name: string; detail: string; credits: PlaceSearchCredit[] }
        | { kind: 'route'; points: MapPoint[]; name: string; track: string | null }

    /** A short link the device cannot open, where no Sync Server opened it either. */
    const SHORT_LINK_NOTE = "A short link can't be read here. Open it, then copy the full address from your browser's address bar."
    /** The same, where the person switched the search and link services off. */
    const SHORT_LINK_OFF_NOTE = "Opening short links is switched off in the Maps extension's settings. Open the link, then copy the full address from your browser's address bar."
    /** A map link that names a place without saying where it is, where it cannot be searched for. */
    const NO_POSITION_NOTE = "This link doesn't say where the place is. Open it, then copy the full address from your browser's address bar."
    const UNREADABLE_LINK_NOTE = 'No place can be read from this link. Paste a link from Google Maps, Apple Maps or OpenStreetMap, or type the coordinates.'
    /** Searching as the person types waits this long after their last key, so a name is searched once, not a letter at a time. */
    const TYPING_PAUSE_MS = 500
    /** Shorter text finds too much to be worth searching before the person asks. */
    const TYPING_MIN_LENGTH = 3

    type Mode = 'idle' | 'adding' | 'drawing' | 'moving'

    const read = $derived(readMapBody(context.body))
    const items = $derived(read.items)
    /** What the map draws: each item under its line, which is how the map's clicks name it. */
    const drawn: EngineItem[] = $derived(items.map((item) => ({ ...item, key: item.line })))
    const placeCount = $derived(items.filter((item) => item.kind === 'place').length)
    const routeCount = $derived(items.length - placeCount)
    const editable = $derived(context.writable)

    // What the map is drawn over: the deployment's basemap, or the person's own Mapbox, with its
    // switch to satellite (basemap.ts). The same basemap is the same object, so nothing is redrawn
    // for nothing.
    const watchBasemaps = createSubscriber((update) => services.basemaps.subscribe(update))
    const basemap = $derived.by(() => {
        watchBasemaps()
        return services.basemaps.current(context.dark)
    })
    const mapbox = $derived.by(() => {
        watchBasemaps()
        return services.basemaps.mapbox()
    })
    const satellite = $derived.by(() => {
        watchBasemaps()
        return services.basemaps.satellite()
    })
    const refused = $derived.by(() => {
        watchBasemaps()
        return services.basemaps.refused()
    })

    // Whether the map is folded is this device's memory's, which the editor also reads for the room
    // it keeps for the map (`height` in map-fence.svelte.ts). Read again as the map's text or the
    // memory changes, so the map and its room always agree.
    const watchFolds = createSubscriber((update) => services.memory.subscribe(update))
    const folded = $derived.by(() => {
        watchFolds()
        return services.memory.folded(context)
    })
    let mode: Mode = $state('idle')
    let draft: MapPoint[] = $state([])
    let pending: Pending | null = $state(null)
    /** The selected item, by its line and its text, so an edit elsewhere cannot select another. */
    let selectedKey: { line: number; text: string } | null = $state(null)
    let renaming = $state(false)
    let renameText = $state('')
    let query = $state('')
    let searchNote: string | null = $state(null)
    let results: PlaceSearchResult[] = $state([])
    /** The results came from Great Britain's postcode data, whose credits show under them. */
    let resultsCredit = $state(false)
    /** The credits the search service asked for, shown under the places it found. */
    let searchCredits: PlaceSearchCredit[] = $state([])
    /** The name a pasted link gave the place its results were searched for, which a picked result takes. */
    let resultsName = ''
    /** The name of the place nearest a place set down by hand is being looked up (ADR 0119, 2026-10-10). */
    let naming = $state(false)
    /** Bumped when a search or a lookup may have learned that searching by name is refused here. */
    let searchChecked = $state(0)
    // The person can switch the search and link services off, or on, while the map is open.
    const watchSearch = createSubscriber((update) => services.search?.subscribe(update))
    /** Whether the search box offers searching by name: until a server refuses it, or the person switches it off. */
    const nameSearch = $derived.by(() => {
        void searchChecked
        watchSearch()
        return services.search?.availability().available ?? false
    })
    const searchPrompt = $derived(
        nameSearch ? 'Find a place, or paste coordinates or a map link' : services.postcodes ? 'Postcode, coordinates or a map link' : 'Coordinates or a map link',
    )
    /** Between two credits. Written out, since the template would trim a space at a block's edge. */
    const CREDIT_SEPARATOR = ', '
    let searching = $state(false)
    let note: string | null = $state(null)
    let basemapProblem: BasemapProblem | null = $state(null)
    let engineFailed = $state(false)
    let menuOpen = $state(false)
    let listOpen = $state(false)
    let announcement = $state('')
    let removed: { line: number; text: string; name: string } | null = $state(null)
    let dropping = $state(false)
    let importing = $state(false)
    let live = $state(false)
    let engine: MapEngine | null = $state.raw(null)
    /** The engine has drawn once, so it can be asked to show an item. */
    let ready = $state(false)
    /** A Map View asked for the selected item, and the map is to show it as soon as it is drawn. */
    let showWhenReady = false

    let searchInput: HTMLInputElement | undefined = $state()
    let nameInput: HTMLInputElement | undefined = $state()
    let renameInput: HTMLInputElement | undefined = $state()
    let renameButton: HTMLButtonElement | undefined = $state()
    let fileInput: HTMLInputElement | undefined = $state()
    let menuButton: HTMLButtonElement | undefined = $state()
    let menuElement: HTMLElement | undefined = $state()

    let searchAbort: AbortController | null = null
    let nameAbort: AbortController | null = null
    let typingTimer: ReturnType<typeof setTimeout> | null = null
    /** What was last searched for while the person typed, so a pause on the same text asks nothing more. */
    let typedSearch: string | null = null
    /** Which pending place a name lookup is for: a later one, or none, takes no answer meant for another. */
    let pendingSerial = 0
    let undoTimer: ReturnType<typeof setTimeout> | null = null

    const selected: MapItem | null = $derived.by(() => {
        const key = selectedKey
        if (!key) return null
        return items.find((item) => item.line === key.line && context.body[item.line] === key.text) ?? items.find((item) => context.body[item.line] === key.text) ?? null
    })

    function labelOf(item: { name: string; kind: 'place' | 'route' }): string {
        if (item.name !== '') return item.name
        return item.kind === 'place' ? 'Unnamed place' : 'Unnamed route'
    }

    function summary(): string {
        if (items.length === 0) return 'Empty map'
        const parts = []
        if (placeCount > 0) parts.push(`${placeCount} ${placeCount === 1 ? 'place' : 'places'}`)
        if (routeCount > 0) parts.push(`${routeCount} ${routeCount === 1 ? 'route' : 'routes'}`)
        return `Map, ${parts.join(' and ')}`
    }

    function announce(text: string): void {
        // A repeat of the same words is still read out: clear first, set on the next frame.
        announcement = ''
        requestAnimationFrame(() => (announcement = text))
    }

    /** One line edit through the editor; says so when the map changed under it. */
    function commit(change: FenceBodyEdit, done: string): boolean {
        if (!editable) return false
        const ok = context.edit(change)
        if (ok) {
            note = null
            announce(done)
        } else note = 'The map changed before this could be saved. It now shows the latest version, so try again.'
        return ok
    }

    // ---- The map's life ------------------------------------------------------------------------

    /** Settles whether the map is drawn, while the block is attached (`watchScreen`). */
    let settleScreen: (() => void) | null = null
    // The editor going behind another tab, or coming back, is told in `context.onScreen`.
    $effect(() => {
        void context.onScreen
        untrack(() => settleScreen?.())
    })

    /** Live while on screen, and for a grace after leaving it; not at all while folded. */
    function watchScreen(node: HTMLElement) {
        let intersecting = false
        let release: ReturnType<typeof setTimeout> | null = null
        const settle = () => {
            // In the editor's view, the browser tab shown, and the editor's own tab in front: a tab
            // behind another is hidden, not scrolled away, so only the editor can say.
            const visible = intersecting && document.visibilityState === 'visible' && untrack(() => context.onScreen)
            if (visible) {
                if (release) clearTimeout(release)
                release = null
                live = true
            } else if (!release) {
                release = setTimeout(() => {
                    release = null
                    live = false
                }, OFF_SCREEN_GRACE_MS)
            }
        }
        const observer = new IntersectionObserver((entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting)
            settle()
        })
        observer.observe(node)
        document.addEventListener('visibilitychange', settle)
        settleScreen = settle
        return () => {
            settleScreen = null
            observer.disconnect()
            document.removeEventListener('visibilitychange', settle)
            if (release) clearTimeout(release)
        }
    }

    /** Build the map on its element, and take it down when the element goes. */
    function attachEngine(node: HTMLElement) {
        let created: MapEngine
        try {
            created = new MapEngine(node, {
                basemap: untrack(() => basemap),
                dark: untrack(() => context.dark),
                cooperative: true,
                onReady: () => {
                    ready = true
                    if (showWhenReady && selected) created.showItem(selected.line, false)
                    else created.frame()
                    showWhenReady = false
                },
                onBasemap: (problem) => (basemapProblem = problem),
                onMapClick: mapClicked,
                onItemClick: (line) => itemClicked(line),
                onItemMoved: (line, point) => moveItem(line, point),
            })
        } catch {
            // No WebGL 2 (an old browser, or one with graphics switched off): list the places instead.
            engineFailed = true
            return
        }
        engine = created
        return () => {
            if (engine === created) {
                engine = null
                ready = false
            }
            created.destroy()
        }
    }

    $effect(() => {
        engine?.setItems(drawn, selected?.line ?? null, mode === 'moving' ? (selected?.line ?? null) : null)
    })
    $effect(() => {
        engine?.setDraft(mode === 'drawing' ? draft : pending?.kind === 'route' ? pending.points : [])
    })
    $effect(() => {
        engine?.setDark(context.dark, basemap)
    })
    $effect(() => {
        engine?.setPlacing(mode !== 'idle')
    })

    // The first time a map put in by `/map` mounts, the search box takes the keyboard.
    $effect(() => {
        if (searchInput && untrack(() => services.takeFocusRequest(context))) searchInput.focus()
    })

    // "Show in document" from a Map View: select the item it chose, whether this map is mounting
    // with the document or was drawn already. Read untracked, so an edit to the map does not
    // listen again.
    $effect(() => {
        const take = () => untrack(selectRequested)
        take()
        return services.selectRequests.subscribe(take)
    })

    function selectRequested(): void {
        const text = services.selectRequests.take(context.document, context.body)
        if (text === null) return
        const line = context.body.indexOf(text)
        if (line < 0) return
        // The person asked to see this item, so a folded map opens and anything half done is left.
        if (folded) setFolded(false)
        mode = 'idle'
        pending = null
        renaming = false
        menuOpen = false
        selectedKey = { line, text }
        if (engine && ready) engine.showItem(line)
        else showWhenReady = true
    }

    // A search or a name lookup still running when the map goes has nothing left to answer.
    $effect(() => () => {
        stopTyping()
        searchAbort?.abort()
        nameAbort?.abort()
    })

    function online() {
        if (basemapProblem === 'offline') engine?.retryBasemap(basemap)
    }

    // ---- Clicks on the map ---------------------------------------------------------------------

    function mapClicked(point: MapPoint): void {
        if (mode === 'adding') {
            mode = 'idle'
            void startPending({ kind: 'place', point, name: '', detail: '', credits: [] }, false)
        } else if (mode === 'drawing') {
            draft = [...draft, point]
        } else if (mode === 'moving' && selected?.kind === 'place') {
            moveItem(selected.line, point)
            mode = 'idle'
        } else {
            selectedKey = null
            renaming = false
        }
    }

    function itemClicked(line: number): void {
        if (mode !== 'idle') return
        menuOpen = false
        renaming = false
        selectedKey = selected?.line === line ? null : { line, text: context.body[line] }
    }

    // ---- Adding a place ------------------------------------------------------------------------

    async function startPending(next: Pending, centre: boolean): Promise<void> {
        stopNaming()
        const serial = ++pendingSerial
        pending = next
        selectedKey = null
        results = []
        if (centre && next.kind === 'place') engine?.show(next.point)
        await tick()
        nameInput?.focus()
        nameInput?.select()
        if (next.kind === 'place' && next.name === '' && nameSearch) void lookUpName(next.point, serial)
    }

    /**
     * Offer the name of the place nearest a place set down without one: filled in when it arrives,
     * unless the person has typed a name of their own by then, and never added without them.
     */
    async function lookUpName(point: MapPoint, serial: number): Promise<void> {
        const abort = new AbortController()
        nameAbort = abort
        naming = true
        try {
            const found = await services.search!.reverse(point, abort.signal)
            if (!found || serial !== pendingSerial || pending?.kind !== 'place' || pending.name.trim() !== '') return
            pending.name = found.name
            pending.detail = found.detail
            pending.credits = found.credits
            await tick()
            // Typing replaces the offered name, as it would a name a search gave.
            if (document.activeElement === nameInput) nameInput?.select()
        } catch {
            // Ended because the person moved on: nothing to offer.
        } finally {
            if (nameAbort === abort) {
                nameAbort = null
                naming = false
            }
            searchChecked++
        }
    }

    function stopNaming(): void {
        nameAbort?.abort()
        nameAbort = null
        naming = false
    }

    function savePending(event: SubmitEvent): void {
        event.preventDefault()
        if (!pending) return
        const name = pending.name.trim()
        const ok =
            pending.kind === 'place'
                ? commit(appendFenceLine(context.body, writeMapPlace(name, pending.point)), `${name || 'The place'} added.`)
                : commit(appendFenceLine(context.body, writeMapRoute(name, pending.points, pending.track)), `${name || 'The route'} added.`)
        if (ok) {
            stopNaming()
            pending = null
            searchInput?.focus()
        }
    }

    function cancelPending(): void {
        stopNaming()
        pending = null
        searchInput?.focus()
    }

    /** Enter, or the search button: act on whatever the box holds. */
    async function submitSearch(event: SubmitEvent): Promise<void> {
        event.preventDefault()
        stopTyping()
        const text = query.trim()
        if (text === '') return
        searchNote = null
        await run((signal) => follow(readSearchBox(text, engine?.centre()), signal))
    }

    /**
     * Run one search, dropping any still running, whose answer would be for other text. The places
     * already listed stay, with the busy mark beside the box, until the new answer replaces them.
     */
    async function run(act: (signal: AbortSignal) => Promise<void>): Promise<void> {
        searchAbort?.abort()
        const abort = new AbortController()
        searchAbort = abort
        searching = true
        try {
            await act(abort.signal)
        } finally {
            if (searchAbort === abort) {
                searching = false
                searchAbort = null
            }
            searchChecked++
        }
    }

    /**
     * Each change to the search box: a search still running for the old text is dropped, and the
     * new text is searched once the person pauses (`searchWhileTyping`).
     */
    function typed(): void {
        stopTyping()
        searchAbort?.abort()
        searchNote = null
        if (query.trim() === '') {
            results = []
            typedSearch = null
            return
        }
        typingTimer = setTimeout(() => {
            typingTimer = null
            searchWhileTyping()
        }, TYPING_PAUSE_MS)
    }

    function stopTyping(): void {
        if (typingTimer) clearTimeout(typingTimer)
        typingTimer = null
    }

    /**
     * Search what was typed, before Enter, when it is words that can be answered now: a postcode the
     * files hold, or a name where the search by name is open. A place or a link waits for Enter,
     * since setting one down opens the sheet and takes the keyboard, and so does anything that
     * cannot be answered, which Enter explains.
     */
    function searchWhileTyping(): void {
        const text = query.trim()
        if (text.length < TYPING_MIN_LENGTH || text === typedSearch) return
        if (readSearchBox(text, engine?.centre()).kind !== 'words') return
        const postcode = recognisePostcode(text, services.region())
        const postcodeAnswers = postcode !== null && postcode.country !== 'northern-ireland' && services.postcodes !== null
        if (!postcodeAnswers && !nameSearch) return
        typedSearch = text
        void run((signal) => search(text, signal))
    }

    /** List what a search found, in place of anything listed before. */
    function listResults(found: PlaceSearchResult[], from: { postcodeCredit: boolean; credits: PlaceSearchCredit[]; linkName: string }): void {
        results = found
        resultsCredit = from.postcodeCredit
        searchCredits = from.credits
        resultsName = from.linkName
        searchNote = null
    }

    /** Say why nothing is listed, in place of anything listed before. */
    function noteInstead(text: string): void {
        results = []
        searchNote = text
    }

    /**
     * Act on what the search box holds: set down a place read on the device, have the Sync Server
     * open a short link and read what it leads to, search for the words of a link that names a
     * place without saying where, or search for what was typed.
     */
    async function follow(reading: SearchBoxReading, signal: AbortSignal): Promise<void> {
        if (reading.kind === 'place') {
            query = ''
            await startPending({ kind: 'place', point: reading.place.point, name: reading.place.name, detail: '', credits: [] }, true)
        } else if (reading.kind === 'short-link') {
            let full: string | null = null
            try {
                full = (await services.search?.openShortLink(reading.url, signal)) ?? null
            } catch {
                return
            }
            if (signal.aborted) return
            const opened = full === null ? null : readSearchBox(full)
            if (!opened || opened.kind === 'short-link') noteInstead(services.search?.switchedOff() ? SHORT_LINK_OFF_NOTE : SHORT_LINK_NOTE)
            // The name shared with the short link, where the link it leads to carries none.
            else if (opened.kind === 'place') await follow({ kind: 'place', place: { ...opened.place, name: opened.place.name || reading.name } }, signal)
            else if (opened.kind === 'link-words') await follow({ ...opened, name: opened.name || reading.name }, signal)
            else noteInstead(UNREADABLE_LINK_NOTE)
        } else if (reading.kind === 'link-words') {
            await search(reading.words, signal, reading.name)
        } else if (reading.kind === 'unreadable-link') {
            noteInstead(UNREADABLE_LINK_NOTE)
        } else {
            await search(reading.words, signal)
        }
    }

    /**
     * A postcode from the map host's files, for everyone (ADR 0119), and anything else, or a
     * postcode the files do not hold, through the search by name and address where the person has
     * it. A postcode the files answer never goes to the search service.
     *
     * `linkName` is set for the words of a pasted link, never a URL: the place the link named, which
     * a picked result is called by.
     */
    async function search(text: string, signal: AbortSignal, linkName?: string): Promise<void> {
        const postcode = recognisePostcode(text, services.region())
        // What to say when the search by name cannot help either.
        let unanswered: string | null = null
        if (postcode?.country === 'northern-ireland') unanswered = "Northern Ireland postcodes aren't included yet."
        else if (postcode && services.postcodes) {
            try {
                const place = await services.postcodes.find(postcode)
                if (signal.aborted) return
                if (place) {
                    listResults([place], { postcodeCredit: postcode.country === 'gb', credits: [], linkName: '' })
                    return
                }
                unanswered = `No postcode ${postcode.label} was found. Check it, or type the coordinates.`
            } catch (error) {
                if (signal.aborted) return
                unanswered = error instanceof Error ? error.message : "The postcode lookup didn't finish. Try again."
            }
        }
        const availability = services.search?.availability() ?? {
            available: false,
            reason: "Searching by place name isn't set up here. Type coordinates such as 50.7486, -4.0789, or a Plus Code, or paste a link from Google Maps, Apple Maps or OpenStreetMap.",
        }
        if (!availability.available) {
            noteInstead(unanswered ?? (linkName === undefined ? availability.reason : NO_POSITION_NOTE))
            return
        }
        try {
            const found = await services.search!.search(text, engine?.centre() ?? null, signal)
            if (signal.aborted) return
            if (found.results.length === 0) noteInstead(unanswered ?? `Nothing was found for "${text}". Try other words, or type the coordinates.`)
            else listResults(found.results, { postcodeCredit: false, credits: found.credits, linkName: linkName ?? '' })
        } catch (error) {
            if (signal.aborted) return
            // A link's words the server will not search for: what helps is a link that says where.
            if (linkName !== undefined && !services.search!.availability().available) noteInstead(NO_POSITION_NOTE)
            else noteInstead(error instanceof Error ? error.message : 'The search did not finish. Try again.')
        }
    }

    function pickResult(result: PlaceSearchResult): void {
        query = ''
        void startPending({ kind: 'place', point: result.point, name: resultsName || result.name, detail: result.detail, credits: resultsCredit ? [] : searchCredits }, true)
    }

    // ---- Drawing a route -----------------------------------------------------------------------

    function startDrawing(): void {
        selectedKey = null
        pending = null
        draft = []
        mode = 'drawing'
        announce('Drawing a route. Click the map for each point, then choose Finish.')
    }

    function finishDrawing(): void {
        if (draft.length < 2) {
            note = 'A route needs at least two points. Click the map to add them.'
            return
        }
        const points = draft
        mode = 'idle'
        draft = []
        void startPending({ kind: 'route', points, name: '', track: null }, false)
    }

    // ---- The selected item ---------------------------------------------------------------------

    async function startRename(): Promise<void> {
        if (!selected) return
        renameText = selected.name
        renaming = true
        await tick()
        renameInput?.focus()
        renameInput?.select()
    }

    function saveRename(event: SubmitEvent): void {
        event.preventDefault()
        const item = selected
        if (!item) return
        const text = writeMapLine({ ...item, name: renameText })
        if (commit(replaceFenceLine(item.line, context.body[item.line], text), 'Renamed.')) {
            selectedKey = { line: item.line, text }
            void stopRenaming()
        }
    }

    /** Close the rename form, the keyboard back on the Rename button that opened it. */
    async function stopRenaming(): Promise<void> {
        renaming = false
        await tick()
        renameButton?.focus()
    }

    function moveItem(line: number, point: MapPoint): void {
        const item = items.find((candidate) => candidate.line === line)
        if (!item || item.kind !== 'place') return
        const text = writeMapPlace(item.name, point)
        if (commit(replaceFenceLine(line, context.body[line], text), `${labelOf(item)} moved.`)) {
            if (selected?.line === line) selectedKey = { line, text }
        }
    }

    function removeSelected(): void {
        const item = selected
        if (!item) return
        const text = context.body[item.line]
        if (!commit(removeFenceLine(item.line, text), `${labelOf(item)} removed.`)) return
        selectedKey = null
        mode = 'idle'
        removed = { line: item.line, text, name: labelOf(item) }
        if (undoTimer) clearTimeout(undoTimer)
        undoTimer = setTimeout(() => (removed = null), UNDO_MS)
    }

    function undoRemove(): void {
        if (!removed) return
        const back = removed
        removed = null
        if (undoTimer) clearTimeout(undoTimer)
        commit({ kind: 'insert', line: Math.min(back.line, context.body.length), text: back.text }, `${back.name} put back.`)
    }

    async function copyCoordinates(point: MapPoint): Promise<void> {
        try {
            await services.copy(formatMapPoint(point))
            services.notify('Coordinates copied.')
        } catch {
            note = "The coordinates couldn't be copied. Your browser blocked the clipboard."
        }
    }

    // ---- Importing a recording -----------------------------------------------------------------

    function thinned(points: MapPoint[]): MapPoint[] {
        let tolerance = TRACK_TOLERANCE_M
        let kept = simplifyPath(points, tolerance)
        while (kept.length > TRACK_MAX_POINTS) {
            tolerance *= 2
            kept = simplifyPath(points, tolerance)
        }
        return kept
    }

    async function importFile(file: File): Promise<void> {
        if (!editable || importing) return
        importing = true
        note = null
        try {
            let content
            try {
                content = readGpx(await file.text())
            } catch {
                note = `${file.name} isn't a GPX file. Export a GPX file from the app that recorded it, then try again.`
                return
            }
            if (content.routes.length === 0 && content.places.length === 0) {
                note = `${file.name} holds no tracks, routes or waypoints.`
                return
            }
            // The original recording is kept as an Asset the route refers to (ADR 0118): the map
            // draws a thinned copy, and nothing the file held is lost.
            let track: string | null = null
            if (content.routes.length > 0 && services.storeFile) {
                try {
                    track = await services.storeFile(file)
                } catch (error) {
                    note = `The route was added, but ${file.name} itself couldn't be kept: ${error instanceof Error ? error.message : 'the graph refused it'}.`
                }
            }
            const fallback = file.name.replace(/\.gpx$/i, '')
            for (const route of content.routes) {
                context.edit(appendFenceLine(context.body, writeMapRoute(route.name || fallback, thinned(route.points), track)))
            }
            for (const place of content.places) context.edit(appendFenceLine(context.body, writeMapPlace(place.name, place.point)))
            const parts = []
            if (content.routes.length > 0) parts.push(`${content.routes.length} ${content.routes.length === 1 ? 'route' : 'routes'}`)
            if (content.places.length > 0) parts.push(`${content.places.length} ${content.places.length === 1 ? 'place' : 'places'}`)
            announce(`Added ${parts.join(' and ')} from ${file.name}.`)
            await tick()
            engine?.frame(true)
        } finally {
            importing = false
        }
    }

    function chooseFile(): void {
        menuOpen = false
        fileInput?.click()
    }

    function fileChosen(event: Event): void {
        const input = event.currentTarget as HTMLInputElement
        const file = input.files?.[0]
        input.value = ''
        if (file) void importFile(file)
    }

    function hasFiles(event: DragEvent): boolean {
        return [...(event.dataTransfer?.types ?? [])].includes('Files')
    }

    function dragOver(event: DragEvent): void {
        if (!editable || !hasFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        dropping = true
    }

    function drop(event: DragEvent): void {
        dropping = false
        if (!editable || !hasFiles(event)) return
        event.preventDefault()
        event.stopPropagation()
        const file = [...(event.dataTransfer?.files ?? [])].find((f) => /\.gpx$/i.test(f.name) || f.type === 'application/gpx+xml')
        if (file) void importFile(file)
        else note = 'Only GPX files can be dropped on a map.'
    }

    // ---- The menu, folding, keys ---------------------------------------------------------------

    async function toggleMenu(): Promise<void> {
        menuOpen = !menuOpen
        if (!menuOpen) return
        await tick()
        menuElement?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }

    function closeMenu(): void {
        menuOpen = false
        menuButton?.focus()
    }

    function menuKeys(event: KeyboardEvent): void {
        const entries = [...(menuElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const at = entries.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            entries[(at + step + entries.length) % entries.length]?.focus()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
        }
    }

    function setFolded(next: boolean): void {
        menuOpen = false
        services.memory.setFolded(context, next)
        context.resized()
    }

    function showEverything(): void {
        menuOpen = false
        engine?.frame(true)
    }

    function editAsText(): void {
        menuOpen = false
        context.editAsText()
    }

    function deleteMap(): void {
        menuOpen = false
        if (context.remove()) services.notify('Map deleted. Press Ctrl+Z (Cmd+Z on a Mac) in the document to bring it back.')
    }

    /**
     * The block's own listeners: Escape from anywhere inside it, and a GPX file dropped anywhere
     * on it. Attached rather than written on the element, because the element is a group, not a
     * control: the keys reach it from the inputs and buttons inside, and the drop from the map.
     */
    function listen(node: HTMLElement) {
        const leave = () => (dropping = false)
        node.addEventListener('keydown', keys)
        node.addEventListener('dragover', dragOver)
        node.addEventListener('dragleave', leave)
        node.addEventListener('drop', drop)
        return () => {
            node.removeEventListener('keydown', keys)
            node.removeEventListener('dragover', dragOver)
            node.removeEventListener('dragleave', leave)
            node.removeEventListener('drop', drop)
        }
    }

    /** Escape closes the innermost open thing, one at a time. */
    function keys(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return
        if (menuOpen) closeMenu()
        else if (renaming) void stopRenaming()
        else if (pending) cancelPending()
        else if (mode === 'drawing') {
            mode = 'idle'
            draft = []
        } else if (mode !== 'idle') mode = 'idle'
        else if (results.length > 0 || searchNote) {
            results = []
            searchNote = null
        } else if (selectedKey) selectedKey = null
        else return
        event.preventDefault()
        event.stopPropagation()
    }
</script>

<svelte:window ononline={online} />

{#snippet icon(name: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo icon markup (icons.ts), never content -->
    {@html iconSvg(name)}
{/snippet}

<div
    class={['gk-map-block', { 'gk-map-block--folded': folded, 'gk-map-block--dropping': dropping }]}
    data-testid="map-block"
    data-items={items.length}
    data-state={folded ? 'folded' : engineFailed ? 'no-map' : engine ? 'live' : 'resting'}
    {@attach watchScreen}
    {@attach listen}
    role="group"
    aria-label={summary()}
>
    <div class="gk-map-sr" aria-live="polite" data-testid="map-announcement">{announcement}</div>
    {#if editable}
        <input bind:this={fileInput} class="gk-map-sr" type="file" accept=".gpx,application/gpx+xml" tabindex="-1" aria-hidden="true" onchange={fileChosen} />
    {/if}

    {#if folded}
        <div class="gk-map-folded">
            <button type="button" class="gk-map-folded-open" onclick={() => setFolded(false)} aria-expanded="false" data-testid="map-unfold">
                {@render icon('maps.map')}
                <span>{summary()}</span>
                <span class="gk-map-folded-hint">Show</span>
            </button>
        </div>
    {:else}
        {#if live && !engineFailed}
            <div class="gk-map-canvas" data-testid="map-canvas" {@attach attachEngine}></div>
        {:else if engineFailed}
            <div class="gk-map-fallback" data-testid="map-no-webgl">
                <p>This browser can't draw maps. The map's places and routes are listed here.</p>
                <ul>
                    {#each items as item (item.line)}
                        <li>
                            <strong>{labelOf(item)}</strong>
                            {item.kind === 'place' ? formatMapPoint(item.point) : formatDistance(routeLengthMeters(item.points))}
                        </li>
                    {/each}
                </ul>
            </div>
        {:else}
            <div class="gk-map-resting" aria-hidden="true"></div>
        {/if}

        <div class="gk-map-top">
            {#if editable}
                <form class="gk-map-search" role="search" onsubmit={submitSearch}>
                    <span class="gk-map-search-icon">{@render icon('search')}</span>
                    <input
                        bind:this={searchInput}
                        bind:value={query}
                        oninput={typed}
                        type="search"
                        enterkeyhint="search"
                        placeholder={searchPrompt}
                        aria-label={searchPrompt}
                        aria-describedby={searchNote ? `${uid}-search-note` : undefined}
                        autocomplete="off"
                        spellcheck="false"
                        data-testid="map-search"
                    />
                    {#if searching}<span class="gk-map-search-busy" aria-label="Searching" role="status"></span>{/if}
                    <!-- Enter does the same; the return key's mark says so. -->
                    <button type="submit" class="gk-map-search-go" disabled={query.trim() === ''} title="Search (Enter)" aria-label="Search" data-testid="map-search-go">
                        {@render icon('maps.enter')}
                    </button>
                </form>
            {:else}
                <span class="gk-map-title">{summary()}</span>
            {/if}
            <div class="gk-map-actions">
                {#if mapbox}
                    <button
                        type="button"
                        class="gk-map-icon-button"
                        title="Satellite"
                        aria-label="Satellite"
                        aria-pressed={satellite}
                        onclick={() => services.basemaps.setSatellite(!satellite)}
                        data-testid="map-satellite"
                    >
                        {@render icon('maps.layers')}
                    </button>
                {/if}
                <button type="button" class="gk-map-icon-button" title="Places and routes" aria-label="Places and routes" aria-pressed={listOpen} onclick={() => (listOpen = !listOpen)} data-testid="map-list-toggle">
                    {@render icon('list')}
                </button>
                <button type="button" class="gk-map-icon-button" title="Fold the map" aria-label="Fold the map" aria-expanded="true" onclick={() => setFolded(true)} data-testid="map-fold">
                    {@render icon('fold')}
                </button>
                <button
                    bind:this={menuButton}
                    type="button"
                    class="gk-map-icon-button"
                    title="More"
                    aria-label="More map actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onclick={toggleMenu}
                    data-testid="map-menu"
                >
                    {@render icon('more')}
                </button>
                {#if menuOpen}
                    <div bind:this={menuElement} class="gk-map-menu" role="menu" aria-label="Map actions" tabindex="-1" onkeydown={menuKeys} data-testid="map-menu-items">
                        <button type="button" role="menuitem" onclick={showEverything}>{@render icon('fit')}Show everything</button>
                        {#if editable && services.storeFile}
                            <button type="button" role="menuitem" onclick={chooseFile} data-testid="map-import">{@render icon('import')}Import a GPX file…</button>
                        {/if}
                        {#if editable}
                            <button type="button" role="menuitem" onclick={editAsText} data-testid="map-edit-as-text">{@render icon('code')}Edit as text</button>
                            <button type="button" role="menuitem" class="gk-map-danger" onclick={deleteMap} data-testid="map-delete">{@render icon('trash')}Delete map</button>
                        {/if}
                    </div>
                {/if}
            </div>
        </div>

        <div class="gk-map-notices">
            {#if searchNote}
                <p id="{uid}-search-note" class="gk-map-notice" role="status" data-testid="map-search-note">{searchNote}</p>
            {/if}
            {#if results.length > 0}
                <ul class="gk-map-results" aria-label="Search results" data-testid="map-results">
                    {#each results as result (`${result.point.lat},${result.point.lon},${result.name}`)}
                        <li>
                            <button type="button" onclick={() => pickResult(result)}>
                                <span class="gk-map-result-name">{result.name}</span>
                                {#if result.detail}<span class="gk-map-result-detail">{result.detail}</span>{/if}
                            </button>
                        </li>
                    {/each}
                </ul>
                {#if resultsCredit}
                    <!-- The Open Government Licence's credits, in full on the Maps page. -->
                    <p class="gk-map-results-credit" data-testid="map-postcode-credit">
                        <a href="https://docs.etherpk.com/maps#postcode-data" target="_blank" rel="noopener noreferrer">Postcode data: OS, Royal Mail, ONS</a>
                    </p>
                {:else if searchCredits.length > 0}
                    <!-- The credits the search service asks for: OpenStreetMap's, and Geoapify's on its Free plan. -->
                    <p class="gk-map-results-credit" data-testid="map-search-credit">
                        {#each searchCredits as credit, index (credit.url)}{#if index > 0}{CREDIT_SEPARATOR}{/if}<a
                                href={credit.url}
                                target="_blank"
                                rel="noopener noreferrer">{credit.text}</a
                            >{/each}
                    </p>
                {/if}
            {/if}
            {#if note}
                <p class="gk-map-notice gk-map-notice--warn" role="status" data-testid="map-note">{note}</p>
            {/if}
            {#if read.unread.length > 0}
                <p class="gk-map-notice gk-map-notice--warn" data-testid="map-unread">
                    {read.unread.length === 1 ? "1 line can't be read as a place or a route." : `${read.unread.length} lines can't be read as places or routes.`}
                    {#if editable}<button type="button" class="gk-map-link-button" onclick={editAsText}>Edit as text</button>{/if}
                </p>
            {/if}
            {#if refused}
                <p class="gk-map-notice gk-map-notice--warn" role="status" data-testid="map-mapbox-refused">{MAPBOX_REFUSED_NOTE}</p>
            {/if}
            {#if basemapProblem === 'offline'}
                <p class="gk-map-notice" role="status" data-testid="map-basemap">You're offline. Places and routes are shown without the map.</p>
            {:else if basemapProblem === 'unavailable'}
                <p class="gk-map-notice" role="status" data-testid="map-basemap">
                    The map couldn't load. Places and routes are shown without it.
                    <button type="button" class="gk-map-link-button" onclick={() => engine?.retryBasemap(basemap)}>Try again</button>
                </p>
            {/if}
            {#if removed}
                <p class="gk-map-notice" role="status" data-testid="map-removed">
                    {removed.name} removed.
                    <button type="button" class="gk-map-link-button" onclick={undoRemove} data-testid="map-undo-remove">Undo</button>
                </p>
            {/if}
        </div>

        {#if listOpen}
            <div class="gk-map-list" data-testid="map-list">
                {#if items.length === 0}
                    <p>Nothing on this map yet.</p>
                {:else}
                    <ul>
                        {#each items as item (item.line)}
                            <li>
                                <button type="button" aria-pressed={selected?.line === item.line} onclick={() => itemClicked(item.line)}>
                                    {@render icon(item.kind === 'place' ? 'pin' : 'maps.route')}
                                    <span>{labelOf(item)}</span>
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>
        {/if}

        <!-- An empty map has no notice over it, which covered the map where a place is clicked:
             the search box's own words say what to do, and the block's label says it is empty. -->
        <div class="gk-map-bottom">
            {#if pending}
                <form class="gk-map-sheet" onsubmit={savePending} data-testid="map-pending">
                    <label class="gk-map-field">
                        <span>{pending.kind === 'place' ? 'Name this place' : 'Name this route'}</span>
                        <input
                            bind:this={nameInput}
                            bind:value={pending.name}
                            type="text"
                            autocomplete="off"
                            aria-describedby="{uid}-pending-where"
                            aria-busy={naming}
                            data-testid="map-pending-name"
                        />
                    </label>
                    <div id="{uid}-pending-where">
                        <!-- Where the place is, in words: a search result's address, or the nearest place's,
                             a line held open while that is looked up so the sheet barely moves. -->
                        {#if pending.kind === 'place' && (pending.detail || naming)}
                            <p class="gk-map-sheet-detail" data-testid="map-pending-detail">{pending.detail || 'Finding a name…'}</p>
                        {/if}
                        <p class="gk-map-sheet-detail">
                            {pending.kind === 'place' ? formatMapPoint(pending.point) : formatDistance(routeLengthMeters(pending.points))}
                        </p>
                    </div>
                    {#if pending.kind === 'place' && pending.credits.length > 0}
                        <!-- The credits of the service that named the place, which its terms ask for beside its answers. -->
                        <p class="gk-map-sheet-credit" data-testid="map-pending-credit">
                            {#each pending.credits as credit, index (credit.url)}{#if index > 0}{CREDIT_SEPARATOR}{/if}<a
                                    href={credit.url}
                                    target="_blank"
                                    rel="noopener noreferrer">{credit.text}</a
                                >{/each}
                        </p>
                    {/if}
                    <div class="gk-map-sheet-actions">
                        <button type="submit" class="gk-map-button gk-map-button--primary" data-testid="map-pending-add">{pending.kind === 'place' ? 'Add place' : 'Add route'}</button>
                        <button type="button" class="gk-map-button" onclick={cancelPending}>Cancel</button>
                    </div>
                </form>
            {:else if mode === 'drawing'}
                <div class="gk-map-sheet" data-testid="map-drawing">
                    <p class="gk-map-sheet-detail">
                        {draft.length === 0
                            ? 'Click the map where the route starts.'
                            : `${draft.length} ${draft.length === 1 ? 'point' : 'points'}${draft.length > 1 ? `, ${formatDistance(routeLengthMeters(draft))}` : ''}. Click the map for the next point.`}
                    </p>
                    <div class="gk-map-sheet-actions">
                        <button type="button" class="gk-map-button gk-map-button--primary" onclick={finishDrawing} data-testid="map-finish-route">Finish</button>
                        <button type="button" class="gk-map-button" onclick={() => (draft = draft.slice(0, -1))} disabled={draft.length === 0}>Undo point</button>
                        <button
                            type="button"
                            class="gk-map-button"
                            onclick={() => {
                                mode = 'idle'
                                draft = []
                            }}>Cancel</button
                        >
                    </div>
                </div>
            {:else if mode === 'adding'}
                <div class="gk-map-sheet" data-testid="map-adding">
                    <p class="gk-map-sheet-detail">Click the map where the place is.</p>
                    <div class="gk-map-sheet-actions">
                        <button type="button" class="gk-map-button" onclick={() => (mode = 'idle')}>Cancel</button>
                    </div>
                </div>
            {:else if selected}
                <div class="gk-map-sheet" data-testid="map-selected">
                    {#if renaming}
                        <form class="gk-map-rename" onsubmit={saveRename}>
                            <label class="gk-map-field">
                                <span>Rename</span>
                                <input bind:this={renameInput} bind:value={renameText} type="text" autocomplete="off" data-testid="map-rename-input" />
                            </label>
                            <div class="gk-map-sheet-actions">
                                <button type="submit" class="gk-map-button gk-map-button--primary">Save</button>
                                <button type="button" class="gk-map-button" onclick={stopRenaming}>Cancel</button>
                            </div>
                        </form>
                    {:else}
                        <div class="gk-map-selected-head">
                            <strong class="gk-map-selected-name" data-testid="map-selected-name">{labelOf(selected)}</strong>
                            <span class="gk-map-sheet-detail">
                                {selected.kind === 'place' ? formatMapPoint(selected.point) : formatDistance(routeLengthMeters(selected.points))}
                                {#if selected.kind === 'route' && selected.track}<span>, from a recording</span>{/if}
                            </span>
                            <button type="button" class="gk-map-icon-button gk-map-close" aria-label="Close" onclick={() => (selectedKey = null)}>{@render icon('close')}</button>
                        </div>
                        {#if mode === 'moving'}
                            <p class="gk-map-sheet-detail">Drag the pin, or click the map where it should go.</p>
                        {/if}
                        <div class="gk-map-sheet-actions">
                            {#if editable}
                                <button bind:this={renameButton} type="button" class="gk-map-button" onclick={startRename} data-testid="map-rename">{@render icon('rename')}Rename</button>
                                {#if selected.kind === 'place'}
                                    <button type="button" class="gk-map-button" aria-pressed={mode === 'moving'} onclick={() => (mode = mode === 'moving' ? 'idle' : 'moving')} data-testid="map-move">
                                        {@render icon('move')}{mode === 'moving' ? 'Done' : 'Move'}
                                    </button>
                                {/if}
                            {/if}
                            {#if selected.kind === 'place'}
                                {@const point = selected.point}
                                <button type="button" class="gk-map-button" onclick={() => copyCoordinates(point)} data-testid="map-copy">{@render icon('copy')}Copy coordinates</button>
                                <a class="gk-map-button" href={mapsAppUrl(point, selected.name, services.apple)} target="_blank" rel="noopener noreferrer" data-testid="map-open-app">
                                    {@render icon('open-external')}Open in maps app
                                </a>
                            {/if}
                            {#if editable}
                                <button type="button" class="gk-map-button gk-map-danger" onclick={removeSelected} data-testid="map-remove">{@render icon('trash')}Remove</button>
                            {/if}
                        </div>
                    {/if}
                </div>
            {:else if editable}
                <div class="gk-map-tools">
                    <button type="button" class="gk-map-button" onclick={() => ((mode = 'adding'), (selectedKey = null))} data-testid="map-add-place">{@render icon('pin')}<span>Add a place</span></button>
                    <button type="button" class="gk-map-button" onclick={startDrawing} data-testid="map-draw-route">{@render icon('maps.route')}<span>Draw a route</span></button>
                    {#if importing}<span class="gk-map-sheet-detail" role="status">Importing…</span>{/if}
                </div>
            {/if}
        </div>
    {/if}
</div>
