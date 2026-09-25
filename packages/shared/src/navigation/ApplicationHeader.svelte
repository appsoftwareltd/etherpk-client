<script lang="ts">
    import { afterNavigate } from "$app/navigation";
    import type { Snippet } from "svelte";
    import { dialogFocus } from "../ui/index.svelte";

    export interface ApplicationNavigationItem {
        href: string;
        label: string;
        current?: boolean;
    }

    interface Props {
        items: ApplicationNavigationItem[];
        actions?: Snippet;
        /**
         * An optional dropdown hanging off one navigation item, matched by label. Only the
         * application that owns the data behind an item can fill this — the Client lists the
         * graphs on this device, which no other origin can enumerate — so it is a snippet
         * rather than data on the item itself.
         *
         * The matched item becomes the disclosure rather than a link, so the panel is expected
         * to offer the item's own destination among its contents. Both surfaces close on
         * `afterNavigate`, so the panel never has to dismiss itself.
         */
        itemMenu?: { label: string; panel: Snippet };
        /**
         * This application's own sections, for the one mobile panel. Applications with a desktop
         * sidebar pass the same navigation here rather than opening a second drawer of their own:
         * below `lg` there is exactly one menu, and this is the half of it that is app-local.
         * Receives a callback that closes the panel, for links that do not change the route.
         */
        sections?: Snippet<[() => void]>;
        mobileUtilities?: Snippet;
        brandHref?: string;
        testId?: string;
        mobileToggleTestId?: string;
        mobilePanelTestId?: string;
    }

    let {
        items,
        actions,
        itemMenu,
        sections,
        mobileUtilities,
        brandHref = "/home",
        testId = "application-header",
        mobileToggleTestId = "mobile-navigation-toggle",
        mobilePanelTestId = "mobile-navigation-panel",
    }: Props = $props();

    let mobileOpen = $state(false);
    let itemMenuOpen = $state(false);
    const mobilePanelId = $derived(`${testId}-mobile-panel`);
    const itemMenuId = $derived(`${testId}-item-menu`);

    function closeMobile() {
        mobileOpen = false;
    }

    function closeItemMenu() {
        itemMenuOpen = false;
    }

    afterNavigate(() => {
        mobileOpen = false;
        itemMenuOpen = false;
    });
</script>

<!-- The panel is modal, so it takes the same contract as every other dialog: focus enters and
     returns to the trigger, Tab stays inside, and Escape closes it. -->
<svelte:window
    onkeydown={(event) => {
        if (event.key !== "Escape") return;
        mobileOpen = false;
        itemMenuOpen = false;
    }}
/>

<header
    data-testid={testId}
    class="sticky top-0 z-30 flex h-14 w-full shrink-0 items-center gap-4 border-b border-gray-950/8 bg-white/92 px-4 shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur-md sm:px-6 dark:border-white/10 dark:bg-[#18181b]/92 dark:shadow-none"
