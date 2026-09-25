<script lang="ts">
    /**
     * Rename a graph from the /graphs picker. Backend-agnostic shell: the caller supplies
     * the help line (a synced rename changes the [[Graph Name]] for all members, ADR 0031;
     * a filesystem rename changes only the local display name) and an async onsave that
     * performs the actual write — the dialog shows busy/error states around it.
     */
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        name,
        help,
        onsave,
        onclose,
    }: {
        name: string;
        help: string;
        onsave: (newName: string) => Promise<void>;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    // Mounted fresh per open; the initial name is the whole story.
    // svelte-ignore state_referenced_locally
    let draft = $state(name);
    let busy = $state(false);
    let error = $state<string | null>(null);

    async function save() {
        const next = draft.trim();
        if (!next) {
            error = "Give the graph a name.";
            return;
        }
        busy = true;
        error = null;
        try {
            await onsave(next);
            open = false;
            onclose();
        } catch (e) {
            error = describeSyncFailure(e, "rename the graph");
        } finally {
            busy = false;
        }
    }

    function close() {
        open = false;
        onclose();
    }
</script>

<Modal {open} title="Rename graph" busy={busy} busyReason="Saving…" onclose={close} onsubmit={save}>
    {#snippet body()}
        <div>
            <label for="rename-graph" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Graph name</label>
            <input
                id="rename-graph"
                data-testid="rename-input"
                bind:value={draft}
                autocomplete="off"
                class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
            />
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{help}</p>
        </div>
        {#if error}<p class="text-sm text-red-600" data-testid="rename-error">{error}</p>{/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
        <button
            type="submit"
            disabled={busy}
            data-testid="rename-save"
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
        >{busy ? "Renaming" : "Rename"}</button>
    {/snippet}
</Modal>
