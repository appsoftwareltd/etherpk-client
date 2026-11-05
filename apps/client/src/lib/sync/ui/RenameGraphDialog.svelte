<script lang="ts">
    /**
     * Rename a graph from the /graphs picker. Backend-agnostic shell: the caller supplies
     * the help line (a synced rename changes the [[Graph Name]] for all members, ADR 0031;
     * a filesystem rename changes only the local display name) and an async onsave that
     * performs the actual write — the dialog shows busy/error states around it.
     */
    import { describeSyncFailure } from "#lib/sync/sync-error-copy.js";
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
            <label for="rename-graph" class="mb-1.5 block text-sm font-medium text-neutral-500 dark:text-neutral-400">Graph name</label>
            <input
                id="rename-graph"
                data-testid="rename-input"
                bind:value={draft}
                autocomplete="off"
                class="block w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-neutral-950 dark:text-neutral-100 focus:border-neutral-950 dark:focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-950 dark:focus:ring-neutral-400"
            />
            <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{help}</p>
        </div>
        {#if error}<p class="text-sm text-red-600" data-testid="rename-error">{error}</p>{/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300">Cancel</button>
        <button
            type="submit"
            disabled={busy}
            data-testid="rename-save"
            class="rounded-lg bg-neutral-900 dark:bg-neutral-100 px-4 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-40"
        >{busy ? "Renaming" : "Rename"}</button>
    {/snippet}
</Modal>
