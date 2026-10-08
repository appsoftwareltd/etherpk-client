<script lang="ts">
    import type { Snippet } from "svelte";
    import {
        SYNC_PLUS_OFFER_BUTTON_CLASS,
        SYNC_PLUS_OFFER_PANEL_CLASS,
        SYNC_PLUS_OFFER_TEXT,
        SYNC_PLUS_PRICING_LABEL,
    } from "./sync-plus-offer";

    /**
     * The offer a Free account sees on every origin: what is free and what Sync+ adds, with a way
     * on. `pricingUrl` gives the usual button, to Corporate's pricing page. Billing passes its
     * Checkout button as `action` instead. With neither, as when paid plans are off, the panel is
     * the sentence alone.
     */
    let {
        pricingUrl = null,
        action,
    }: {
        pricingUrl?: string | null;
        action?: Snippet;
    } = $props();
</script>

<div data-testid="sync-plus-offer" class={SYNC_PLUS_OFFER_PANEL_CLASS}>
    <p>{SYNC_PLUS_OFFER_TEXT}</p>
    {#if action}
        <div class="shrink-0">{@render action()}</div>
    {:else if pricingUrl}
        <a href={pricingUrl} class={SYNC_PLUS_OFFER_BUTTON_CLASS}>{SYNC_PLUS_PRICING_LABEL}</a>
    {/if}
</div>
