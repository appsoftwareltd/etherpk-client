<script lang="ts">
    /**
     * An offer to install, inline in the place the person is already looking (the folder access
     * screen, Quick notes, the Graphs page on an iPhone). It shows only where installing would
     * help on this platform and only under the once-only rules in `install-offers.ts`: claimed
     * when it is first drawn, kept for the session, gone once dismissed.
     */
    import { onMount } from "svelte";
    import {
        type InstallOfferMoment,
        claimInstallOffer,
        dismissInstallOffer,
        installOfferEligible,
    } from "$lib/storage/install-offers";
    import { installPlatform, installState, startInstall } from "./install-state.svelte";

    let { moment, text }: { moment: InstallOfferMoment; text: string } = $props();

    let claimed = $state(false);
    let dismissed = $state(false);

    const install = $derived(installState());
    const eligible = $derived(installOfferEligible(moment, { platform: installPlatform, ...install }));

    onMount(() => {
        // Claimed once, when first drawn: the rules count an offer as seen when it was shown.
        if (installOfferEligible(moment, { platform: installPlatform, ...installState() })) {
            claimed = claimInstallOffer(moment);
        }
    });

    function notNow() {
        dismissInstallOffer(moment);
        dismissed = true;
    }
</script>

{#if claimed && eligible && !dismissed}
    <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-(--gk-border-soft) bg-(--gk-info-surface) px-3 py-2 text-sm text-(--gk-text-default)"
        data-testid="install-offer"
        data-install-offer={moment}
    >
        <p class="min-w-0 flex-1">{text}</p>
        <div class="flex gap-2">
            <button
                type="button"
                onclick={startInstall}
                data-testid="install-offer-install"
                class="rounded-lg bg-(--gk-accent) px-3 py-1.5 font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover) pointer-coarse:min-h-11"
                >Install</button
            >
            <button
                type="button"
                onclick={notNow}
                data-testid="install-offer-dismiss"
                class="rounded-lg border border-(--gk-border-strong) px-3 py-1.5 font-medium text-(--gk-text-default) hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
                >Not now</button
            >
        </div>
    </div>
{/if}
