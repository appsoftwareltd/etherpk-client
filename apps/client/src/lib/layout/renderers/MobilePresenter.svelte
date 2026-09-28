<script lang="ts">
    /**
     * The mobile presenter: one active View at a time, a control naming it whose list
     * reaches the rest of `main`, and the Sidebars as overlay drawers. It reads the
     * same shared model off the {@link LayoutController} (re-read whenever the
     * mobile renderer's revision bumps) and drives the controller back through the
     * identical API — `focusView` to switch tabs, `toggleSidebar` to close a drawer.
     */
    import { untrack } from 'svelte'

    import type { LayoutController, LayoutModel, Region, ViewInstance } from '$lib/layout'
    import { attachContextMenu, type ContextMenuTarget, tryGetActiveCommandRegistry } from '$lib/surface'

    import CommandBar from './CommandBar.svelte'
    import type { MobileRenderer } from './mobile-renderer.svelte'
    import SidebarToggleIcon from './SidebarToggleIcon.svelte'
    import { NO_PAGE_OPEN } from './no-page-open'
    import { markIcon, tabTitleWidth, type TabMark } from './tab-renderer'
    import { iconSvg } from '$lib/surface/icons'
    import { unavailableViewMessage } from './unavailable-view'

    let {
        controller,
        renderer,
        markFor = () => null,
    }: {
        controller: LayoutController
        renderer: MobileRenderer
        /**
         * The padlock state for a panel's tab, or null for anything unprotected. Same indicator as
         * the desktop tab strip: a tab is the one place you scan to see what you have left open,
         * and whether a [[Protected Document]] is readable right now is invisible from its title.
         */
        markFor?: (panelId: string) => TabMark | null
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
     * The [[Context Menu]] target an open main-region View stands for, from the document control
     * or its row in the list - the same mapping the dockview adapter makes for a desktop tab: a
     * document's rows for a document, and for anything else (an Asset, All Documents) only the
     * tab-management rows, which are the reason such a tab has a menu at all. The presenter has
     * the View and the panel id to hand, so unlike the adapter it needs no label lookup.
     * `vertical`, because the phone lists its open Views down the screen: the rows that close
     * tabs by position say below and above.
     */
    function tabTarget(v: ViewInstance): ContextMenuTarget {
        return v.view.kind === 'document'
            ? { kind: 'document-tab', concept: v.view.target, panelId: v.panelId, vertical: true }
            : { kind: 'tab', panelId: v.panelId, vertical: true }
    }

    /**
     * Right-click and long-press on the document control or a row of the list, both raising the
     * menu. The attachment returns its cleanup directly; the movement guard, the swallowed click
     * that would otherwise open the list or switch documents under the open menu, and the
     * `touch-action` / `user-select` the element must carry are all `attachContextMenu`'s (see
     * the `.current` and `.tabmenu-item` rules below for the last).
     */
    function tabMenu(v: ViewInstance) {
        return (node: HTMLElement) => attachContextMenu(node, () => tabTarget(v))
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

    // --- The list of open documents -----------------------------------------------
    // A phone has no room for a strip of tabs, so the top bar names the View in front with one
    // control, and the control opens a list of every open main-region View in tab order,
    // pinned first. Choosing a row brings its View to the front, each row closes its own View,
    // and a long press on the control or a row raises that tab's Context Menu.
    let menuOpen = $state(false)
    let currentEl = $state<HTMLButtonElement>()

    /** Put the list away, handing focus back to the control that opened it. */
    function closeList() {
        menuOpen = false
        currentEl?.focus()
    }

    function choose(v: ViewInstance) {
        controller.focusView(v.view)
        closeList()
    }

    // With nothing left open the list has nothing to show, however the last View went: its
    // row's close, Lock now closing protected documents, a close from another surface.
    $effect(() => {
        if (!activeMain) menuOpen = false
    })

    // A drawer opening while the list is up would open beneath it - Show backlinks from a row's
    // menu does exactly that - so the list gets out of the way of the drawer asked for.
    $effect(() => {
        if (leftOpen || rightOpen) menuOpen = false
    })

    /** Escape puts the list away from the control, as it does from inside the list. */
    function onCurrentKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !menuOpen) return
        event.preventDefault()
        closeList()
    }

    /**
     * Keys inside the list, on either button of a row: the arrows, Home and End move between the
     * rows' titles, and Escape puts the list away.
     */
    function onListKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault()
            closeList()
            return
        }
        const row = (event.currentTarget as HTMLElement).closest<HTMLElement>('.tabmenu-item')
        const rows = [...(row?.parentElement?.querySelectorAll<HTMLElement>('.tabmenu-item') ?? [])]
        const at = row ? rows.indexOf(row) : -1
        const last = rows.length - 1
        const next = { ArrowDown: Math.min(at + 1, last), ArrowUp: Math.max(at - 1, 0), Home: 0, End: last }[
            event.key
        ]
        if (next === undefined || at < 0) return
        event.preventDefault()
        rows[next]?.querySelector<HTMLElement>('.tabmenu-label')?.focus()
    }

    /** Focus starts on the row in front, so the keyboard begins where the eye does. */
    function focusActiveRow(list: HTMLElement) {
        const row = list.querySelector<HTMLElement>('.tabmenu-item.active')
        row?.scrollIntoView({ block: 'nearest' })
        row?.querySelector<HTMLElement>('.tabmenu-label')?.focus({ preventScroll: true })
    }

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

