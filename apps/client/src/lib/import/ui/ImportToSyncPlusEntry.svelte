<script lang="ts">
    /**
     * The Import to Sync+ entry: a header button on a computer, a row in the phone's header menu.
     * Shown while a folder graph is open, on a Client that offers Managed Sync (never on a
     * standalone deployment, which has no Sync+), and not for a graph this browser has already
     * imported. It opens the Graphs page with the Import to Sync+ dialog for the graph, because the
     * page holds the account, its keys and the import run.
     */
    import { goto } from "$app/navigation";
    import * as env from "$app/env/public";
    import { isManagedSyncConfigured } from "#lib/sync/sync-deployment.js";
    import { SYNC_ICON } from "#lib/workspace/graphs-page-icons.js";
    import { openFolderGraph } from "#lib/workspace/open-folder-graph.svelte.js";
    import { SYNC_PLUS_IMPORT_PARAM } from "../import-to-sync-plus";
    import { syncPlusCopied } from "../sync-plus-import-store.svelte";

    let { placement }: { placement: "header" | "menu" } = $props();

    const managed = isManagedSyncConfigured(env);
    const graph = $derived(managed ? openFolderGraph.current : null);
    const shown = $derived(graph !== null && !syncPlusCopied(graph.id));

    function open() {
        if (!graph) return;
        void goto(`/graphs?${SYNC_PLUS_IMPORT_PARAM}=${encodeURIComponent(graph.id)}`);
    }
</script>

{#if shown}
    {#if placement === "header"}
        <button
            type="button"
            onclick={open}
            data-testid="import-to-sync-plus-header"
            data-tooltip="Copy this folder graph into a new synced graph, end-to-end encrypted and on all your devices." aria-description="Copy this folder graph into a new synced graph, end-to-end encrypted and on all your devices."
            class="gk-button hidden lg:inline-flex"
        >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d={SYNC_ICON} />
            </svg>
            Import to Sync+
        </button>
    {:else}
        <button
            type="button"
            onclick={open}
            data-testid="import-to-sync-plus-menu"
            class="gk-button w-full"
        >
            Import to Sync+
        </button>
    {/if}
{/if}
