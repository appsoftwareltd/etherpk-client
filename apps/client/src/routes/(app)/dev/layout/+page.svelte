<script lang="ts">
    /**
     * Dev harness for the Layout system (`/dev/layout`, 404 in production).
     *
     * Mounts the *real* presenters over a View registry swapped to DevView, wired
     * to LocalLayoutStore (per-graph persistence) and the settings cookie
     * (sidebar-collapse mirror). The presenter toggle swaps between the desktop
     * dockview adapter and the mobile single-active-View presenter — same
     * controller, same state model — by serialize/restore across the swap. It is
     * both the manual exploration surface and the Playwright fixture: every
     * interactive element carries a data-testid and the live model is dumped.
     */
    import { onMount, tick } from 'svelte'

    import { dev } from '$app/environment'
    import {
        LAYOUT_VERSION,
        createLayoutController,
        createLocalLayoutStore,
        createViewRegistry,
        type LayoutController,
        type LayoutRenderer,
        type LayoutStore,
        type OpenMode,
        type PaneHandle,
        type Region,
        type ViewRef,
    } from '$lib/layout'
    import { DocumentView, createInMemoryDocumentStore, setActiveDocumentStore } from '$lib/document'
    import DevView from '$lib/layout/dev/DevView.svelte'
    import { devViewStats, resetDevViewStats } from '$lib/layout/dev/dev-view-state.svelte'
    import MobilePresenter from '$lib/layout/renderers/MobilePresenter.svelte'
    import {
        readSettingsFromDocument,
        withSidebarCollapsed,
        writeSettingsToDocument,
    } from '$lib/settings'

    import type { MobileRenderer } from '$lib/layout/renderers/mobile-renderer.svelte'

    const GRAPH_ID = 'dev'
    const REGIONS: Region[] = ['main', 'left-sidebar', 'right-sidebar']
    const MODES: OpenMode[] = ['reveal', 'tab', 'split-right', 'split-down', 'split-left', 'split-up']
    const KINDS: { kind: string; naturalRegion?: Region }[] = [
        { kind: 'document' },
        { kind: 'asset' },
        { kind: 'backlinks', naturalRegion: 'right-sidebar' },
        { kind: 'document-tree', naturalRegion: 'left-sidebar' },
        { kind: 'tasks', naturalRegion: 'right-sidebar' },
        { kind: 'quick-notes', naturalRegion: 'left-sidebar' },
    ]

    const registry = createViewRegistry()
    for (const { kind, naturalRegion } of KINDS) registry.register({ kind, component: DevView, naturalRegion })

    // Editor-lifecycle: register the real CodeMirror DocumentView additively (a
    // distinct `document-editor` kind), so the existing fake-DevView kinds and
    // their tests are unaffected. Proves editor state survives dockview ops.
    const docStore = createInMemoryDocumentStore({ 'lifecycle-doc': '# Lifecycle\n\nType here.' })
    setActiveDocumentStore(docStore)
    registry.register({ kind: 'document-editor', component: DocumentView })

    let container = $state<HTMLDivElement>()
    let controller = $state<LayoutController>()
    let mobileRenderer = $state<MobileRenderer>()
    let renderer: LayoutRenderer | undefined
    let store: LayoutStore | undefined

    // Command-bar state.
    let target = $state('doc-A')
    let region = $state<Region>('main')
    let mode = $state<OpenMode>('reveal')
    let forceNew = $state(false)
    let useMobile = $state(false)

    // Live readouts.
    let serialized = $state('{}')
    let activeLabel = $state('—')

    const handles = new Map<string, PaneHandle>()

    const onSidebarToggle = (side: 'left' | 'right', collapsed: boolean) => {
        // Controller owns visibility; mirror it into the chrome settings cookie.
        writeSettingsToDocument(withSidebarCollapsed(readSettingsFromDocument(), side, collapsed))
    }

    function refresh() {
        if (!controller) return
        const snapshot = controller.serialize()
        serialized = JSON.stringify(snapshot.model, null, 2)
        activeLabel = snapshot.model.activePanelId ?? '—'
        void store?.save(GRAPH_ID, snapshot)
    }

    function withRefresh<T>(fn: () => T): T {
        const result = fn()
        refresh()
        return result
    }

    function openTracked(view: ViewRef, opts: { region?: Region; mode?: OpenMode; forceNew?: boolean } = {}) {
        if (!controller) return
        const h = controller.openView(view, opts)
        handles.set(h.panelId, h)
        refresh()
    }

    function closeActive() {
        if (!controller) return
        const active = controller.serialize().model.activePanelId
        if (active && handles.has(active)) withRefresh(() => handles.get(active)!.close())
    }

    /** Wait until an element has a real laid-out size (a few frames at most). */
    async function waitForSize(el: HTMLElement) {
        for (let i = 0; i < 20 && (el.clientHeight === 0 || el.clientWidth === 0); i++) {
            await new Promise((r) => requestAnimationFrame(() => r(null)))
        }
    }

    async function build(model?: import('$lib/layout').LayoutModel) {
        const initial = model ? { version: LAYOUT_VERSION, model } : await store!.load(GRAPH_ID)
        if (useMobile) {
            const { createMobileRenderer } = await import('$lib/layout/renderers/mobile-renderer.svelte')
            mobileRenderer = createMobileRenderer(registry)
            renderer = mobileRenderer
        } else {
            const { createDockviewRenderer } = await import('$lib/layout/renderers/dockview-adapter')
            mobileRenderer = undefined
            // dockview computes split proportions from the container's size, so it
            // must be laid out before we create and populate it — otherwise the
            // sidebars' pixel widths are applied against a zero-size container.
            await waitForSize(container!)
            renderer = createDockviewRenderer({
                container: container!,
                registry,
            })
        }
        controller = createLayoutController({ renderer, registry, onSidebarToggle })
        controller.restore(initial) // null → defaultLayout()
        if (dev) (window as unknown as { __layout: LayoutController }).__layout = controller
        refresh()
    }

    async function switchPresenter(mobile: boolean) {
        if (mobile === useMobile) return
        const snapshot = controller?.serialize().model
        renderer?.destroy?.()
        controller = undefined
        renderer = undefined
        mobileRenderer = undefined
        useMobile = mobile
        await tick() // let the DOM swap so the dockview container exists when needed
        await build(snapshot)
    }

    onMount(() => {
        store = createLocalLayoutStore()
        let disposed = false
        ;(async () => {
            await tick()
            if (!disposed) await build()
        })()
        return () => {
            disposed = true
            renderer?.destroy?.()
        }
    })
