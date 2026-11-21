<script lang="ts">
    /**
     * Transfer of Ownership (ADR 0029): hand a graph you own to one of its active Players.
     * Keyless — the new owner already holds the Graph Key, so it works even for a locked-out
     * owner. Shared by the Synced-graphs panel and the Account Reset flow.
     */
    import type { SyncApi } from "#lib/sync/index.js";
    import { describeSyncFailure } from "#lib/sync/sync-error-copy.js";
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
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="transfer-no-candidates">
                There is nobody to hand
                {#if graphName}<span class="font-medium text-neutral-900 dark:text-neutral-200">{graphName}</span>{:else}this graph{/if}
                to. Ownership can only move to an active player, so invite someone and wait for them
                to accept first.
            </p>
        {:else}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Hand {#if graphName}<span class="font-medium text-neutral-900 dark:text-neutral-200">{graphName}</span>{:else}this graph{/if}
                to one of its players. They become the Owner and you stay on as a Player — nothing is
                re-encrypted, and they can hand it back later.
            </p>
            <div>
                <label for="transfer-target" class="gk-label mb-1.5 block">New owner</label>
                <select
                    id="transfer-target"
                    data-testid="transfer-target"
                    bind:value={selected}
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error ? errorId : undefined}
                    class="gk-select w-full"
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
        <button type="button" onclick={() => close()} class="gk-button">
            {candidates.length === 0 ? "Close" : "Cancel"}
        </button>
        {#if candidates.length > 0}
            <button
                type="submit"
                disabled={busy || !selected}
                data-testid="transfer-confirm"
                class="gk-button gk-button--primary min-w-44"
            >{busy ? "Transferring…" : "Transfer ownership"}</button>
        {/if}
    {/snippet}
</Modal>
