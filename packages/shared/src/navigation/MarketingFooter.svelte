<script lang="ts" module>
    /** The destinations a public page's footer offers; each is shown where the deployment has it. */
    export interface MarketingFooterLinks {
        /** Only while signed in: signed out it would bounce through sign-in. */
        accountUrl?: string | null;
        syncServerUrl?: string | null;
        graphsUrl: string;
        /** Only where EtherPK sells Sync+. */
        pricingUrl?: string | null;
        docsUrl?: string | null;
        contactUrl?: string | null;
        termsUrl?: string | null;
        privacyUrl?: string | null;
        /** Where a visitor changes a choice about cookies or visit counting, where the app has one. */
        privacyChoicesUrl?: string | null;
    }
</script>

<script lang="ts">
    /**
     * The public pages' footer, the same on Corporate, the Sync Server and the Client: one list of
     * destinations in one order. The links carry their own colours, so an app stylesheet that
     * colours every `a` (the Client's) does not turn them into the accent colour.
     */
    let {
        copyrightHolder,
        links,
        operatorNotice = null,
    }: {
        /** Who the copyright line names: the operating company on the managed service. */
        copyrightHolder: string;
        links: MarketingFooterLinks;
        /** The managed service's operator statement, under the links. */
        operatorNotice?: string | null;
    } = $props();

    const entries = $derived(
        [
            { label: "Account", href: links.accountUrl },
            { label: "Sync Server", href: links.syncServerUrl },
            { label: "Graphs", href: links.graphsUrl },
            { label: "Pricing", href: links.pricingUrl },
            { label: "Docs", href: links.docsUrl },
            { label: "Contact", href: links.contactUrl },
            { label: "Terms", href: links.termsUrl },
            { label: "Privacy", href: links.privacyUrl },
            { label: "Privacy choices", href: links.privacyChoicesUrl },
        ].filter((entry): entry is { label: string; href: string } => Boolean(entry.href)),
    );
</script>

<footer data-testid="marketing-footer" class="mt-16 border-t border-gray-950/5 py-8 dark:border-white/10">
    <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-gray-500 sm:flex-row sm:px-6 dark:text-gray-400">
        <span>© {new Date().getFullYear()} {copyrightHolder}. All rights reserved.</span>
        <nav class="flex flex-wrap justify-center gap-x-5 gap-y-2" aria-label="Footer">
            {#each entries as entry (entry.label)}
                <a href={entry.href} class="text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-white">{entry.label}</a>
            {/each}
        </nav>
    </div>
    {#if operatorNotice}
        <p class="mx-auto mt-4 max-w-7xl px-4 text-center text-sm text-gray-500 sm:px-6 dark:text-gray-400" data-testid="operator-notice">{operatorNotice}</p>
    {/if}
</footer>
