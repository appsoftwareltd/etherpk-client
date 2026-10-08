<script lang="ts">
    /**
     * Orphaned-asset scan and cleanup (CONTEXT.md → Orphaned Asset), shared by the Graph
     * Settings dialog (workspace cog) and the filesystem graph's settings page. The
     * caller supplies backend-appropriate {@link GraphAssetTools}; deletion is two-step
     * (armed confirm) because it is permanent.
     *
     * A scan that could not read every document still offers what looked unused, with a warning
     * (`OrphanScan.unchecked`): an asset used only inside an unread one looks unused to it, so
     * the person can unlock and scan again before deleting.
     */
    import type { GraphAssetTools, OrphanScan } from "$lib/storage/fs/asset-orphans";

    let { assetTools }: { assetTools: GraphAssetTools } = $props();

    let scanning = $state(false);
    let scanResult = $state<OrphanScan | null>(null);
    let deleteArmed = $state(false);
    let deleting = $state(false);
    let deletedCount = $state<number | null>(null);
    let error = $state<string | null>(null);

    /**
     * The warning beside the list when documents went unread: which ones, that an asset used only
     * inside them is in the list, and how to check them first. Unlocking helps only where the scan
     * had the graph's protection session (the open graph's Settings); on the Graphs page it has none.
     * Shown only when something is offered, since it warns about deleting.
     */
    const unchecked = $derived.by(() => {
        const skipped = scanResult?.unchecked;
        if (!skipped || scanResult!.orphans.length === 0) return null;
        const { protectedDocuments: locked, unreadableDocuments: unreadable } = skipped;
        const causes = [
            locked > 0 ? (locked === 1 ? "a protected document is locked" : `${locked} protected documents are locked`) : null,
            unreadable > 0 ? (unreadable === 1 ? "a document will not decrypt" : `${unreadable} documents will not decrypt`) : null,
        ].filter((cause): cause is string => cause !== null);
        const one = locked + unreadable === 1;
        const text = `${causes.join(" and ")}, so the scan could not check ${one ? "it" : "them"}. An asset used only there is listed here, and deleting it leaves it missing there.`;
        const help =
            locked === 0
                ? ""
                : skipped.unlockable
                  ? " Unlock protected documents and scan again to check them first."
                  : " To check protected documents first, open the graph and scan from Settings > Maintenance.";
        return text.charAt(0).toUpperCase() + text.slice(1) + help;
    });

    async function runScan() {
        if (scanning) return;
        scanning = true;
        error = null;
        scanResult = null;
        deleteArmed = false;
        deletedCount = null;
        try {
            scanResult = await assetTools.scan();
        } catch (e) {
            error = `Scan failed: ${(e as Error).message}`;
        } finally {
            scanning = false;
        }
    }

    /** Two-step delete: the first click arms, the second permanently deletes. */
    async function runDelete() {
        if (!scanResult || deleting) return;
        if (!deleteArmed) {
            deleteArmed = true;
            return;
        }
        deleting = true;
        error = null;
        try {
            deletedCount = await assetTools.remove(scanResult.orphans.map((o) => o.id));
            scanResult = null;
            deleteArmed = false;
        } catch (e) {
            error = `Delete failed: ${(e as Error).message}`;
        } finally {
            deleting = false;
        }
    }
</script>

<div class="space-y-2">
    <button
        type="button"
        onclick={runScan}
        disabled={scanning}
        data-testid="orphan-scan"
        class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
    >{scanning ? "Scanning…" : "Scan for orphaned assets"}</button>
    {#if scanResult}
        <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="orphan-result">
            {#if scanResult.totalAssets === 0}
                This graph has no assets.
            {:else if scanResult.orphans.length === 0}
                All {scanResult.totalAssets} assets are referenced ({scanResult.scannedDocuments} documents scanned).
            {:else}
                {scanResult.orphans.length} of {scanResult.totalAssets} assets are referenced by no document ({scanResult.scannedDocuments} documents scanned):
            {/if}
        </p>
        {#if unchecked}
            <p
                class="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-900 dark:text-amber-200"
                data-testid="orphan-unchecked"
            >
                {unchecked}
            </p>
        {/if}
        {#if scanResult.dedupBackfill && (scanResult.dedupBackfill.tokened > 0 || scanResult.dedupBackfill.failed > 0)}
            <!-- TEMPORARY (ADR 0053): reports the ride-along dedup-token backfill; delete with asset-dedup-backfill.ts. -->
            <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="orphan-dedup-backfill">
                Indexed {scanResult.dedupBackfill.tokened} existing {scanResult.dedupBackfill.tokened === 1 ? "asset" : "assets"} for reuse{scanResult.dedupBackfill.failed > 0 ? ` - ${scanResult.dedupBackfill.failed} could not be indexed and will be retried on the next scan` : ""}.
            </p>
        {/if}
        {#if scanResult.orphans.length > 0}
            <ul class="max-h-32 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-800 px-3 py-2 text-sm font-mono text-gray-600 dark:text-gray-400 space-y-1" data-testid="orphan-list">
                {#each scanResult.orphans as orphan (orphan.id)}
                    <li class="truncate">{orphan.label}</li>
                {/each}
            </ul>
            <button
                type="button"
                onclick={runDelete}
                disabled={deleting}
                data-testid="orphan-delete"
                class="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40 {deleteArmed ? 'bg-red-600 text-white hover:bg-red-500' : 'border border-red-300 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40'}"
            >{deleting ? "Deleting…" : deleteArmed ? `Really delete ${scanResult.orphans.length} assets permanently?` : `Delete ${scanResult.orphans.length} orphaned ${scanResult.orphans.length === 1 ? "asset" : "assets"}`}</button>
        {/if}
    {/if}
    {#if deletedCount !== null}
        <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="orphan-deleted">Deleted {deletedCount} {deletedCount === 1 ? "asset" : "assets"}.</p>
    {/if}
    {#if error}<p class="text-sm text-red-600" data-testid="orphan-error">{error}</p>{/if}
</div>
