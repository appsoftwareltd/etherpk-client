<script lang="ts">
    import { page } from "$app/state";
    import ActivityToastHost from "$lib/activity/ui/ActivityToastHost.svelte";
    import AssetUploadModal from "$lib/components/AssetUploadModal.svelte";
    import ClientAccountNavigationMenu from "$lib/components/ClientAccountNavigationMenu.svelte";
    import GraphNavigationMenu from "$lib/components/GraphNavigationMenu.svelte";
    import ThemeToggle from "@appsoftwareltd/etherpk-shared/theme-toggle";
    import DeviceApprovalPrompt from "$lib/sync/ui/DeviceApprovalPrompt.svelte";
    import RecoveryCodeHost from "$lib/sync/ui/RecoveryCodeHost.svelte";
    import { buildApplicationNavigation } from "@appsoftwareltd/etherpk-shared";
    import ApplicationHeader from "@appsoftwareltd/etherpk-shared/application-header";
    import { suppressBrowserChords } from "$lib/surface";

    let { data, children } = $props();

    // Documents persist as they are typed, so Ctrl/⌘+S has no job here; unhandled it opens
    // the browser's "Save page" dialog. Swallowed app-wide, not per workspace, so the graph
    // list and settings pages behave the same as an open document.
    $effect(() => suppressBrowserChords(["Mod+S"]));

    const navItems = $derived(buildApplicationNavigation({
        accountUrl: data.corporateAccountUrl,
        syncServerUrl: data.serverPortalUrl,
        graphsUrl: "/graphs",
        current: page.url.pathname === "/graphs" || page.url.pathname.startsWith("/graphs/")
            ? "graphs"
            : null,
    }));
</script>

<svelte:head>
    <meta name="robots" content="noindex" />
</svelte:head>

<div class="flex min-h-screen flex-col">
    {#snippet headerActions()}
        <div class="hidden items-center lg:flex">
            <ThemeToggle themePreference={data.themePreference} resolvedTheme={data.resolvedTheme} />
        </div>
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
        testId="app-navbar"
        mobileToggleTestId="mobile-nav-toggle"
        mobilePanelTestId="mobile-nav-flyout"
    />

    <!-- The Client has no app-level sidebar. Graph workspaces provide their own dockable panes. -->
    <main class="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {@render children()}
    </main>
</div>

<!-- These long-lived hosts remain outside route content so their work survives navigation. -->
<AssetUploadModal />
<DeviceApprovalPrompt />
<RecoveryCodeHost />
<ActivityToastHost />
