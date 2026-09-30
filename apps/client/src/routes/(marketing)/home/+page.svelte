<script lang="ts">
    import MarketingHomePage from "@appsoftwareltd/etherpk-shared/marketing-home-page";
    import { MANAGED_SERVICE_OPERATOR } from "@appsoftwareltd/etherpk-shared/legal";

    let { data } = $props();
</script>

<!-- A self-hosted Client (no Corporate) offers its team's Sync Server in place of Sync+, and
     leaves support to the people who run it. -->
<MarketingHomePage
    appHref="/graphs"
    demoHref="/demo"
    pricingHref={data.corporatePricingUrl}
    canonicalUrl={data.corporateHomeUrl}
    managed={data.managedService}
    syncServerHref={data.serverPortalUrl}
    supportEmail={data.managedService ? MANAGED_SERVICE_OPERATOR.supportEmail : null}
/>
