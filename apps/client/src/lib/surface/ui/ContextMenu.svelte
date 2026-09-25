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
    <div
        bind:this={el}
        data-testid="context-menu"
        role="menu"
        tabindex="-1"
        onkeydown={onKeydown}
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
                class="block w-full px-3 py-1.5 text-left text-sm text-gray-700 dark:text-gray-200 {index === active
                    ? 'bg-gray-100 dark:bg-white/10'
                    : ''} hover:bg-gray-100 dark:hover:bg-white/10"
                onpointerenter={() => (active = index)}
                onclick={() => void run(index)}
            >{row.label}</button>
        {/each}
    </div>
{/if}
