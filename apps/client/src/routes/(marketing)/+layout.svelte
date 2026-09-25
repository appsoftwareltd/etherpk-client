<script lang="ts">
    import ClientAccountNavigationMenu from "$lib/components/ClientAccountNavigationMenu.svelte";
    import GraphNavigationMenu from "$lib/components/GraphNavigationMenu.svelte";
    import ThemeToggle from "@appsoftwareltd/etherpk-shared/theme-toggle";
    import { buildApplicationNavigation } from "@appsoftwareltd/etherpk-shared";
    import ApplicationHeader from "@appsoftwareltd/etherpk-shared/application-header";

    let { children, data } = $props();

    const navItems = $derived(buildApplicationNavigation({
        // Account is auth-gated; offering it signed out only bounces through /login.
        accountUrl: data.managedSessionAvailable ? data.corporateAccountUrl : null,
        syncServerUrl: data.serverPortalUrl,
        graphsUrl: "/graphs",
    }));
</script>

<div class="isolate flex min-h-screen flex-col">
    {#snippet headerActions()}
        <div class="hidden items-center lg:flex">
            <ThemeToggle themePreference={data.themePreference} resolvedTheme={data.resolvedTheme} />
        </div>
        <!-- Client authentication is visible on the home page as well as inside the app. -->
        <ClientAccountNavigationMenu
            managedSessionAvailable={data.managedSessionAvailable}
            managedAccountUrl={data.corporateAccountUrl}
        />
    {/snippet}

    {#snippet mobileUtilities()}
        <div class="flex justify-center">
            <ThemeToggle themePreference={data.themePreference} resolvedTheme={data.resolvedTheme} />
        </div>
    {/snippet}


{#snippet graphsMenu()}
    <GraphNavigationMenu />
{/snippet}

    <ApplicationHeader
        items={navItems}
        actions={headerActions}
        itemMenu={{ label: "Graphs", panel: graphsMenu }}
        {mobileUtilities}
        testId="marketing-header"
    />

    <main class="flex-1">
        {@render children()}
    </main>

    <footer class="mt-16 border-t border-gray-950/5 py-8 dark:border-white/10">
        <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-gray-500 sm:flex-row sm:px-6 dark:text-gray-400">
            <span>© {new Date().getFullYear()} EtherPK. All rights reserved.</span>
            <nav class="flex flex-wrap justify-center gap-5" aria-label="Footer">
                {#if data.managedSessionAvailable && data.corporateAccountUrl}
                    <a href={data.corporateAccountUrl} class="transition-colors hover:text-gray-700 dark:hover:text-white">Account</a>
                {/if}
                {#if data.serverPortalUrl}
                    <a href={data.serverPortalUrl} class="transition-colors hover:text-gray-700 dark:hover:text-white">Sync Server</a>
                {/if}
                <a href="/graphs" class="transition-colors hover:text-gray-700 dark:hover:text-white">Graphs</a>
                <a href="/terms" class="transition-colors hover:text-gray-700 dark:hover:text-white">Terms</a>
                <a href="/privacy" class="transition-colors hover:text-gray-700 dark:hover:text-white">Privacy</a>
            </nav>
        </div>
    </footer>
</div>
