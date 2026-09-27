<script lang="ts">
    import MarketingHomePage from "@appsoftwareltd/etherpk-shared/marketing-home-page";

    let { data } = $props();
</script>

<!-- A self-hosted Client (no Corporate) offers its team's Sync Server in place of Sync+. -->
<MarketingHomePage
    appHref="/graphs"
    demoHref="/demo"
    pricingHref={data.corporatePricingUrl}
    canonicalUrl={data.corporateHomeUrl}
    managed={data.managedService}
    syncServerHref={data.serverPortalUrl}
/>
