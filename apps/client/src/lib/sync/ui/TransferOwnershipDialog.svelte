<script lang="ts">
    /**
     * Transfer of Ownership (ADR 0029): hand a graph you own to one of its active Players.
     * Keyless — the new owner already holds the Graph Key, so it works even for a locked-out
     * owner. Shared by the Synced-graphs panel and the Account Reset flow.
     */
    import type { SyncApi } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    interface Member {
        userId: string;
        email: string;
        role: string;
    }

    let {
        api,
        graphId,
        graphName,
        candidates,
        onclose,
    }: {
        api: SyncApi;
        graphId: string;
        /** Display name if the caller knows one — the server never does (ADR 0024). */
        graphName?: string;
        /** Eligible new owners: the graph's active Players (never the caller). */
        candidates: Member[];
        onclose: (result?: { newOwnerUserId: string; email: string }) => void;
    } = $props();

    let open = $state(true);
    // The dialog is mounted fresh per open, so the initial candidate list is the whole story.
    // svelte-ignore state_referenced_locally
    let selected = $state(candidates[0]?.userId ?? "");
    let busy = $state(false);
    let error = $state<string | null>(null);
    const errorId = $props.id();

    async function transfer() {
        if (busy) return;
        const target = candidates.find((m) => m.userId === selected);
        if (!target) return;
        busy = true;
        error = null;
        try {
            await api.transferOwnership(graphId, target.userId);
            close({ newOwnerUserId: target.userId, email: target.email });
        } catch (e) {
            error = describeSyncFailure(e, "transfer ownership");
        } finally {
            busy = false;
        }
    }

    function close(result?: { newOwnerUserId: string; email: string }) {
        open = false;
        onclose(result);
    }
</script>

<Modal {open} title="Transfer ownership" busy={busy} busyReason="Transferring…" onclose={() => close()} onsubmit={transfer}>
    {#snippet body()}
        {#if candidates.length === 0}
            <!--
                A graph whose only member is its owner reaches this dialog from the graphs list.
                It used to render an empty picker under a "New owner" label with a dead button
                and no explanation of what was missing.
            -->
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="transfer-no-candidates">
                There is nobody to hand
                {#if graphName}<span class="font-medium text-gray-900 dark:text-gray-200">{graphName}</span>{:else}this graph{/if}
                to. Ownership can only move to an active player, so invite someone and wait for them
                to accept first.
            </p>
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Hand {#if graphName}<span class="font-medium text-gray-900 dark:text-gray-200">{graphName}</span>{:else}this graph{/if}
                to one of its players. They become the Owner and you stay on as a Player — nothing is
                re-encrypted, and they can hand it back later.
            </p>
            <div>
                <label for="transfer-target" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">New owner</label>
                <select
                    id="transfer-target"
                    data-testid="transfer-target"
                    bind:value={selected}
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error ? errorId : undefined}
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                >
                    {#each candidates as m (m.userId)}
                        <option value={m.userId}>{m.email}</option>
                    {/each}
                </select>
                {#if error}
                    <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="transfer-error">{error}</p>
                {/if}
            </div>
        {/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={() => close()} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">
            {candidates.length === 0 ? "Close" : "Cancel"}
        </button>
        {#if candidates.length > 0}
            <button
                type="submit"
                disabled={busy || !selected}
                data-testid="transfer-confirm"
                class="min-w-44 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >{busy ? "Transferring…" : "Transfer ownership"}</button>
        {/if}
    {/snippet}
</Modal>
