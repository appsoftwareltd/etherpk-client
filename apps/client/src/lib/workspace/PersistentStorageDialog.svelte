<script lang="ts">
    /**
     * EtherPK's reason, shown before Firefox's own persistent-storage prompt (see
     * `persistenceStep` in `storage-persistence.ts`).
     *
     * Firefox answers `navigator.storage.persist()` with a prompt hung off the address bar that
     * says only "Allow app.etherpk.com to store data in persistent storage?". Arriving as a graph
     * opens, with no reason given, it is easy to block or to leave. This dialog comes first and
     * says what the storage holds; its Continue button makes the request, so the prompt follows
     * the reason. Shown once per browser: Not now is remembered, and the Graphs page's "This
     * browser" section can ask again.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { ensurePersistentStorage, markPersistenceExplained } from "#lib/storage/storage-persistence.js";

    let { open, onclose }: { open: boolean; onclose: () => void } = $props();

    function notNow() {
        markPersistenceExplained();
        onclose();
    }

    function proceed() {
        markPersistenceExplained();
        // Called inside the click, so the browser treats the request as the person's own. The
        // outcome is Firefox's prompt; nothing here waits on it.
        void ensurePersistentStorage();
        onclose();
    }
</script>

<Modal {open} title="Keep EtherPK's data on this device" testId="persistent-storage-dialog" onclose={notNow} onsubmit={proceed}>
    {#snippet body()}
        <div class="space-y-3 text-sm text-neutral-700 dark:text-neutral-300">
            <p>
                Firefox will ask next whether EtherPK may store data in persistent storage.
                Choose <strong class="font-semibold text-neutral-950 dark:text-white">Allow</strong>.
            </p>
            <p>
                Without it, Firefox may clear EtherPK's data in this browser when the disk runs
                low: the offline copy of your synced graphs, edits not yet synced, the list of
                graphs you opened here and their search indexes. A folder graph's own files are
                never cleared.
            </p>
        </div>
    {/snippet}
    {#snippet footer()}
        <button
            type="button"
            data-testid="persistent-storage-not-now"
            onclick={notNow}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            >Not now</button
        >
        <button
            type="submit"
            data-testid="persistent-storage-continue"
            data-autofocus
            class="min-w-28 rounded-lg bg-neutral-900 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >Continue</button
        >
    {/snippet}
</Modal>
