<script lang="ts" module>
    /** One icon of the [[Activity Bar]]: a View of the Primary Sidebar. */
    export interface ActivityItem {
        panelId: string
        kind: string
        title: string
        /** The shortcut that shows it, as the tooltip names it, or null where there is none to name. */
        chord: string | null
        /** An icon name from `surface/icons`. Without one the title's first letter is drawn. */
        icon?: string
        /**
         * The View is one the person arranges (ADR 0199): it can be reordered, hidden and moved to
         * the other Sidebar. False for anything else that is in the Sidebar, such as a page dragged
         * into it, which sits after the arranged Views and has a tab's menu.
         */
        arranged: boolean
    }

    /** A shortcut under the Views' icons: it opens something in the editor area, or a dialog, and shows no View. */
    export interface ActivityShortcut {
        id: string
        title: string
        icon: string
        /** The shortcut that runs it, as the tooltip names it, or null where there is none to name. */
        chord: string | null
        /** The Command it runs, and what the Command is given. */
        command: string
        args?: unknown
    }
</script>

<script lang="ts">
    /**
     * The [[Activity Bar]] (ADR 0198): a column of icons, one for each View of the Primary
     * Sidebar. Choosing an icon shows its View, and choosing the icon of the View already showing
     * collapses the Sidebar. On a desktop the workspace draws it beside the Layout, where it stays
     * while the Sidebar is collapsed. In the Phone Layout the presenter draws it inside the
     * Primary Sidebar's drawer.
     *
     * It is a vertical tab list: one View shows at a time, and the arrows move between the icons.
     * An icon is reordered by dragging it with a mouse or pen, by Alt+Up and Alt+Down, or from its
     * menu, which every device has. The button at the foot opens the bar's own menu: the hidden
     * Views, the workspace's settings, Keyboard shortcuts, the side the bar is on, and Reset
     * workspace.
     *
     * Under a rule below the Views are the Explorer's own buttons again (Search, Today and those
     * extensions add), as icons: shortcuts to what opens in a pane or a dialog, in reach whichever
     * View shows. They are buttons and not tabs, so they are outside the tab list.
     *
     * It draws what it is given and reports what was done. Which Views there are, and what a
     * choice does, are the workspace's (`sidebar-arrangement-binding.ts`).
     */
    import { tick } from 'svelte'

    import { attachContextMenu, type ContextMenuTarget, openContextMenu } from '#lib/surface/index.js'
    import { withChord } from '#lib/surface/control-help.js'
    import { iconSvg } from '#lib/surface/icons.js'

    let {
        items,
        shortcuts = [],
        showingPanelId,
        side,
        onselect,
        onshortcut,
        onreorder,
        onstep,
        menuTarget,
    }: {
        items: readonly ActivityItem[]
        /** The shortcuts under the Views, in order. With none there is no rule. */
        shortcuts?: readonly ActivityShortcut[]
        /** The View the Sidebar is showing, or null while it is collapsed or empty. */
        showingPanelId: string | null
        /** The side of the Layout the bar is on, which is the side its rule and its marker face away from. */
        side: 'left' | 'right'
        onselect: (item: ActivityItem) => void
        onshortcut?: (shortcut: ActivityShortcut) => void
        /** An arranged icon was dropped at `index` among the arranged icons. */
        onreorder: (item: ActivityItem, index: number) => void
        /** An arranged icon was moved one place with the keyboard. */
        onstep: (item: ActivityItem, delta: -1 | 1) => void
        /** What an icon's menu is raised on. */
        menuTarget: (item: ActivityItem) => ContextMenuTarget
    } = $props()

    let list = $state<HTMLElement>()
    /** The icon the keyboard is on: the one Tab reaches, as in any tab list. */
    let focusKey = $state<string | null>(null)
    const tabStop = $derived(items.find((item) => item.panelId === focusKey)?.panelId ?? showingPanelId ?? items[0]?.panelId ?? null)

    const arranged = $derived(items.filter((item) => item.arranged))

    /** The first letter of a title, for a View whose extension gave it no icon. */
    const letter = (title: string) => [...title.trim()][0]?.toUpperCase() ?? '?'

    function tabs(): HTMLElement[] {
        return [...(list?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    }

    function onkeydown(event: KeyboardEvent, item: ActivityItem) {
        const at = items.indexOf(item)
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            if (!item.arranged) return
            event.preventDefault()
            onstep(item, event.key === 'ArrowUp' ? -1 : 1)
            // The icon's element moves with it, and an element that moves loses the keyboard.
            focusKey = item.panelId
            void tick().then(() => tabs()[items.findIndex((other) => other.panelId === item.panelId)]?.focus())
            return
        }
        const last = items.length - 1
        const next = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at === 0 ? last : at - 1, Home: 0, End: last }[event.key]
        if (next === undefined) return
        event.preventDefault()
        focusKey = items[next].panelId
        tabs()[next]?.focus()
    }

    // --- Dragging an icon to a new place ---------------------------------------------
    // Pointer events, not the browser's drag and drop: the icons are buttons, the drop target is
    // a gap between two of them, and a touch drag would fight the long press that raises the menu.
    /** Movement before a press becomes a drag, so a click with an unsteady hand is still a click. */
    const DRAG_SLOP_PX = 5
    let drag = $state<{ item: ActivityItem; index: number; lineTop: number } | null>(null)
    let press: { item: ActivityItem; y: number; pointerId: number } | null = null
    /** A drag ended on this press: the click the browser sends after it chooses nothing. */
    let dragged = false

    function onpointerdown(event: PointerEvent, item: ActivityItem) {
        dragged = false
        if (!item.arranged || event.button !== 0 || event.pointerType === 'touch' || arranged.length < 2) return
        press = { item, y: event.clientY, pointerId: event.pointerId }
    }

    /** Where a drop at `y` would seat the dragged icon among the arranged ones, and where the line shows it. */
    function dropAt(y: number, item: ActivityItem): { index: number; lineTop: number } {
        const boxes = tabs()
            .filter((_, at) => items[at]?.arranged)
            .map((tab) => tab.getBoundingClientRect())
        const top = list?.getBoundingClientRect().top ?? 0
        let slot = boxes.findIndex((box) => y < box.top + box.height / 2)
        if (slot < 0) slot = boxes.length
        const edge = slot < boxes.length ? boxes[slot].top - 2 : (boxes.at(-1)?.bottom ?? top) + 2
        // The slot counts the dragged icon where it stands; its seat is among the others.
        const from = arranged.indexOf(item)
        return { index: slot > from ? slot - 1 : slot, lineTop: edge - top }
    }

    function onpointermove(event: PointerEvent) {
        if (!press || event.pointerId !== press.pointerId) return
        if (!drag && Math.abs(event.clientY - press.y) < DRAG_SLOP_PX) return
        if (!drag) (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
        drag = { item: press.item, ...dropAt(event.clientY, press.item) }
    }

    function endDrag(drop: boolean) {
        const ended = drag
        press = null
        drag = null
        if (!ended) return
        dragged = true
        if (drop && ended.index !== arranged.indexOf(ended.item)) onreorder(ended.item, ended.index)
    }

    function onclick(item: ActivityItem) {
        if (dragged) {
            dragged = false
            return
        }
        focusKey = item.panelId
        onselect(item)
    }

    function onwindowkeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && drag) endDrag(false)
    }

    /** Right-click and long press on an icon, raising its menu. */
    function iconMenu(item: ActivityItem) {
        return (node: HTMLElement) => attachContextMenu(node, () => menuTarget(item))
    }

    /** The bar's own menu rises from its button, at the foot of the bar, on the bar's inner side. */
    function openBarMenu(event: MouseEvent) {
        const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
        openContextMenu({ kind: 'activity-bar' }, side === 'left' ? box.right + 4 : box.left - 4, box.bottom, { above: true })
    }
