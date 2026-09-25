<script lang="ts">
    /**
     * The `asset` [[View]]: an [[Asset]] shown in its own tab rather than inside a document.
     *
     * The ViewRef's target is the Asset's **identity** — the file name on a [[Filesystem
     * Backend]], the random asset id on a [[Server Backend]] — never the reference that opened
     * it, so one Asset is one tab however its references happen to be labelled (ADR 0054's
     * identity rule). The tab therefore opens titled from the target with its id segment
     * stripped - the file name on a filesystem graph, a bare uuid on a synced one - and
     * retitles itself to the true decrypted name once the bytes arrive, which is the only
     * moment that name is known. The retitle goes through the workspace's `retitleView`
     * service rather than the renderer, which a presenter swap replaces under this View.
     *
     * What actually draws the file is a registered viewer (surface/asset-viewer.ts) — nothing
     * is framed, for the reasons in ADR 0055. A type with no viewer is not a failure: the tab
     * says so and offers the download, which always works.
     */
    import { displayAssetName, type ResolvedAsset } from "$lib/storage/fs/asset-store";
    import { assetViewerFor, tryGetActiveContributionRegistry } from "$lib/surface";
    import { viewKey, type ViewRef } from "$lib/layout";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { tryGetActiveAssetStore } from "../active-asset-store";

    /** `panelId` is supplied by the dockview presenter; the mobile presenter has no tabs to
     *  retitle and passes none, so the view key stands in and the retitle is a no-op there. */
    let { view, panelId }: { view: ViewRef; panelId?: string } = $props();

    /** Shown until the bytes (and with them the real name) arrive. */
    const fallbackName = $derived(displayAssetName(view.target));

    let resolved = $state<ResolvedAsset | null>(null);
    let failed = $state(false);

    const name = $derived(resolved?.name ?? fallbackName);
    const viewer = $derived.by(() => {
        const contributions = tryGetActiveContributionRegistry();
        return contributions ? assetViewerFor(contributions, name) : undefined;
    });
    const Viewer = $derived(viewer?.component);

    // Fetching the bytes is a genuine external effect: on a synced graph it is a network round
    // trip plus a decrypt, and it has to re-run when the tab is pointed at a different asset.
    $effect(() => {
        const target = view.target;
        let live = true;
        resolved = null;
        failed = false;
        const store = tryGetActiveAssetStore();
        if (!store) {
            failed = true;
            return;
        }
        void store
            .resolve(`../assets/${target}`)
            .then((asset) => {
                if (!live) return;
                resolved = asset;
                failed = asset === null;
                // The tab was titled from the target at creation. Now the real name is known,
                // give the tab that - on a synced graph the difference is a uuid versus
                // "Q3 Report.pdf". A no-op where the name did not change.
                if (asset && asset.name !== displayAssetName(target)) {
                    workspaceService("retitleView")?.(panelId ?? viewKey(view), asset.name);
                }
            })
            .catch(() => {
                if (live) failed = true;
            });
        return () => {
            live = false;
        };
    });

    function download() {
        if (!resolved) return;
        const a = document.createElement("a");
        a.href = resolved.url;
        a.download = resolved.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
</script>

<div class="flex h-full w-full flex-col bg-[var(--gk-surface-0,transparent)]" data-testid="asset-view">
    {#if failed}
        <div class="flex flex-1 items-center justify-center p-6 text-center">
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="asset-view-missing">
                <span class="font-medium text-gray-900 dark:text-gray-100">{fallbackName}</span> is no longer
                in this graph.
            </p>
        </div>
    {:else if !resolved}
        <div class="flex flex-1 items-center justify-center p-6">
            <p class="text-sm text-gray-500 dark:text-gray-400" role="status">Loading {fallbackName}…</p>
        </div>
    {:else if Viewer}
        <Viewer url={resolved.url} name={resolved.name} type={resolved.type} />
    {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="asset-view-unsupported">
                <span class="font-medium text-gray-900 dark:text-gray-100">{name}</span> cannot be shown here.
            </p>
            <button
                type="button"
                onclick={download}
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >Download it instead</button
            >
        </div>
    {/if}
</div>