<!-- The pin on a pinned View, leading its title as pinned Views lead the list. Read straight off
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
                <div
                    class="tab"
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
                        <span class="tab-title">{renderer.registry.title(v.view)}</span>
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
    <!-- The drawer toggles, and between them the control naming the document in front -->
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
        <!-- Where a strip of tabs would be: the View in front, wearing the indicators its tab
             would. One control: a tap opens the list of every open View, a long press raises the
             tab's menu. With nothing open it says so and does nothing. -->
        {#if activeMain}
            {@const v = activeMain}
            {@const title = renderer.registry.title(v.view)}
            <button
                class="current"
                class:open={menuOpen}
                data-testid="mobile-current"
                data-view-key="{v.view.kind}:{v.view.target}"
                data-pinned={v.pinned ? 'true' : 'false'}
                aria-label="{title}, open documents"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? 'mobile-open-documents' : undefined}
                bind:this={currentEl}
                onclick={() => (menuOpen = !menuOpen)}
                onkeydown={onCurrentKeydown}
                {@attach tabMenu(v)}
            >
                {@render pin(v)}
                {@render viewIcon(v)}
                <span class="current-title">{title}</span>
                {@render tabMark(v.panelId)}
                <svg class="current-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 8l5 5 5-5" />
                </svg>
            </button>
        {:else}
            <div class="current current--empty" data-testid="mobile-current">{NO_PAGE_OPEN}</div>
        {/if}
        <!-- No Tasks button here, unlike the desktop toolbar: the top bar is kept to the drawer
             toggles and the document control, and Tasks is a resident tab of the right drawer. -->
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

    <!-- Content area: the active View plus the Sidebar drawers. Drawers are absolute
         within THIS region (not the whole presenter), so they sit below the top bar
         rather than being clipped under it. -->
    <div class="content">
        <!-- The list of open documents: every View open in the editor area, in tab order,
             dropping from the top of the content region directly beneath the top bar. Put away
             by choosing a row, tapping the backdrop, or Escape. -->
        {#if menuOpen}
            <button
                class="backdrop menu-backdrop"
                tabindex="-1"
                aria-label="Close the list of open documents"
                onclick={closeList}
            ></button>
            <div class="tabmenu" id="mobile-open-documents" data-testid="mobile-tab-menu" {@attach focusActiveRow}>
                {#each mainViews as v (v.panelId)}
                    {@const title = renderer.registry.title(v.view)}
                    {@const active = v.panelId === activeMain?.panelId}
                    <div
                        class="tabmenu-item"
                        class:active
                        data-testid="mobile-tab-menu-item"
                        data-view-key="{v.view.kind}:{v.view.target}"
                        data-pinned={v.pinned ? 'true' : 'false'}
                        {@attach tabMenu(v)}
                    >
                        {@render pin(v)}
                        {@render viewIcon(v)}
                        <button
                            class="tabmenu-label"
                            aria-current={active ? 'true' : undefined}
                            onclick={() => choose(v)}
                            onkeydown={onListKeydown}
                        >
                            {title}
                        </button>
                        {@render tabMark(v.panelId)}
                        <button
                            class="tabmenu-close"
                            data-testid="mobile-tab-close"
                            title="Close"
                            aria-label="Close {title}"
                            onclick={() => controller.closeView(v.view)}
                            onkeydown={onListKeydown}
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
                <p class="empty" data-testid="no-page-open">{NO_PAGE_OPEN}</p>
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
    /* The mark a tab would wear - a [[Protected Document]]'s padlock, a published include's
       globe - on the document control and the list's rows. Muted: an indicator, not a warning. */
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

    /* The pin on a pinned View, on the document control and the list's rows. Muted like the
       padlock. */
    .tab-pin {
        display: inline-flex;
        align-items: center;
        margin-inline-start: 0.5rem;
        color: var(--gk-text-muted);
        line-height: 0;
    }
    /* The label's own leading padding is the row's edge gap; after a pin it is just a gap. */
    .tab-pin + .tabmenu-label {
        padding-inline-start: 0.3rem;
    }

    /* The View kind's icon, ahead of the label: the edge gap (a drawer tab's own, see `.tab`),
       then the glyph, then the label a small gap on. After a pin the pin already paid the edge
       gap. */
    .tab-icon {
        display: inline-flex;
        align-items: center;
        margin-inline-start: var(--edge-gap, 0.6rem);
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
        /* Rows: the top bar, the content area, then the Command Bar. */
        grid-template-rows: auto 1fr auto;
        /* minmax(0, 1fr): the single column fills the width and may shrink BELOW
           its content's size. Without it the implicit `auto` column grows to the
           topbar's max-content (the document control's whole title), so the row
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
        /* The bar's bottom rule, drawn inside it as the drawers' strips draw theirs. */
        box-shadow: inset 0 -1px 0 var(--gk-border-soft);
        /* The graph's own colour when one is set (Graph Settings → Toolbar colour, ADR 0071),
           set as a custom property on the workspace root; the theme surface otherwise. This
           strip is the phone's counterpart of the desktop toolbar - the drawer toggles live
           here - so it is the surface that colour paints. The toggles and the document control
           each paint their own surface over it. */
        background: var(--gk-toolbar-accent, var(--gk-surface-1));
    }
    /* The Command Bar's grid row, pinned to the bottom of the surface. */
    .command-bar-slot {
        grid-row: 3;
    }
    /* The list drops from the top of the content region, directly beneath the top bar.
       Scrolls vertically; never taller than the content area. */
    /* Above the sidebar drawers (z 11) and their backdrop (z 10) so the list overlays
       everything when a drawer happens to be open. (Two classes to win the cascade against
       the later `.backdrop` rule.) */
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
        /* Holds the title button's stretched hit area (`.tabmenu-label::after`). */
        position: relative;
        display: flex;
        align-items: center;
        box-sizing: border-box;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        background: transparent;
        /* A long press raises the Context Menu (attachContextMenu): without these iOS Safari's
           text-selection callout takes the gesture first, and the title gets selected. */
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
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
    /* A row answers a tap anywhere on it, its pin, icon and mark included: the title's button
       stretches its hit area over the row, and the close button sits above that. */
    .tabmenu-label::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 5px;
    }
    /* Keyboard focus rings the whole row, the target the title stands for, not the title alone. */
    .tabmenu-label:focus-visible {
        outline: none;
    }
    .tabmenu-label:focus-visible::after {
        outline: auto;
        outline-offset: -2px;
    }
    .tabmenu-close {
        position: relative;
        z-index: 1;
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
        grid-row: 2;
        position: relative;
        /* `clip` rather than `hidden` for the same reason as the desktop shell (GraphWorkspace
           → `.layout`): a hidden box is still scrollable programmatically, so a caret revealed
           inside a panel could scroll the whole presenter and leave a gap under it. */
        overflow: clip;
        /* Grid items default to min-width:auto; 0 lets wide content scroll inside
           rather than stretch the grid past the viewport. */
        min-width: 0;
    }
    /* The drawer toggles (icon-only) and the document control share one box, so they are the
       same height and read as one set. Height is fixed (not derived from line-height) because
       `font: inherit` resets line-height — the two would otherwise diverge. */
    .topbar .toggle,
    .current {
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
    /* The document control: the View in front, its indicators, and the chevron saying the
       control opens a list. It takes the bar's width between the toggles, and a title too long
       for it ends in an ellipsis. */
    .current {
        flex: 1;
        min-width: 0;
        gap: 0.4rem;
        padding: 0 0.5rem 0 0.75rem;
        color: var(--gk-text-strong);
        font-size: 0.875rem;
        font-weight: 500;
        text-align: start;
        cursor: pointer;
        /* A long press raises the Context Menu (attachContextMenu): without these iOS Safari's
           text-selection callout takes the gesture first, and the title gets selected. */
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
    }
    /* The control spaces its glyphs with its gap, not the margins they take in a row. */
    .current .tab-pin,
    .current .tab-icon,
    .current .tab-mark {
        margin: 0;
    }
    .current-title {
        flex: 1;
        min-width: 0;
        /* Block, trimmed to the cap height and centred by the flex row, as a drawer tab's title
           is; clipped on the inline axis only, so the descenders still show. */
        display: block;
        line-height: 1;
        text-box: trim-both cap alphabetic;
        white-space: nowrap;
        overflow-x: clip;
        text-overflow: ellipsis;
    }
    .current-chevron {
        flex: none;
        width: 1rem;
        height: 1rem;
        color: var(--gk-text-muted);
        transition: transform 150ms ease-out;
    }
    .current.open .current-chevron {
        transform: rotate(180deg);
    }
    /* Nothing open: the control keeps its place and says so, and is not a button. */
    .current--empty {
        color: var(--gk-text-muted);
        cursor: default;
    }
    @media (prefers-reduced-motion: reduce) {
        .current-chevron {
            transition: none;
        }
    }
    /* The drawers' tabs, in the desktop `.dv-tab` style (compass-theme.css): 14px / 500, squared
       top corners sitting on the strip's rule; the active tab filled with the panel background
       and text-strong, the inactive ones surface-2 and text-subtle. Every tab has a 1px bottom
       border of the same width, so both states are the same height: inactive shows the rule,
       active is painted panel-colour over it.
       A tab has no close button, so its content has the tab's edge gap at both ends: before the
       View's icon or the label, whichever leads, and after the title. The gap is what the tab's
       height leaves above and below the title's cap height, so the room around the title is the
       same on all four sides at either height (the touch height is below).
       The tabs share the drawer's width: the strip has no list to reach a tab it hides, and a
       graph's name can be long enough to push Quick notes past the edge. Each tab grows from
       nothing towards its own width, so a tab that fits in an equal share keeps its width and
       the rest split what is left, their titles ending in an ellipsis. A title with room is
       never cut. */
    .tab {
        --edge-gap: calc((1.9rem - 2px - 1cap) / 2);
        position: relative; /* holds the label's stretched hit area, below */
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        flex: 1 1 0;
        min-width: 0;
        max-width: max-content;
        height: 1.9rem;
        border: 1px solid var(--gk-border-soft);
        border-bottom: 1px solid var(--gk-border-soft);
        border-radius: 3px 3px 0 0;
        background: var(--gk-surface-2);
        color: var(--gk-text-subtle);
        font: inherit;
        font-size: 0.875rem;
        font-weight: 500; /* same weight in both states, so selecting never changes a width */
        overflow: hidden;
        /* Pressed, never read: no text selection, callout or double-tap zoom. */
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
    /* The label is a tab's only control, so its hit area covers the whole tab: a tap on the icon
       ahead of it, or in the edge gap, reaches the button. */
    .tab-label::after {
        content: '';
        position: absolute;
        inset: 0;
    }
    /* Toggles never shrink, so they stay visible and clickable however long the title between
       them. */
    .topbar .toggle {
        flex: none;
        justify-content: center;
        width: 1.9rem;
        cursor: pointer;
    }
    /* The button fills the tab's height, so a tap anywhere above or below the title lands on
       it; the title inside it is what gets trimmed and centred. */
    .tab-label {
        display: flex;
        align-items: center;
        align-self: stretch;
        min-width: 0;
        padding: 0 var(--edge-gap);
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    .tab-title {
        /* Block (not flex) so text-box trimming applies to its line box. The label (flex,
           align-items:center) then vertically centres the trimmed box. */
        display: block;
        line-height: 1;
        /* Trim the box to the cap-height→baseline ink so centring centres the visible
           glyphs, not the em box (whose empty descender space leaves text sitting
           high). Chromium-supported (text-box). */
        text-box: trim-both cap alphabetic;
        white-space: nowrap;
        /* The desktop tab's cap (compass-theme.css → .dv-default-tab-content): about 30
           characters, set per View kind through the same `tabTitleWidth`, then an ellipsis.
           The button keeps the whole title as its accessible name. Clipped on the inline axis
           only: the box is trimmed to the cap height above, so `overflow: hidden` would cut
           off every descender and the tops of the tallest letters. `clip` (unlike `hidden`)
           leaves the other axis visible. */
        max-width: var(--gk-tab-title-width);
        min-width: 0;
        overflow-x: clip;
        text-overflow: ellipsis;
    }
    /* A finger needs a 44 CSS px target: on a touch screen the top bar's toggles, its document
       control and the drawers' tabs grow to that inside their 1px borders, each row of the list
       is at least that tall, and a row's close button at least that wide. */
    @media (pointer: coarse) {
        .topbar .toggle {
            width: calc(2.75rem + 2px);
            height: calc(2.75rem + 2px);
        }
        .current {
            height: calc(2.75rem + 2px);
        }
        /* A drawer tab has no close button to widen it, so its edge gap grows with its height,
           to what the 44px leaves above and below the title's cap height (about 17px): the tab
           keeps the desktop tab's proportions instead of standing tall and narrow. */
        .tab {
            --edge-gap: calc((2.75rem - 1cap) / 2);
            height: calc(2.75rem + 2px);
        }
        .tabmenu-close {
            min-width: 2.75rem;
        }
        .tabmenu-item {
            min-height: calc(2.75rem + 2px);
        }
    }
    .active-view {
        position: absolute;
        inset: 0;
        overflow: auto;
    }
    .empty {
        padding: 1rem;
        color: var(--gk-text-muted);
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
    .drawer.left {
        left: 0;
        border-right: 1px solid var(--gk-border-soft);
    }
    .drawer.right {
        right: 0;
        border-left: 1px solid var(--gk-border-soft);
    }
</style>
