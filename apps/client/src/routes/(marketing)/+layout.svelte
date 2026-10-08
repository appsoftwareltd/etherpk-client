<script lang="ts">
    import ClientAccountNavigationMenu from "$lib/components/ClientAccountNavigationMenu.svelte";
    import GraphNavigationMenu from "$lib/components/GraphNavigationMenu.svelte";
    import ThemeToggle from "@appsoftwareltd/etherpk-shared/theme-toggle";
    import { PUBLIC_DOCS_URL, buildApplicationNavigation } from "@appsoftwareltd/etherpk-shared";
    import ApplicationHeader from "@appsoftwareltd/etherpk-shared/application-header";
    import MarketingFooter from "@appsoftwareltd/etherpk-shared/marketing-footer";
    import { MANAGED_SERVICE_OPERATOR, MANAGED_SERVICE_OPERATOR_NOTICE } from "@appsoftwareltd/etherpk-shared/legal";

    let { children, data } = $props();

    const navItems = $derived(buildApplicationNavigation({
        managed: data.managedService,
        signedIn: data.managedSessionAvailable,
        syncServerUrl: data.serverPortalUrl,
        pricingUrl: data.corporatePricingUrl,
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
            managedBillingUrl={data.corporateBillingUrl}
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

    <!-- EtherPK's pages on a managed Client, the operator's on a self-hosted one, or none. The Client
         is the same landing page as Corporate's, so it offers Pricing and Contact where EtherPK
         runs it. -->
    <MarketingFooter
        copyrightHolder={data.managedService ? MANAGED_SERVICE_OPERATOR.name : "EtherPK"}
        operatorNotice={data.managedService ? MANAGED_SERVICE_OPERATOR_NOTICE : null}
        links={{
            accountUrl: data.managedSessionAvailable ? data.corporateAccountUrl : null,
            syncServerUrl: data.serverPortalUrl,
            graphsUrl: "/graphs",
            pricingUrl: data.corporatePricingUrl,
            docsUrl: PUBLIC_DOCS_URL,
            contactUrl: data.legalLinks.contactUrl,
            termsUrl: data.legalLinks.termsUrl,
            privacyUrl: data.legalLinks.privacyUrl,
        }}
    />
</div>