</script>

<svelte:head><title>/dev/layout</title></svelte:head>

<div class="harness">
    <div class="bar" data-testid="command-bar">
        <span class="grp" title="Open an arbitrary document View. Region = where it docks; mode = how (reveal/tab/split). forceNew opts out of the singleton rule.">
            open:
            <input data-testid="open-target" bind:value={target} placeholder="target" title="The View's target (e.g. a document name)" />
            <select data-testid="open-region" bind:value={region} title="Which region to open into">
                {#each REGIONS as r (r)}<option value={r}>{r}</option>{/each}
            </select>
            <select data-testid="open-mode" bind:value={mode} title="How to place it">
                {#each MODES as m (m)}<option value={m}>{m}</option>{/each}
            </select>
            <label title="Open a deliberate second copy instead of focusing the existing one"><input type="checkbox" data-testid="open-forcenew" bind:checked={forceNew} /> forceNew</label>
            <button data-testid="open-view" onclick={() => openTracked({ kind: 'document', target }, { region, mode, forceNew })}>
                Open View
            </button>
        </span>

        <span class="grp" title="One-click opens. Open the same one twice to see the singleton rule: it focuses, it does not remount (watch the mounts counter).">
            quick:
            <button data-testid="quick-doc-a" title="Open document:doc-A in main" onclick={() => openTracked({ kind: 'document', target: 'doc-A' })}>doc A</button>
            <button data-testid="quick-doc-b" title="Open document:doc-B in main" onclick={() => openTracked({ kind: 'document', target: 'doc-B' })}>doc B</button>
            <button data-testid="quick-backlinks" title="Open backlinks:doc-A — lands in the right sidebar (its natural region)" onclick={() => openTracked({ kind: 'backlinks', target: 'doc-A' })}>backlinks→R</button>
            <button data-testid="quick-tasks" title="Open tasks:tasks — lands in the right sidebar beside backlinks" onclick={() => openTracked({ kind: 'tasks', target: 'tasks' })}>tasks→R</button>
            <button data-testid="quick-asset" title="Open asset:img-1 in main" onclick={() => openTracked({ kind: 'asset', target: 'img-1' }, { region: 'main' })}>asset→main</button>
            <button data-testid="quick-open-editor" title="Open the real CodeMirror editor in main" onclick={() => openTracked({ kind: 'document-editor', target: 'lifecycle-doc' })}>editor→main</button>
        </span>

        <span class="grp" title="Close Views. 'active' closes whichever View is focused (incl. a forceNew copy). 'doc-A' closes the canonical document:doc-A only — forceNew copies keep their own handle and are not closed by ref.">
            close:
            <button data-testid="close-active" title="Close the focused View" onclick={closeActive}>active</button>
            <button data-testid="close-doc-a" title="Close the canonical document:doc-A (not its forceNew copies)" onclick={() => withRefresh(() => controller?.closeView({ kind: 'document', target: 'doc-A' }))}>doc A</button>
        </span>

        <span class="grp" title="Collapse / expand a docked Sidebar region. Also writes the sidebar-collapsed settings cookie.">
            sidebars:
            <button data-testid="toggle-left" title="Collapse/expand the left sidebar" onclick={() => withRefresh(() => controller?.toggleSidebar('left'))}>toggle L</button>
            <button data-testid="toggle-right" title="Collapse/expand the right sidebar" onclick={() => withRefresh(() => controller?.toggleSidebar('right'))}>toggle R</button>
        </span>

        <span class="grp" title="Swap presenters over the same controller + state. Desktop = dockview; force-mobile = single-active-View presenter.">
            view:
            <label><input type="radio" name="presenter" data-testid="view-desktop" checked={!useMobile} onchange={() => switchPresenter(false)} /> desktop</label>
            <label><input type="radio" name="presenter" data-testid="view-mobile" checked={useMobile} onchange={() => switchPresenter(true)} /> force-mobile</label>
        </span>

        <span class="grp" title="reset clears the saved layout back to the default; reload proves persistence (LocalLayoutStore + cookie) survives a full page load.">
            state:
            <button
                data-testid="reset"
                title="Clear stored layout and return to the default"
                onclick={() =>
                    withRefresh(() => {
                        handles.clear()
                        resetDevViewStats()
                        void store?.clear(GRAPH_ID)
                        controller?.restore(null)
                    })}>reset</button>
            <button data-testid="reload" title="Full page reload — layout should restore from the store" onclick={() => location.reload()}>⟳ reload</button>
        </span>

        <span class="grp readout" title="mounts = total DevViews ever mounted (singleton reveal must NOT increment it; forceNew must). live = currently mounted. active = focused panel id.">
            <span data-testid="devview-mounts">mounts: {devViewStats.mounts}</span>
            <span data-testid="devview-live">live: {devViewStats.live}</span>
            <span data-testid="active-view">active: {activeLabel}</span>
        </span>
    </div>

    {#if useMobile}
        <div class="surface">
            {#if controller && mobileRenderer}
                <MobilePresenter {controller} renderer={mobileRenderer} />
            {/if}
        </div>
    {:else}
        <!-- dockview applies the Compass theme class to its own root via the
             adapter's `theme` option, so the container needs no theme class. -->
        <div bind:this={container} data-testid="layout-container" class="layout"></div>
    {/if}

    <pre class="state" data-testid="state">{serialized}</pre>
</div>

<style>
    .harness {
        /* Fill the (app) content area beneath the full-width top navbar (h-14 =
           3.5rem). No left offset — the app has no side rail; the pane Layout
           provides its own Sidebars. */
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        grid-template-rows: auto 1fr auto;
        /* Clamp the single column to the viewport so a wide grid child (the state
           dump's `white-space: pre`, a long tab strip) cannot stretch the surface
           past the screen — otherwise the mobile presenter renders wider than the
           viewport and right-edge chrome (the overflow chevron) falls off-screen. */
        grid-template-columns: minmax(0, 1fr);
        font:
            13px/1.4 system-ui,
            sans-serif;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
    }
    .bar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem 1rem;
        align-items: center;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-0);
    }
    .grp {
        display: inline-flex;
        gap: 0.35rem;
        align-items: center;
    }
    .grp.readout {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        opacity: 0.85;
    }
    .bar button,
    .bar input,
    .bar select {
        border: 1px solid var(--gk-border-soft);
        border-radius: 5px;
        padding: 0.2rem 0.45rem;
        background: var(--gk-surface-1);
        color: inherit;
        font: inherit;
    }
    .bar button {
        cursor: pointer;
    }
    .bar input[data-testid='open-target'] {
        width: 6rem;
    }
    /* Both presenters occupy the 1fr grid row directly. `min-height: 0` lets the
       track resolve to a fixed size (not content height) so dockview measures a
       real height at init and fills it. */
    .surface {
        position: relative;
        overflow: hidden;
        min-height: 0;
    }
    .layout {
        position: relative;
        overflow: hidden;
        min-height: 0;
    }
    .state {
        max-height: 11rem;
        overflow: auto;
        margin: 0;
        padding: 0.5rem 0.75rem;
        border-top: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-0);
        font:
            11px/1.4 ui-monospace,
            monospace;
        white-space: pre;
    }
</style>
