<script lang="ts">
    /**
     * The [[Context Menu]] surface (CONTEXT.md): rows contributed through the
     * `context-menu` [[Contribution Point]], each resolving to a [[Command]] invoked with
     * the target.
     *
     * Hosted once by the workspace and driven by the `context-menu` store, so a right-click
     * anywhere — including dockview's tab DOM, which we do not render — can raise it
     * without every call site owning a popup.
     *
     * Positioning is viewport-clamped rather than clever: the menu is small, and flipping it
     * to stay on screen matters far more than anchoring it prettily.
     */
    import { tick } from "svelte";

    import { getActiveCommandRegistry, listContextMenuItems, tryGetActiveContributionRegistry } from "$lib/surface";
    import { iconSvg } from "$lib/surface/icons";

    import { closeContextMenu, getContextMenuState, subscribeContextMenu, type ContextMenuState } from "../context-menu-store";

    let menu = $state<ContextMenuState>(getContextMenuState());
    $effect(() => subscribeContextMenu((s) => (menu = s)));

    let el = $state<HTMLDivElement>();
    let active = $state(0);
    /** Clamped position, resolved once the menu has been measured. */
    let pos = $state({ x: 0, y: 0 });

    const rows = $derived.by(() => {
        if (!menu.open || !menu.target) return [];
        const contributions = tryGetActiveContributionRegistry();
        return contributions ? listContextMenuItems(contributions, menu.target) : [];
    });
    /** Whether any row has an icon: then every row keeps the icon's column, so the labels line up. */
    const withIcons = $derived(rows.some((row) => row.icon !== undefined));

    /**
     * What had focus when the menu opened: an editor after Shift+F10, a tab after a right-click.
     * Given back when the menu closes without a row moving it elsewhere (Escape, a click on the
     * backdrop), so a keyboard user is not left on the page body.
     */
    let returnFocus: HTMLElement | null = null;

    $effect(() => {
        if (menu.open || !returnFocus) return;
        const target = returnFocus;
        returnFocus = null;
        const nowhere = document.activeElement === null || document.activeElement === document.body;
        if (nowhere && target.isConnected) target.focus();
    });

    // Re-clamp whenever the menu opens: it has no size until it is in the DOM.
    $effect(() => {
        if (!menu.open) return;
        active = 0;
        const focused = document.activeElement;
        returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : null;
        void (async () => {
            await tick();
            const rect = el?.getBoundingClientRect();
            const width = rect?.width ?? 200;
            const height = rect?.height ?? 120;
            pos = {
                x: Math.min(menu.x, window.innerWidth - width - 8),
                y: Math.min(menu.y, window.innerHeight - height - 8),
            };
            el?.focus();
        })();
    });

    async function run(index: number) {
        const row = rows[index];
        const target = menu.target;
        closeContextMenu();
        if (!row || !target) return;
        await getActiveCommandRegistry().execute(row.command, target);
    }

    function onKeydown(event: KeyboardEvent) {
        if (rows.length === 0) return;
        if (event.key === "Escape") {
            event.preventDefault();
            closeContextMenu();
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            active = (active + 1) % rows.length;
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            active = (active - 1 + rows.length) % rows.length;
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void run(active);
        }
    }
</script>

{#if menu.open && rows.length > 0}
    <!--
        A full-viewport backdrop rather than a document-level listener: it captures the
        dismissing click (including the right-click that would otherwise open the browser's
        own menu underneath) without racing the click that opened this one.
    -->
    <div
        class="fixed inset-0 z-50"
        role="presentation"
        onpointerdown={closeContextMenu}
        oncontextmenu={(e) => {
            e.preventDefault();
            closeContextMenu();
        }}
    ></div>
    <!--
        The menu takes focus when it opens, so the `contextmenu` the Menu key raises on release
        (Windows) lands here; refusing it keeps the browser's own menu from opening over this one.
    -->
    <div
        bind:this={el}
        data-testid="context-menu"
        role="menu"
        tabindex="-1"
        onkeydown={onKeydown}
        oncontextmenu={(e) => e.preventDefault()}
        style:left="{pos.x}px"
        style:top="{pos.y}px"
        class="fixed z-50 min-w-48 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-(--gk-surface-1) py-1 shadow-lg focus:outline-none"
    >
        {#each rows as row, index (row.id)}
            {#if row.separatorBefore && index > 0}
                <div class="my-1 h-px bg-gray-100 dark:bg-white/10" role="separator"></div>
            {/if}
            <button
                type="button"
                role="menuitem"
                data-testid="context-menu-item"
                data-command={row.command}
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 pointer-coarse:min-h-11 dark:text-gray-200 {index === active
                    ? 'bg-gray-100 dark:bg-white/10'
                    : ''} hover:bg-gray-100 dark:hover:bg-white/10"
                onpointerenter={() => (active = index)}
                onclick={() => void run(index)}
            >
                <!-- On one line, with nothing between the icon and the label: the row's text is its
                     label alone, which an anchored text match reads. The icon is in-repo constant
                     markup from the icon table, never user content. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {#if withIcons}<span class="grid size-4 shrink-0 place-items-center text-gray-500 dark:text-gray-400" aria-hidden="true" data-icon={row.icon}>{#if row.icon}{@html iconSvg(row.icon)}{/if}</span>{/if}<span>{row.label}</span>
            </button>
        {/each}
    </div>
{/if}
