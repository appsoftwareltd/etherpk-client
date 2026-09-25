<script lang="ts">
    import MarketingHomePage from "@appsoftwareltd/etherpk-shared/marketing-home-page";

    let { data } = $props();
</script>

<MarketingHomePage appHref="/graphs" demoHref="/demo" pricingHref={data.corporatePricingUrl} canonicalUrl={data.corporateHomeUrl} />
