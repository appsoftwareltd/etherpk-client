<script lang="ts">
    /**
     * The mobile presenter: one active View at a time, an "open panes" tab strip
     * for the rest of `main`, and the Sidebars as overlay drawers. It reads the
     * same shared model off the {@link LayoutController} (re-read whenever the
     * mobile renderer's revision bumps) and drives the controller back through the
     * identical API — `focusView` to switch tabs, `toggleSidebar` to close a drawer.
     */
    import { untrack, type Snippet } from 'svelte'

    import type { LayoutController, LayoutModel, Region, ViewInstance } from '$lib/layout'
    import { attachContextMenu, type ContextMenuTarget, tryGetActiveCommandRegistry } from '$lib/surface'

    import CommandBar from './CommandBar.svelte'
    import HScrollbar from './HScrollbar.svelte'
    import type { MobileRenderer } from './mobile-renderer.svelte'
    import SidebarToggleIcon from './SidebarToggleIcon.svelte'
    import { markIcon, tabTitleWidth, type TabMark } from './tab-renderer'
    import { iconSvg } from '$lib/surface/icons'
    import { unavailableViewMessage } from './unavailable-view'

    let {
        controller,
        renderer,
        markFor = () => null,
        status,
    }: {
        controller: LayoutController
        renderer: MobileRenderer
        /**
         * The padlock state for a panel's tab, or null for anything unprotected. Same indicator as
         * the desktop tab strip: a tab is the one place you scan to see what you have left open,
         * and whether a [[Protected Document]] is readable right now is invisible from its title.
         */
        markFor?: (panelId: string) => TabMark | null
        /**
         * A status control for the top bar, before Tasks: the synced workspace's sync chip. A
         * snippet, so this presenter learns nothing about sync.
         */
        status?: Snippet
    } = $props()

    // Re-derive the model whenever the renderer signals a mutation.
    const model = $derived.by<LayoutModel>(() => {
        void renderer.rev
        return controller.serialize().model
    })

    const mainViews = $derived(model.regions.main.panes.flatMap((p) => p.views))
    /**
     * The main region's tab in front: the globally focused View while that is a main one, else
     * the tab the region itself remembers as active. Focus leaves main whenever a Command
     * reveals a drawer's View (Tasks, Show backlinks from a tab's menu), and falling back to the
     * FIRST tab there switched the editor behind the drawer, and the strip's mark, to whatever
     * was opened first (2026-09-22).
     */
    const activeMain = $derived.by(() => {
        const focused = mainViews.find((v) => v.panelId === model.activePanelId)
        if (focused) return focused
        const main = model.regions.main
        const pane = main.panes.find((p) => p.id === main.activePaneId) ?? main.panes[0]
        return pane?.views.find((v) => v.panelId === pane.activePanelId) ?? mainViews[0]
    })
    const leftOpen = $derived(!model.regions['left-sidebar'].collapsed)
    const rightOpen = $derived(!model.regions['right-sidebar'].collapsed)

    function component(kind: string) {
        return renderer.registry.get(kind)?.component
    }

    /**
     * The [[Context Menu]] target a main-strip tab stands for - the same mapping the dockview
     * adapter makes for a desktop tab: a document's rows for a document, and for anything else
     * (an Asset, All Documents) only the tab-management rows, which are the reason such a tab
     * has a menu at all. The presenter has the View and the panel id to hand, so unlike the
     * adapter it needs no label lookup.
     */
    function tabTarget(v: ViewInstance): ContextMenuTarget {
        return v.view.kind === 'document'
            ? { kind: 'document-tab', concept: v.view.target, panelId: v.panelId }
            : { kind: 'tab', panelId: v.panelId }
    }

    /**
     * Right-click and long-press on a tab, both raising the menu. The attachment returns its
     * cleanup directly; the movement guard, the swallowed click that would otherwise switch the
     * tab under the open menu, and the `touch-action` / `user-select` the element must carry
     * are all `attachContextMenu`'s (see the `.tab` rule below for the last).
     */
    function tabMenu(v: ViewInstance) {
        return (node: HTMLElement) => attachContextMenu(node, () => tabTarget(v))
    }

    // The Tasks button is offered only where the workspace registered its Command — read once,
    // the registry is not reactive and the button set is fixed at mount.
    const hasTasksCommand = tryGetActiveCommandRegistry()?.has('tasks.open') ?? false
    /**
     * Open the Tasks View, then enforce this presenter's one-drawer rule. The Command itself
     * expands the right Sidebar (it does that on desktop too), but it knows nothing about the
     * mobile rule that opening one drawer closes the other — that rule lives here.
     */
    function openTasks() {
        void tryGetActiveCommandRegistry()?.execute('tasks.open')
        controller.toggleSidebar('left', false)
    }
    /**
     * Toggle a sidebar, enforcing the mobile rule that only one drawer is open at a
     * time: opening one closes the other. (Closing leaves the other untouched.)
     */
    function toggleSidebarExclusive(side: 'left' | 'right') {
        const opening = side === 'left' ? !leftOpen : !rightOpen
        // Through the Command where there is one, so a closed resident comes back on a phone
        // exactly as it does from the chord (workspace/residents.ts); the layout harness has no
        // registry and toggles the region directly.
        const registry = tryGetActiveCommandRegistry()
        const command = side === 'left' ? 'layout.toggleSidebar' : 'layout.toggleBacklinks'
        if (registry?.has(command)) void registry.execute(command)
        else controller.toggleSidebar(side)
        if (opening) controller.toggleSidebar(side === 'left' ? 'right' : 'left', false)
    }
    /**
     * A Sidebar that is COVERING the content dismisses itself when the user opens something
     * into the main region.
     *
     * The same rule holds on desktop, where it does nothing: there the Sidebar is a dock
     * column beside the content and covers nothing. Here it is an overlay, so it closes -
     * you asked to see something, so it stops sitting on top of it. Living here rather than
     * in the callers means it holds for every way a document gets opened: [[Quick Find]], a
     * [[Favourite]], a [[Recents]] row, [[All Documents]], a [[Backlink]] reference, a
     * [[Search]] result, history navigation, and whatever comes next.
     *
     * Keyed on the renderer's `focusRev` (see its doc comment) rather than on the active
     * panel id, because tapping the document that is ALREADY active changes no state - and
     * that is precisely when a drawer sitting over it is most annoying.
     */
    // One drawer at a time is this presenter's rule, and a Layout can arrive with both open: a
    // desktop opens with both Sidebars expanded (2026-09-18) and the viewport may then shrink
    // across the breakpoint, or a phone may load a Layout a desktop saved. The left drawer is the
    // one a phone shows first, so the right one closes. Once, at mount, from the model as it was
    // handed over; toggleSidebarExclusive keeps the rule for the toggles after.
    untrack(() => {
        if (leftOpen && rightOpen) controller.toggleSidebar('right', false)
    })

    // A Command that expands a Sidebar knows nothing of the rule: Alt+B, or Show backlinks from
    // a tab's menu, which the strip above the drawers offers with a drawer open. Its drawer
    // opening beside the other must close the other, so whenever the model shows both open
    // after mount, the one the user did not just reach for closes. The toggles close the other
    // drawer themselves before the model can show both, so they never come through here.
    let leftWasOpen = untrack(() => leftOpen)
    $effect(() => {
        const left = leftOpen
        const right = rightOpen
        const leftJustOpened = left && !leftWasOpen
        leftWasOpen = left
        if (left && right) controller.toggleSidebar(leftJustOpened ? 'right' : 'left', false)
    })

    let seenFocusRev = untrack(() => renderer.focusRev)
    $effect(() => {
        const rev = renderer.focusRev
        if (rev === seenFocusRev) return
        seenFocusRev = rev
        const panelId = renderer.lastFocusedPanelId
        // Only a MAIN-region View dismisses the drawers: opening a View into a Sidebar must
        // not close the Sidebar showing it.
        if (!panelId || !untrack(() => mainViews).some((v) => v.panelId === panelId)) return
        // A closed drawer told to close is a no-op at the controller: no persistence write.
        controller.toggleSidebar('left', false)
        controller.toggleSidebar('right', false)
    })

    function activeOf(region: Region): ViewInstance | undefined {
        const panes = model.regions[region].panes
        const pane = panes[0]
        if (!pane) return undefined
        return pane.views.find((v) => v.panelId === pane.activePanelId) ?? pane.views[0]
    }

    /**
     * Every View docked in a region. A drawer shows one View at a time, so with two or more
     * docked there has to be a way back to the others — without one, opening the second View
     * strands the first with no control that reaches it. Read from the region model rather
     * than hard-coded, so this holds for whatever docks here next, in either drawer.
     */
    function viewsIn(region: Region): ViewInstance[] {
        return model.regions[region].panes.flatMap((pane) => pane.views)
    }

    // --- Dedicated tab scrollbar -------------------------------------------------
    // The native horizontal scrollbar on the tab strip is hard to grab on touch, so it
    // is hidden and replaced by the shared {@link HScrollbar} in its own row below the
    // nav controls. `tabsOverflow` is bound out of that component.
    let tabsEl = $state<HTMLDivElement>()
    let tabsOverflow = $state(false)

    // --- Overflow tab menu -------------------------------------------------------
    // When the strip overflows, a chevron (no count) opens a panel beneath the
    // scrollbar listing EVERY open tab vertically, in the same order as the
    // horizontal strip. Selecting one focuses it (and reveals it in the strip).
    let menuOpen = $state(false)
    // The chevron only exists while overflowing, so fold the menu shut the moment
    // it would be orphaned (a tab closed, the viewport widened).
    $effect(() => {
        if (!tabsOverflow) menuOpen = false
    })

    // When the active tab changes (a new document opened / navigated to), scroll the
    // strip so that tab is visible — newly opened tabs often land off the right edge.
    $effect(() => {
        const id = activeMain?.panelId
        if (!id || !tabsEl) return
        const el = tabsEl.querySelector('.tab.active') as HTMLElement | null
        if (!el) return
        const strip = tabsEl.getBoundingClientRect()
        const tab = el.getBoundingClientRect()
        if (tab.left < strip.left) tabsEl.scrollLeft -= strip.left - tab.left + 8
        else if (tab.right > strip.right) tabsEl.scrollLeft += tab.right - strip.right + 8
    })

    // --- Ride above the soft keyboard --------------------------------------------
    // The soft keyboard overlays the layout viewport (it does not shrink it), so a
    // bottom-pinned Command Bar would sit behind the keyboard. We track the visual
    // viewport and shrink the whole mobile surface to it via `--keyboard-inset`, so
    // the content reflows and the bottom Command Bar lands just above the keyboard.
    let keyboardInset = $state(0)
    $effect(() => {
        const vv = window.visualViewport
        if (!vv) return
        const update = () => {
            keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        }
        update()
        vv.addEventListener('resize', update)
        vv.addEventListener('scroll', update)
        return () => {
            vv.removeEventListener('resize', update)
            vv.removeEventListener('scroll', update)
        }
    })
