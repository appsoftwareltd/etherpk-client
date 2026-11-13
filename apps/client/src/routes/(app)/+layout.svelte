<script lang="ts">
    import { page } from "$app/state";
    import ActivityToastHost from "#lib/activity/ui/ActivityToastHost.svelte";
    import AssetUploadModal from "#lib/components/AssetUploadModal.svelte";
    import ClientAccountNavigationMenu from "#lib/components/ClientAccountNavigationMenu.svelte";
    import GraphNavigationMenu from "#lib/components/GraphNavigationMenu.svelte";
    import InstallEntry from "#lib/install/InstallEntry.svelte";
    import ThemeToggle from "@appsoftwareltd/etherpk-shared/theme-toggle";
    import DeviceApprovalPrompt from "#lib/sync/ui/DeviceApprovalPrompt.svelte";
    import RecoveryCodeHost from "#lib/sync/ui/RecoveryCodeHost.svelte";
    import { buildApplicationNavigation } from "@appsoftwareltd/etherpk-shared";
    import ApplicationHeader from "@appsoftwareltd/etherpk-shared/application-header";
    import { suppressBrowserChords } from "#lib/surface/index.js";
    import { startPersonSettingsSync } from "#lib/person-settings/person-settings-sync.js";
    import { appHeaderHiddenOnPhone } from "#lib/workspace/app-header.svelte.js";
    import { startUsageStatistics } from "#lib/telemetry/usage-statistics-device.js";
    import { isDemoPath } from "#lib/telemetry/workspace-usage.js";

    let { data, children } = $props();

    // Documents persist as they are typed, so Ctrl/⌘+S has no job here; unhandled it opens
    // the browser's "Save page" dialog. Swallowed app-wide, not per workspace, so the graph
    // list and settings pages behave the same as an open document.
    $effect(() => suppressBrowserChords(["Mod+S"]));

    // The person's settings follow them through their account (ADR 0134) while the Client runs.
    $effect(() => startPersonSettingsSync());

    // Usage statistics (ADR 0187) start with the app: the notice the first time, the open after
    // that. Not on the demo, which a visitor from the home page opens before they have an app to
    // be told about: it starts when they leave the demo for a page of the app, and nothing is
    // counted while they are back in it.
    $effect(() => {
        if (!isDemoPath(page.url.pathname)) startUsageStatistics();
    });

    const navItems = $derived(buildApplicationNavigation({
        managed: data.managedService,
        signedIn: data.managedSessionAvailable,
        syncServerUrl: data.serverPortalUrl,
        pricingUrl: data.corporatePricingUrl,
        graphsUrl: "/graphs",
        // This is the app, so the link is its Graphs page and the menu of graphs below.
        withinClient: true,
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
        <InstallEntry placement="header" />
        <div class="hidden items-center lg:flex">
            <ThemeToggle themePreference={data.themePreference} resolvedTheme={data.resolvedTheme} />
        </div>
        <ClientAccountNavigationMenu
            managedSessionAvailable={data.managedSessionAvailable}
            managedAccountUrl={data.corporateAccountUrl}
            managedBillingUrl={data.corporateBillingUrl}
        />
    {/snippet}

    {#snippet mobileUtilities()}
        <InstallEntry placement="menu" />
        <div class="flex justify-center">
            <ThemeToggle themePreference={data.themePreference} resolvedTheme={data.resolvedTheme} />
        </div>
    {/snippet}


{#snippet graphsMenu()}
    <GraphNavigationMenu />
{/snippet}

    <div class={["app-header", { "hidden-on-phone": appHeaderHiddenOnPhone.current }]}>
        <ApplicationHeader
            items={navItems}
            actions={headerActions}
            itemMenu={{ label: "Graphs", panel: graphsMenu }}
            {mobileUtilities}
            brandHref={data.deploymentHomeUrl}
            testId="app-navbar"
            mobileToggleTestId="mobile-nav-toggle"
            mobilePanelTestId="mobile-nav-flyout"
        />
    </div>

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

<style>
    .app-header {
        display: contents;
    }
    /* Below LAYOUT_BREAKPOINT_PX in #lib/layout/breakpoint.ts, as the workspace layout's own query is. */
    @media not all and (min-width: 1024px) {
        .app-header.hidden-on-phone {
            display: none;
        }
    }
</style>
