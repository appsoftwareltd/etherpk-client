<script lang="ts">
    /**
     * How to install EtherPK here, for the browser and device this page runs on: the browser's
     * own dialog where it offers one (Chromium), the steps in its menus where it does not, and
     * what installing gives. Shared by the Install dialog and the section in Graph Settings, so
     * the two never disagree.
     */
    import { canInstall, installSteps } from "$lib/storage/install-platform";
    import { installDialog, installPlatform, installState, startInstall } from "./install-state.svelte";

    const install = $derived(installState());
    const steps = installSteps(installPlatform);
    const sharesFromOtherApps = installPlatform === "chromium-android" || installPlatform === "chromeos";
</script>

<div class="space-y-3 text-sm text-(--gk-text-default)">
    {#if install.installed}
        <p data-testid="app-install-installed">EtherPK is installed on this device.</p>
    {:else if install.installedOnDevice}
        <p data-testid="app-install-elsewhere">
            EtherPK is installed on this device. Open it from your Start menu, Dock, launcher or home screen.
        </p>
    {:else if install.promptAvailable}
        <!-- A monotone primary: the theme's strongest text colour as the fill (black in light,
             white in dark) and its base surface as the label, so it leads without the accent. -->
        <button
            type="button"
            onclick={startInstall}
            data-testid="app-install-prompt"
            class="inline-flex items-center gap-1.5 rounded-lg bg-(--gk-text-strong) px-3 py-1.5 font-semibold text-(--gk-surface-0) shadow-sm transition-colors hover:bg-(--gk-text-default) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-text-strong) pointer-coarse:min-h-11"
        >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                    d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.69L6.28 8.47a.75.75 0 0 0-1.06 1.06l4.25 4.25a.75.75 0 0 0 1.06 0l4.25-4.25a.75.75 0 1 0-1.06-1.06l-2.97 2.97V2.75Z"
                />
                <path d="M3.5 13.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
            </svg>
            Install EtherPK
        </button>
    {:else if canInstall(installPlatform)}
        {#if installDialog.dismissed}
            <p data-testid="app-install-dismissed">Not installed. You can install it from the browser's menu at any time:</p>
        {/if}
        <ol class="list-decimal space-y-1 pl-5" data-testid="app-install-steps">
            {#each steps as step (step)}
                <li>{step}</li>
            {/each}
        </ol>
    {:else}
        <p data-testid="app-install-unavailable">
            This browser cannot install web apps. Chrome and Edge can, and so can Safari, and Firefox on Windows and
            Android.
        </p>
    {/if}
    {#if !install.installed}
        <p class="text-(--gk-text-muted)">
            Installed, EtherPK opens in its own window from your home screen, Dock or taskbar, and starts with no
            network. Your browser is also less likely to clear EtherPK data from this device.{#if sharesFromOtherApps}
                It also appears on the share sheet, so you can share text and links from other apps into Quick notes.{/if}
        </p>
    {/if}
</div>