</script>

<!-- The pin on a pinned tab, leading the label as pinned tabs lead the strip. Read straight off
     the model: the flag lives on the View instance, so unlike the padlock it needs no callback. -->
{#snippet pin(v: ViewInstance)}
    {#if v.pinned}
        <span class="tab-pin" title="Pinned" aria-hidden="true">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg('pin', { size: 12 })}
        </span>
    {/if}
{/snippet}

{#snippet viewIcon(v: ViewInstance)}
    {@const icon = renderer.registry.icon(v.view)}
    {#if icon}
        <!-- The View kind's icon (the graph glyph on the Graph Sidebar's tab), as the desktop
             tab renderer draws it. Decorative: the label says what the tab is. -->
        <span class="tab-icon" aria-hidden="true">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg(icon, { size: 13 })}
        </span>
    {/if}
{/snippet}

{#snippet tabMark(panelId: string)}
    {@const mark = markFor(panelId)}
    {#if mark}
        <span class="tab-mark" data-state={mark.state} title={mark.title} aria-hidden="true">
            <!-- In-repo constant markup from the icon table, never user or document content —
                 the same justification the Command Bar's icons carry. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg(markIcon(mark.state), { size: 13 })}
        </span>
    {/if}
{/snippet}

<!-- One drawer: its tab strip, then its active View. The strip shows even for a single View
     so the drawer reads as the desktop Sidebar does — a Pane with its tab — rather than the
     left drawer looking like a different kind of surface from the right. Switch only — a
     Sidebar View is furniture you collapse (the region toggle already hides the whole
     drawer), not something to close, and an × per tab in a strip this narrow is mostly a way
     to lose a panel by accident. -->
{#snippet drawer(region: Region)}
    {@const views = viewsIn(region)}
    {@const inst = activeOf(region)}
    {#if views.length > 0}
        <div class="drawer-tabs" data-testid="mobile-drawer-tabs">
            {#each views as v (v.panelId)}
                <!-- The same .tab / .tab-label structure as the main strip, so one style rules
                     every mobile tab; `tab--plain` only balances the padding a close button
                     would otherwise occupy. -->
                <div
                    class="tab tab--plain"
                    class:active={v.panelId === inst?.panelId}
                    data-testid="mobile-drawer-tab"
                    data-view-key="{v.view.kind}:{v.view.target}"
                    aria-current={v.panelId === inst?.panelId}
                >
                    {@render viewIcon(v)}
                    <button
                        class="tab-label"
                        style:--gk-tab-title-width={tabTitleWidth(renderer.registry.tabTitleChars(v.view))}
                        onclick={() => controller.focusView(v.view)}
                    >
                        {renderer.registry.title(v.view)}
                    </button>
                </div>
            {/each}
        </div>
    {/if}
    <div class="drawer-body">
        {#if inst}{@const C = component(inst.view.kind)}{#if C}<C view={inst.view} />
        {:else}<p class="empty" data-testid="view-unavailable">{unavailableViewMessage(inst.view.kind)}</p>{/if}{/if}
    </div>
{/snippet}

<div class="mobile" data-testid="mobile-presenter" style="--keyboard-inset: {keyboardInset}px">
    <!-- Sidebar toggles + open-panes tab strip -->
    <div class="topbar" data-testid="mobile-topbar">
        <button
            class="toggle"
            data-testid="mobile-toggle-left"
            title="Toggle document tree"
            aria-label="Toggle document tree"
            onclick={() => toggleSidebarExclusive('left')}
        >
            <SidebarToggleIcon side="left" />
        </button>
        <div class="tabs" class:overflowing={tabsOverflow} data-testid="mobile-tabs" bind:this={tabsEl}>
            {#each mainViews as v (v.panelId)}
                <div
                    class="tab"
                    class:active={v.panelId === activeMain?.panelId}
                    data-testid="mobile-tab"
                    data-view-key="{v.view.kind}:{v.view.target}"
                    data-pinned={v.pinned ? 'true' : 'false'}
                    {@attach tabMenu(v)}
                >
                    {@render pin(v)}
                    {@render viewIcon(v)}
                    <button
                        class="tab-label"
                        style:--gk-tab-title-width={tabTitleWidth(renderer.registry.tabTitleChars(v.view))}
                        onclick={() => controller.focusView(v.view)}
                    >
                        {renderer.registry.title(v.view)}
                    </button>
                    {@render tabMark(v.panelId)}
                    <button
                        class="tab-close"
                        data-testid="mobile-tab-close"
                        title="Close"
                        aria-label="Close {renderer.registry.title(v.view)}"
                        onclick={() => controller.closeView(v.view)}
                    >
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                            <path d="M5 5l10 10M15 5L5 15" />
                        </svg>
                    </button>
                </div>
            {/each}
        </div>
        {#if tabsOverflow}
            <button
                class="toggle chevron"
                class:open={menuOpen}
                data-testid="mobile-tab-overflow"
                title="All open panes"
                aria-label="All open panes"
                aria-expanded={menuOpen}
                onclick={() => (menuOpen = !menuOpen)}
            >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 8l5 5 5-5" />
                </svg>
            </button>
        {/if}
        {#if status}
            <div class="status" data-testid="mobile-status">{@render status()}</div>
        {/if}
        {#if hasTasksCommand}
            <!-- Sits just before the right toggle, as on desktop: it opens a View INTO that
                 drawer. Goes through the Command registry rather than a prop so this generic
                 presenter learns nothing about tasks — it appears only when the workspace has
                 registered the command (the dev harness has not). -->
            <button
                class="toggle"
                data-testid="mobile-tasks"
                title="Tasks"
                aria-label="Tasks"
                onclick={openTasks}
            >
                <!-- Sized to match SidebarToggleIcon (1.1rem); unsized it filled the button. -->
                <svg class="tasks-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75" />
                </svg>
            </button>
        {/if}
        <button
            class="toggle"
            data-testid="mobile-toggle-right"
            title="Toggle backlinks"
            aria-label="Toggle backlinks"
            onclick={() => toggleSidebarExclusive('right')}
        >
            <SidebarToggleIcon side="right" />
        </button>
    </div>

    <!-- Dedicated tab scrollbar (its own grid row, below the nav controls). The shared
         HScrollbar renders nothing unless the strip overflows. -->
    <div class="tabscroll-slot">
        <HScrollbar target={tabsEl} bind:overflowing={tabsOverflow} testid="mobile-tabscroll" />
    </div>

    <!-- Content area: the active View plus the Sidebar drawers. Drawers are absolute
         within THIS region (not the whole presenter), so they sit below the nav
         controls and the tab scrollbar rather than being clipped under them. -->
    <div class="content">
        <!-- Overflow tab menu: a vertical list of every open pane, in strip order,
             dropping down from the top of the content region (i.e. directly beneath
             the tab scrollbar). Dismissed by selecting a tab or tapping the backdrop. -->
        {#if menuOpen}
            <button class="backdrop menu-backdrop" aria-label="Close pane list" onclick={() => (menuOpen = false)}></button>
            <div class="tabmenu" data-testid="mobile-tab-menu">
                {#each mainViews as v (v.panelId)}
                    <div
                        class="tabmenu-item"
                        class:active={v.panelId === activeMain?.panelId}
                        data-testid="mobile-tab-menu-item"
                        data-view-key="{v.view.kind}:{v.view.target}"
                        data-pinned={v.pinned ? 'true' : 'false'}
                    >
                        {@render pin(v)}
                        {@render viewIcon(v)}
                        <button
                            class="tabmenu-label"
                            onclick={() => {
                                controller.focusView(v.view)
                                menuOpen = false
                            }}
                        >
                            {renderer.registry.title(v.view)}
                        </button>
                        {@render tabMark(v.panelId)}
                        <button
                            class="tabmenu-close"
                            title="Close"
                            aria-label="Close {renderer.registry.title(v.view)}"
                            onclick={() => controller.closeView(v.view)}
                        >
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                <path d="M5 5l10 10M15 5L5 15" />
                            </svg>
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        <!-- The single active View. Keyed by panelId so the View remounts when the
             active tab changes — Views (e.g. the editor) read their target on mount
             and do not react to a changed `view` prop, so a swap alone would not
             switch it. -->
        <div class="active-view" data-testid="mobile-active">
            {#if activeMain}
                {@const Active = component(activeMain.view.kind)}
                {#if Active}
                    {#key activeMain.panelId}<Active view={activeMain.view} />{/key}
                {:else}<p class="empty" data-testid="view-unavailable">{unavailableViewMessage(activeMain.view.kind)}</p>{/if}
            {:else}
                <p class="empty">No View open.</p>
            {/if}
        </div>

        {#if leftOpen}
            <button class="backdrop" aria-label="Close left sidebar" onclick={() => controller.toggleSidebar('left', false)}></button>
            <aside class="drawer left" data-testid="mobile-drawer-left">
                {@render drawer('left-sidebar')}
            </aside>
        {/if}
        {#if rightOpen}
            <button class="backdrop" aria-label="Close right sidebar" onclick={() => controller.toggleSidebar('right', false)}></button>
            <aside class="drawer right" data-testid="mobile-drawer-right">
                {@render drawer('right-sidebar')}
            </aside>
        {/if}
    </div>

    <!-- The Command Bar: always shown on mobile, fixed at the bottom. Its buttons act on
         the active editor (no-op when none is focused). -->
    <div class="command-bar-slot">
        <CommandBar />
    </div>
</div>

<style>
    /* The mark on a tab - a [[Protected Document]]'s padlock, a published include's globe - on
       both the strip and the overflow list. Muted: an indicator, not a warning. */
    .tab-mark {
        display: inline-flex;
        align-items: center;
        margin-inline: 0.15rem;
        color: var(--gk-text-muted);
        line-height: 0;
    }

    /* Unlocked is the state worth noticing — readable content you might leave open. */
    .tab-mark[data-state='unlocked'] {
        color: var(--gk-accent);
    }

    /* The pin on a pinned tab, on both the strip and the overflow list. Muted like the padlock. */
    .tab-pin {
        display: inline-flex;
        align-items: center;
        margin-inline-start: 0.5rem;
        color: var(--gk-text-muted);
        line-height: 0;
    }
    /* The label's own leading padding is the tab's edge gap; after a pin it is just a gap. */
    .tab-pin + .tab-label,
    .tab-pin + .tabmenu-label {
        padding-inline-start: 0.3rem;
    }

    /* The View kind's icon, ahead of the label: the tab's edge gap, then the glyph, then the
       label a small gap on. After a pin the pin already paid the edge gap. */
    .tab-icon {
        display: inline-flex;
        align-items: center;
        margin-inline-start: 0.6rem;
        color: var(--gk-text-muted);
        line-height: 0;
    }
    .tab-pin + .tab-icon {
        margin-inline-start: 0.3rem;
    }
    .tab-icon + .tab-label,
    .tab-icon + .tabmenu-label {
        padding-inline-start: 0.3rem;
    }

    .mobile {
        position: absolute;
        /* Shrink the surface to the visual viewport when the soft keyboard is open
           (--keyboard-inset > 0), so the content reflows and the bottom Command Bar
           lands just above the keyboard rather than behind it. */
        inset: 0 0 var(--keyboard-inset, 0px) 0;
        display: grid;
        /* Rows: nav controls, the dedicated tab scrollbar (0 when not overflowing),
           the content area, then the Command Bar. Explicit grid-row on each child keeps
           content in the 1fr track even when the scrollbar row is absent. */
        grid-template-rows: auto auto 1fr auto;
        /* minmax(0, 1fr): the single column fills the width and may shrink BELOW
           its content's size. Without it the implicit `auto` column grows to the
           topbar's max-content (the full un-scrolled tab strip), so the row
           overflows and the right toggle is pushed off-screen. */
        grid-template-columns: minmax(0, 1fr);
        /* Clamp every child to the viewport so nothing (a wide editor line, a long
           tab strip) can push the page wider than the screen. */
        overflow: hidden;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
    }
    .topbar {
        grid-row: 1;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.5rem;
        /* The strip's rule is an INSET shadow rather than a border so that a tab reaching the
           bottom edge can paint over it and read as joined to what is below — the same
           connected tab the desktop strip and the drawers draw. A border sits outside anything
           a child can cover. */
        box-shadow: inset 0 -1px 0 var(--gk-border-soft);
        /* The graph's own colour when one is set (Graph Settings → Toolbar colour, ADR 0071),
           set as a custom property on the workspace root; the theme surface otherwise. This
           strip is the phone's counterpart of the desktop toolbar - the drawer toggles live
           here - so it is the surface that colour paints. The toggles and the tabs each paint
           their own surface over it. */
        background: var(--gk-toolbar-accent, var(--gk-surface-1));
    }
    .tabs {
        display: flex;
        gap: 0.375rem; /* desktop .dv-tab: margin 0 3px */
        overflow-x: auto;
        overflow-y: hidden;
        flex: 1;
        /* Reach the topbar's bottom edge (through its padding) and sit the tabs on it, so the
           active tab's bottom edge covers the rule. The toggles beside stay centred in the row.
           A negative margin on the SCROLLER is safe — its children stay inside it, so nothing
           is clipped and nothing overflows vertically. */
        align-self: stretch;
        align-items: flex-end;
        margin-bottom: -0.4rem;
        /* Let the strip shrink below its content width so it scrolls internally;
           without this the tabs push the right toggle off-screen. */
        min-width: 0;
        /* Hide the native scrollbar — the dedicated .tabscroll replaces it. */
        scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar {
        display: none;
    }
    /* When the strip overflows (scrollbar needed), bound it with separators in the
       button-outline colour so it reads as a distinct, scrollable region between
       the two column toggles. */
    .tabs.overflowing {
        border-inline: 1px solid var(--gk-border-soft);
        /* Match the topbar gap (0.5rem) so the first/last tab is spaced from the
           divider by the same amount as the toggle buttons on the other side. */
        padding-inline: 0.5rem;
    }
    /* The tab scrollbar's grid row; the HScrollbar inside renders nothing (0 height)
       unless the strip overflows. */
    .tabscroll-slot {
        grid-row: 2;
    }
    /* The Command Bar's grid row, pinned to the bottom of the surface. */
    .command-bar-slot {
        grid-row: 4;
    }
    /* Overflow chevron: sized as a toggle (via `.toggle`), with a rotating glyph. */
    .chevron svg {
        width: 1rem;
        height: 1rem;
        display: block;
        transition: transform 0.15s ease;
    }
    .chevron.open svg {
        transform: rotate(180deg);
    }
    /* The pane list drops from the top of the content region (beneath the tab
       scrollbar). Scrolls vertically; never taller than the content area. */
    /* Above the sidebar drawers (z 11) and their backdrop (z 10) so the pane list
       overlays everything when a drawer happens to be open. (Two classes to win the
       cascade against the later `.backdrop` rule.) */
    .backdrop.menu-backdrop {
        z-index: 20;
    }
    .tabmenu {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 21;
        max-height: 100%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        padding: 0.4rem;
        gap: 0.25rem;
        background: var(--gk-surface-1);
        border-bottom: 1px solid var(--gk-border-soft);
        box-shadow: var(--gk-shadow, 0 10px 30px rgba(0, 0, 0, 0.3));
    }
    .tabmenu-item {
        display: flex;
        align-items: center;
        box-sizing: border-box;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        background: transparent;
    }
    .tabmenu-item.active {
        background: var(--gk-surface-2);
    }
    :global(html.dark) .tabmenu-item.active {
        background: #313139;
    }
    .tabmenu-label {
        flex: 1;
        min-width: 0;
        text-align: left;
        padding: 0.5rem 0.6rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
    }
    .tabmenu-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        padding: 0 0.5rem;
        align-self: stretch;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.55;
    }
    .tabmenu-close:hover {
        opacity: 1;
    }
    .tabmenu-close svg {
        width: 0.8rem;
        height: 0.8rem;
        display: block;
    }
    .content {
        grid-row: 3;
        position: relative;
        /* `clip` rather than `hidden` for the same reason as the desktop shell (GraphWorkspace
           → `.layout`): a hidden box is still scrollable programmatically, so a caret revealed
           inside a panel could scroll the whole presenter and leave a gap under it. */
        overflow: clip;
        /* Grid items default to min-width:auto; 0 lets wide content scroll inside
           rather than stretch the grid past the viewport. */
        min-width: 0;
    }
    /* Column toggles (icon-only) and document tabs share one box so they are the
       same height. Height is fixed (not derived from line-height) because `font:
       inherit` resets line-height — the two would otherwise diverge. */
    .topbar .toggle {
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        height: 1.9rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        /* The toggles paint their own theme surface and ink, as the desktop toolbar's buttons
           do, rather than sitting transparent on the strip. On the theme's own strip the surface
           is the strip's, so nothing changes; over a graph's toolbar colour (ADR 0071) it is what
           keeps the icons readable, whatever colour was picked. */
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        font: inherit;
    }
    /* ONE tab style for every mobile tab — the main strip and both drawers — and it is the
       desktop `.dv-tab` (compass-theme.css): 13px / 500, squared top corners, sitting on the
       strip's rule; the active tab filled with the panel background and text-strong, the
       inactive ones surface-2 and text-subtle. Before this the main strip's pills had the
       states INVERTED (active filled, inactive transparent) at 16px / 400, so the same state
       looked different in every region. Every tab has a 1px bottom border of the same width,
       so both states are the same height: inactive shows the rule, active is painted panel-
       colour over it. */
    .tab {
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        height: 1.9rem;
        border: 1px solid var(--gk-border-soft);
        border-bottom: 1px solid var(--gk-border-soft);
        border-radius: 3px 3px 0 0;
        background: var(--gk-surface-2);
        color: var(--gk-text-subtle);
        font: inherit;
        font-size: 0.8125rem;
        font-weight: 500; /* same weight in both states, so selecting never changes a width */
        /* Full natural width (label + close), never shrunk — so the close button is always
           visible; the strip scrolls instead of clipping tabs. */
        flex: none;
        overflow: hidden;
        /* A long press raises the Context Menu (attachContextMenu): without these iOS Safari's
           text-selection callout takes the gesture first, and the label gets selected. */
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
    }
    .tab:hover:not(.active) {
        background: var(--gk-surface-3, var(--gk-surface-2));
    }
    .tab.active {
        background: var(--gk-surface-0);
        border-bottom-color: var(--gk-surface-0);
        color: var(--gk-text-strong);
    }
    /* A drawer tab has no close button; balance the label's padding. */
    .tab--plain .tab-label {
        padding: 0 0.6rem;
    }
    /* Toggles never shrink, so they stay visible and clickable as tabs accumulate. */
    /* The status control never shrinks: it keeps its place however the tab strip grows. */
    .status {
        display: flex;
        flex: none;
    }
    .topbar .toggle {
        flex: none;
        justify-content: center;
        width: 1.9rem;
        cursor: pointer;
    }
    .tab-label {
        /* Block (not flex) so text-box trimming applies to its line box. The parent
           .tab (flex, align-items:center) then vertically centres the trimmed box. */
        display: block;
        padding: 0 0.15rem 0 0.6rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        /* MUST come after `font` — the `font` shorthand resets line-height. */
        line-height: 1;
        /* Trim the box to the cap-height→baseline ink so centring centres the visible
           glyphs, not the em box (whose empty descender space leaves text sitting
           high). Chromium-supported (text-box). */
        text-box: trim-both cap alphabetic;
        white-space: nowrap;
        cursor: pointer;
        /* The desktop tab's cap (compass-theme.css → .dv-default-tab-content): about 30
           characters, set per View kind through the same `tabTitleWidth`, then an ellipsis.
           The button keeps the whole title as its accessible name. Clipped on the inline axis
           only: the box is trimmed to the cap height above, so `overflow: hidden` would cut
           off every descender and the tops of the tallest letters. `clip` (unlike `hidden`)
           leaves the other axis visible. */
        max-width: var(--gk-tab-title-width);
        overflow-x: clip;
        text-overflow: ellipsis;
    }
    .tab-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 0 0.4rem;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.55;
    }
    .tab-close:hover {
        opacity: 1;
    }
    .tab-close svg {
        width: 0.8rem;
        height: 0.8rem;
        display: block;
    }
    .active-view {
        position: absolute;
        inset: 0;
        overflow: auto;
    }
    .empty {
        padding: 1rem;
        opacity: 0.6;
    }
    .backdrop {
        position: absolute;
        inset: 0;
        z-index: 10;
        border: 0;
        background: rgba(3, 7, 18, 0.35);
        cursor: pointer;
    }
    .drawer {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 11;
        width: 78%;
        max-width: 20rem;
        background: var(--gk-surface-0);
        box-shadow: var(--gk-shadow, 0 10px 30px rgba(0, 0, 0, 0.3));
        /* The strip stays put while the View scrolls, so the way back to the other
           View is never scrolled off. */
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }
    .drawer-body {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
    /* The same connected-tab look as the desktop strip (compass-theme.css → .dv-tab): squared
       tabs sitting on the strip's bottom rule, the active one filled with the panel background
       so it merges into the content below with no divider. Not pills — the drawer is the same
       Pane the desktop shows, and its tabs should read as the same tabs. */
    .drawer-tabs {
        display: flex;
        flex-shrink: 0;
        align-items: flex-end;
        padding: 0.35rem 0.4rem 0;
        background: var(--gk-surface-1);
        /* The strip's rule is an INSET shadow, not a border: children paint over it, so the
           active tab's own bottom edge can cover it and read as joined to the panel. A border
           would sit outside anything a child can reach without overflowing — and overflowing
           into a scroller gets clipped (the rule showed through) AND, because a non-visible
           overflow on one axis makes the other `auto`, that 1px of overflow was exactly what
           produced a vertical scrollbar. */
        box-shadow: inset 0 -1px 0 var(--gk-border-soft);
        overflow-x: auto;
        overflow-y: hidden;
        /* Our own scrollbar is hidden, as the desktop strip hides dockview's; the strip stays
           swipe-scrollable on touch should it ever overflow. */
        scrollbar-width: none;
    }
    .drawer-tabs::-webkit-scrollbar {
        display: none;
    }
    .drawer-tabs {
        gap: 0.375rem; /* the tabs themselves are the shared .tab rule above */
    }
    .tasks-icon {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
    }
    .drawer.left {
        left: 0;
        border-right: 1px solid var(--gk-border-soft);
    }
    .drawer.right {
        right: 0;
        border-left: 1px solid var(--gk-border-soft);
    }
</style>
