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
     * Until then a uuid is no name to show a person, so the wait says "this file".
     *
     * What actually draws the file is a registered viewer (surface/asset-viewer.ts) — nothing
     * is framed, for the reasons in ADR 0055. A type with no viewer is not a failure: the tab
     * says so and offers the download, which always works.
     */
    import { AssetIntegrityError, AssetUnavailableError, displayAssetName, isBareAssetId, type ResolvedAsset } from "#lib/storage/fs/asset-store.js";
    import { assetViewerFor, tryGetActiveContributionRegistry } from "#lib/surface/index.js";
    import { viewKey, type ViewRef } from "#lib/layout/index.js";
    import { workspaceService } from "#lib/workspace/workspace-services.js";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import { loadAssetWithRetry } from "./augmentations/asset-load-retry";

    /** `panelId` is supplied by the dockview presenter; the mobile presenter has one View per
     *  key and passes none, so the view key stands in. */
    let { view, panelId }: { view: ViewRef; panelId?: string } = $props();

    /** Shown until the bytes (and with them the real name) arrive. */
    const fallbackName = $derived(displayAssetName(view.target));
    /** The same, when it is something a person can read. */
    const waitingName = $derived(isBareAssetId(view.target) ? null : fallbackName);

    let resolved = $state<ResolvedAsset | null>(null);
    let failed = $state(false);
    /** The bytes could not be fetched just now and are being asked for again (asset-load-retry.ts). */
    let unavailable = $state(false);
    /**
     * The bytes arrived but not as they were stored (`AssetIntegrityError`): cut short, or not
     * matching their encrypted hash. Never retried by itself, since the same answer would come back,
     * but the user can ask again.
     */
    let damaged = $state(false);
    /** Bumped by **Retry** to run the load again for the same asset. */
    let attempt = $state(0);

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
        void attempt;
        resolved = null;
        failed = false;
        unavailable = false;
        damaged = false;
        const store = tryGetActiveAssetStore();
        if (!store) {
            failed = true;
            return;
        }
        // Not being able to fetch the file just now is not the file being gone: that is asked
        // again until it answers. Cancelled when the tab is pointed elsewhere or closed.
        return loadAssetWithRetry(
            () => store.resolve(`../assets/${target}`),
            {
                resolved: (asset) => {
                    unavailable = false;
                    resolved = asset;
                    // The tab was titled from the target at creation. Now the real name is known,
                    // give the tab that - on a synced graph the difference is a uuid versus
                    // "Q3 Report.pdf". A no-op where the name did not change.
                    if (asset.name !== displayAssetName(target)) {
                        workspaceService("retitleView")?.(panelId ?? viewKey(view), asset.name);
                    }
                },
                missing: () => (failed = true),
                unavailable: () => (unavailable = true),
                failed: (error) => {
                    if (error instanceof AssetIntegrityError) damaged = true;
                    else failed = true;
                },
            },
            { retryable: (error) => error instanceof AssetUnavailableError },
        );
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
    {#if damaged}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="text-sm text-neutral-600 dark:text-neutral-400" role="alert" data-testid="asset-view-damaged">
                <span class="font-medium text-neutral-900 dark:text-neutral-100">{fallbackName}</span> could not
                be shown because it arrived incomplete. Nothing was saved from it.
            </p>
            <button
                type="button"
                onclick={() => (attempt += 1)}
                class="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-white/5"
                >Retry</button
            >
        </div>
    {:else if failed}
        <div class="flex flex-1 items-center justify-center p-6 text-center">
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="asset-view-missing">
                <span class="font-medium text-neutral-900 dark:text-neutral-100">{fallbackName}</span> is no longer
                in this graph.
            </p>
        </div>
    {:else if !resolved && unavailable}
        <div class="flex flex-1 items-center justify-center p-6 text-center">
            <p class="text-sm text-neutral-600 dark:text-neutral-400" role="status" data-testid="asset-view-unavailable">
                <span class="font-medium text-neutral-900 dark:text-neutral-100">{waitingName ?? "This file"}</span> could not
                be fetched just now. EtherPK keeps trying, and shows it once the connection is back.
            </p>
        </div>
    {:else if !resolved}
        <!-- At the top, where the reader's own "Opening" line follows it, and clear of a phone's keyboard. -->
        <p class="p-6 text-center text-sm text-neutral-500 dark:text-neutral-400" role="status" data-testid="asset-view-loading">Loading {waitingName ?? "this file"}…</p>
    {:else if Viewer}
        <Viewer url={resolved.url} name={resolved.name} type={resolved.type} target={view.target} />
    {:else}
        <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="asset-view-unsupported">
                <span class="font-medium text-neutral-900 dark:text-neutral-100">{name}</span> cannot be shown here.
            </p>
            <button
                type="button"
                onclick={download}
                class="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-white/5"
                >Download it instead</button
            >
        </div>
    {/if}
</div>
