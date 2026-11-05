<script lang="ts">
    import type { LegalLinks } from "./legal-links";

    /**
     * The line under the sign-up options that points at the deployment's Terms and Privacy
     * Policy. The Terms treat creating an account as accepting them, so the page offering the
     * account has to show where they are. A deployment with neither page shows nothing.
     */
    let { legalLinks }: { legalLinks: LegalLinks } = $props();

    const linkClass = "font-medium text-neutral-950 underline underline-offset-2 hover:text-neutral-700 dark:text-white dark:hover:text-neutral-300";
</script>

{#if legalLinks.termsUrl || legalLinks.privacyUrl}
    <p class="mt-6 text-center text-sm text-neutral-500 dark:text-neutral-400" data-testid="registration-consent">
        {#if legalLinks.termsUrl}
            By creating an account you agree to the <a href={legalLinks.termsUrl} class={linkClass}>Terms of Service</a>.
        {/if}
        {#if legalLinks.privacyUrl}
            The <a href={legalLinks.privacyUrl} class={linkClass}>Privacy Policy</a> explains how your data is used.
        {/if}
    </p>
{/if}