>
    <!-- The badge sits beside the brand link rather than inside it, so it neither joins the
         link's accessible name nor fades with its hover state. -->
    <div class="flex shrink-0 items-center gap-2">
        <a
            href={brandHref}
            aria-label="EtherPK home"
            class="flex shrink-0 items-center gap-2 text-gray-950 transition-opacity hover:opacity-75 dark:text-white"
        >
            <svg class="h-5 w-auto" viewBox="0 0 191.82 166.13" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M67.09,132.92,47.93,166.13H9.59L0,149.52,86.33,0H105.5L19.17,149.52H38.34l19.17-33.2h76.8l9.59,16.6Zm48-83.12,9.65,16.71H143.9L115.08,16.6q-24,41.57-48,83.12H143.9q14.37,24.9,28.76,49.8h-96l-9.59,16.61H182.24l9.58-16.61-38.34-66.4H96C95.85,82.9,113.39,52.73,115.08,49.8Z" />
            </svg>
            <span class="hidden text-base font-semibold tracking-tight min-[400px]:inline">EtherPK</span>
        </a>
        <!-- EtherPK is advertised as live under alpha testing. The badge stays at every width,
             including below 400px where the wordmark hides, because it is the one thing a
             first-time visitor must not miss. `text-box: trim-both cap alphabetic` trims the line
             box to the capitals themselves, so `items-center` centres the word rather than a box
             that includes Inter's descender space; where a browser lacks it the word lands within
             a pixel of centre either way, which is why there is no padding nudge here. -->
        <span
            data-testid="alpha-badge"
            title="EtherPK is in alpha testing"
            class="inline-flex h-5 items-center rounded-md border border-gray-950/15 px-1.5 text-sm font-semibold uppercase leading-none tracking-wider text-gray-600 select-none dark:border-white/15 dark:text-gray-400"
        >
            <!-- The trim goes on a flex item of its own: the property is not inherited, so on the
                 badge itself it would never reach the anonymous box holding the text. -->
            <span class="[text-box:trim-both_cap_alphabetic]">Alpha</span>
        </span>
    </div>

    <nav aria-label="Primary" class="hidden items-center gap-1 lg:flex">
        {#each items as item (item.href + item.label)}
            {@const menu = itemMenu && item.label === itemMenu.label ? itemMenu : null}
            {@const itemClass = item.current
                ? "bg-gray-100 text-gray-950 dark:bg-white/10 dark:text-white"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"}
            {#if menu}
                <!-- Compass shapes this as one control with the chevron inside it. The whole
                     control is the disclosure — the item's own destination is offered inside the
                     menu instead, so there is no half of this button that does something else. -->
                <div class="relative flex items-center">
                    <button
                        type="button"
                        data-testid="{testId}-item-menu-toggle"
                        class="flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pl-3 pr-2.5 text-sm font-medium transition-colors {itemClass}"
                        aria-label={itemMenuOpen ? `Hide ${item.label} menu` : `Show ${item.label} menu`}
                        aria-expanded={itemMenuOpen}
                        aria-controls={itemMenuId}
                        onclick={() => (itemMenuOpen = !itemMenuOpen)}
                    >
                        {item.label}
                        <svg class="h-3.5 w-3.5 shrink-0 motion-safe:transition-transform {itemMenuOpen ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
                        </svg>
                    </button>
                    {#if itemMenuOpen}
                        <div
                            id={itemMenuId}
                            data-testid="{testId}-item-menu"
                            class="absolute left-0 top-full z-40 mt-2 w-72 overflow-hidden rounded-xl border border-gray-950/10 bg-white shadow-xl dark:border-white/10 dark:bg-[#202023]"
                        >
                            {@render menu.panel()}
                        </div>
                    {/if}
                </div>
            {:else}
                <a
                    href={item.href}
                    aria-current={item.current ? "page" : undefined}
                    class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors {itemClass}"
                >
                    {item.label}
                </a>
            {/if}
        {/each}
    </nav>

    <div class="ml-auto flex min-w-0 items-center gap-2">
        {#if actions}
            {@render actions()}
        {/if}
        <button
            type="button"
            data-testid={mobileToggleTestId}
            class="-mr-1 flex shrink-0 items-center justify-center rounded-lg p-2 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-950 lg:hidden dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            aria-controls={mobilePanelId}
            onclick={() => (mobileOpen = !mobileOpen)}
        >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
            </svg>
        </button>
    </div>
</header>

{#if itemMenuOpen}
    <!-- A click anywhere else dismisses the dropdown. It must stay *below* the sticky header's
         z-30 stacking context: the panel lives inside that context, so a backdrop at the same
         level would paint over the panel and eat the clicks meant for it. -->
    <button
        type="button"
        class="fixed inset-0 z-20 hidden cursor-default lg:block"
        aria-label="Close menu"
        tabindex="-1"
        onclick={closeItemMenu}
    ></button>
{/if}

{#if mobileOpen}
    <button
        type="button"
        class="fixed inset-0 z-40 bg-gray-950/35 backdrop-blur-[2px] lg:hidden"
        aria-label="Close navigation menu"
        tabindex="-1"
        onclick={closeMobile}
    ></button>

    <div
        id={mobilePanelId}
        data-testid={mobilePanelTestId}
        role="dialog"
        aria-modal="true"
        aria-label="Application navigation"
        tabindex="-1"
        {@attach dialogFocus}
        class="fixed inset-y-0 right-0 z-50 flex w-72 max-w-[86vw] flex-col border-l border-gray-950/10 bg-white shadow-2xl lg:hidden dark:border-white/10 dark:bg-[#18181b]"
    >
        <div class="flex h-14 shrink-0 items-center justify-between border-b border-gray-950/8 px-4 dark:border-white/10">
            <span class="text-sm font-semibold text-gray-950 dark:text-white">Navigate</span>
            <button
                type="button"
                data-dialog-dismiss
                class="rounded-lg p-2 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
                aria-label="Close navigation menu"
                onclick={closeMobile}
            >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                    <path d="M6 18 18 6M6 6l12 12" />
                </svg>
            </button>
        </div>

        <!-- Both tiers scroll together: the cross-application destinations, then this
             application's own sections where it has any. -->
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <nav aria-label="Mobile primary" class="flex shrink-0 flex-col gap-1 p-3">
                {#each items as item (item.href + item.label)}
                    <a
                        href={item.href}
                        aria-current={item.current ? "page" : undefined}
                        class="rounded-lg px-3 py-2.5 text-sm font-medium transition-colors {item.current ? 'bg-gray-100 text-gray-950 dark:bg-white/10 dark:text-white' : 'text-gray-700 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white'}"
                        onclick={closeMobile}
                    >
                        {item.label}
                    </a>
                    {#if itemMenu && item.label === itemMenu.label}
                        <!-- No nested disclosure at this size: the menu is simply part of the
                             list, indented under the item it belongs to. -->
                        <div class="mb-1 ml-3 border-l border-gray-950/8 pl-2 dark:border-white/10">
                            {@render itemMenu.panel()}
                        </div>
                    {/if}
                {/each}
            </nav>

            {#if sections}
                <div class="shrink-0 border-t border-gray-950/8 dark:border-white/10">
                    {@render sections(closeMobile)}
                </div>
            {/if}
        </div>

        {#if mobileUtilities}
            <div class="shrink-0 border-t border-gray-950/8 p-4 dark:border-white/10">
                {@render mobileUtilities()}
            </div>
        {/if}
    </div>
{/if}