</script>

<svelte:window onkeydown={onwindowkeydown} />

<nav class="bar" data-side={side} data-testid="activity-bar" aria-label="Primary Sidebar views">
    <div class="icons">
        <div class="tabs" role="tablist" aria-orientation="vertical" bind:this={list}>
            {#each items as item (item.panelId)}
                {@const showing = item.panelId === showingPanelId}
                <button
                    type="button"
                    role="tab"
                    class="tab"
                    class:dragging={drag?.item.panelId === item.panelId}
                    data-own-button-style="a tab of a vertical tab list"
                    data-testid="activity-icon"
                    data-kind={item.kind}
                    aria-label={item.title}
                    aria-selected={showing}
                    tabindex={item.panelId === tabStop ? 0 : -1}
                    data-tooltip={withChord(item.title, item.chord)}
                    aria-description={item.chord ? `Shortcut: ${item.chord}` : undefined}
                    onclick={() => onclick(item)}
                    onkeydown={(event) => onkeydown(event, item)}
                    onpointerdown={(event) => onpointerdown(event, item)}
                    {onpointermove}
                    onpointerup={() => endDrag(true)}
                    onpointercancel={() => endDrag(false)}
                    {@attach iconMenu(item)}
                >
                    {#if item.icon}
                        <!-- In-repo constant markup from the icon table, or an extension's own icon,
                             which `iconSvg` cleans before it is drawn. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html iconSvg(item.icon, { size: 20 })}
                    {:else}
                        <span class="letter" aria-hidden="true">{letter(item.title)}</span>
                    {/if}
                </button>
            {/each}
            {#if drag}
                <div class="drop-line" style:top="{drag.lineTop}px" data-testid="activity-drop-line"></div>
            {/if}
        </div>
        {#if shortcuts.length > 0}
            <div class="rule" role="separator" data-testid="activity-rule"></div>
            <div class="shortcuts" role="group" aria-label="Shortcuts" data-testid="activity-shortcuts">
                {#each shortcuts as shortcut (shortcut.id)}
                    <button
                        type="button"
                        class="gk-icon-button"
                        data-testid="activity-shortcut"
                        data-command={shortcut.command}
                        aria-label={shortcut.title}
                        data-tooltip={withChord(shortcut.title, shortcut.chord)}
                        aria-description={shortcut.chord ? `Shortcut: ${shortcut.chord}` : undefined}
                        onclick={() => onshortcut?.(shortcut)}
                    >
                        <!-- In-repo constant markup from the icon table, or an extension's own icon,
                             which `iconSvg` cleans before it is drawn. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html iconSvg(shortcut.icon, { size: 20 })}
                    </button>
                {/each}
            </div>
        {/if}
    </div>
    <button
        type="button"
        class="gk-icon-button"
        data-testid="activity-menu"
        aria-label="Sidebar views"
        aria-haspopup="menu"
        data-tooltip="Sidebar views"
        onclick={openBarMenu}
    >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html iconSvg('more', { size: 20 })}
    </button>
</nav>

<style>
    /* 48px: a 32px icon and 8px either side, the Sidebar's own padding (ADR 0198). The surface is
       the tab strips', so the bar reads as the Primary Sidebar's strip turned on its side. */
    .bar {
        display: flex;
        flex: none;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        width: 3rem;
        padding: 0.5rem 0;
        background: var(--gk-surface-1);
        overflow: clip;
    }
    .bar[data-side='left'] {
        border-right: 1px solid var(--gk-border-soft);
    }
    .bar[data-side='right'] {
        border-left: 1px solid var(--gk-border-soft);
    }

    /* The icons scroll when there are more than the bar is tall, and the menu button stays put. */
    .icons {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 0.5rem;
        width: 100%;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: none;
    }
    .icons::-webkit-scrollbar {
        display: none;
    }
    .tabs,
    .shortcuts {
        position: relative;
        display: flex;
        flex: none;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        width: 100%;
    }
    /* Between the Views and the shortcuts: as wide as an icon, so it divides the column and not the bar. */
    .rule {
        flex: none;
        align-self: center;
        width: 1.5rem;
        height: 1px;
        background: var(--gk-border-strong);
    }

    /* A tab drawn as an icon button is drawn: 32px square, 8px corners, the icon muted until it
       is hovered or its View is showing. The marker for the View that is showing is a 4px bar on
       the bar's outer edge, in the accent, which is the colour of an active state. */
    .tab {
        position: relative;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        padding: 0;
        border: 0;
        border-radius: 0.5rem;
        background: transparent;
        color: var(--gk-text-muted);
        cursor: pointer;
        /* A press that is held raises the menu on a touch screen (attachContextMenu). */
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
    }
    .tab:hover {
        background: var(--gk-menu-hover);
        color: var(--gk-text-strong);
    }
    .tab:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
    .tab[aria-selected='true'] {
        color: var(--gk-text-strong);
    }
    .tab[aria-selected='true']::before {
        content: '';
        position: absolute;
        top: 0.25rem;
        bottom: 0.25rem;
        /* 4px, so the View showing is found at a glance in a column of outlines. */
        width: 4px;
        border-radius: 2px;
        background: var(--gk-accent);
    }
    .bar[data-side='left'] .tab[aria-selected='true']::before {
        left: -0.5rem;
    }
    .bar[data-side='right'] .tab[aria-selected='true']::before {
        right: -0.5rem;
    }
    /* The icon being dragged recedes by colour while the line shows where it will land. */
    .tab.dragging {
        color: var(--gk-text-subtle);
        cursor: grabbing;
    }

    /* A View with no icon: its first letter, at the smallest text size, in a box the icon's size. */
    .letter {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
        border: 1px solid currentColor;
        border-radius: 0.25rem;
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1;
    }

    .drop-line {
        position: absolute;
        left: 0.5rem;
        right: 0.5rem;
        height: 2px;
        border-radius: 1px;
        background: var(--gk-accent);
        pointer-events: none;
    }

    /* Under a finger every icon is 44px, as every other control is. */
    @media (pointer: coarse) {
        .bar {
            width: 3.5rem;
        }
        .tab {
            width: 2.75rem;
            height: 2.75rem;
        }
        .bar[data-side='left'] .tab[aria-selected='true']::before {
            left: -0.375rem;
        }
        .bar[data-side='right'] .tab[aria-selected='true']::before {
            right: -0.375rem;
        }
    }
</style>
