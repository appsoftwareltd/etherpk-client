<script lang="ts">
    /**
     * A permanent Install entry: the header button on a computer, the row in the phone's header
     * menu and the item in the account menu. Each runs `startInstall`, so the browser's dialog
     * opens where it is offered and the Install dialog with this platform's steps everywhere else.
     *
     * - `header` shows only while a Chromium browser holds its install offer, because a button
     *   there should do the install, not explain it.
     * - `menu` and `account` show whenever the browser can install and the app is not installed.
     */
    import { canInstall } from "$lib/storage/install-platform";
    import { installPlatform, installState, startInstall } from "./install-state.svelte";

    let { placement }: { placement: "header" | "menu" | "account" } = $props();

    const install = $derived(installState());
    const shown = $derived(
        !install.installed &&
            !install.installedOnDevice &&
            (placement === "header" ? install.promptAvailable : canInstall(installPlatform)),
    );
</script>

{#if shown}
    {#if placement === "header"}
        <button
            type="button"
            onclick={startInstall}
            data-testid="install-entry-header"
            title="Install EtherPK to open it from your home screen, Dock or taskbar and work with no network."
            class="hidden items-center gap-1.5 rounded-lg border border-gray-950/10 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-950 lg:inline-flex dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white"
        >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                    d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.69L6.28 8.47a.75.75 0 0 0-1.06 1.06l4.25 4.25a.75.75 0 0 0 1.06 0l4.25-4.25a.75.75 0 1 0-1.06-1.06l-2.97 2.97V2.75Z"
                />
                <path d="M3.5 13.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
            </svg>
            Install app
        </button>
    {:else if placement === "menu"}
        <button
            type="button"
            onclick={startInstall}
            data-testid="install-entry-menu"
            class="w-full rounded-lg border border-gray-950/10 px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
        >
            Install app
        </button>
    {:else}
        <div class="px-2 pb-2">
            <button
                type="button"
                onclick={startInstall}
                data-testid="install-entry-account"
                class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
            >
                Install app
            </button>
        </div>
    {/if}
{/if}
