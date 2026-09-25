<script lang="ts">
    /**
     * Ask where this graph's folder is on this device, the one thing the browser cannot tell
     * us (folder-path.ts). Raised by "Copy full file path" the first time it is used on a
     * device, and the path is remembered so it is asked once; Graph Settings → General shows
     * the same field for correcting it.
     *
     * The folder's leaf name IS known (the picked handle's name), so the dialog says it, and
     * flags a typed path whose last segment is something else. A flag, not a refusal: the
     * handle's name is the name at pick time, and a folder renamed on disk since would make a
     * correct path look wrong.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        folderName,
        initial = "",
        onsave,
        onclose,
    }: {
        /** The graph folder's leaf name, from its directory handle. */
        folderName: string;
        /** A remembered path to correct, if any. */
        initial?: string;
        /** Called with the trimmed path; the caller remembers it and carries on. */
        onsave: (path: string) => void;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    // Mounted fresh per open; the initial value is the whole story.
    // svelte-ignore state_referenced_locally
    let draft = $state(initial);
    let error = $state<string | null>(null);

    /** The last segment of the typed path, for the mismatch hint. Trailing separators ignored. */
    const typedLeaf = $derived(
        draft
            .trim()
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() ?? "",
    );
    const leafDiffers = $derived(
        typedLeaf !== "" && typedLeaf !== folderName,
    );

    function save() {
        const path = draft.trim();
        if (path === "") {
            error = "Enter the folder's full path.";
            return;
        }
        open = false;
        onsave(path);
    }

    function close() {
        open = false;
        onclose();
    }
</script>

<Modal {open} title="Where is this graph's folder?" onclose={close} onsubmit={save}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">
            Browser restrictions mean that the graph's location on your file system is not
            known. Enter the full path of the
            <strong class="font-medium text-gray-900 dark:text-gray-100">{folderName}</strong>
            folder; it is remembered on this device.
        </p>
        <div>
            <label
                for="graph-folder-path"
                class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                >Folder path</label
            >
            <input
                id="graph-folder-path"
                data-testid="folder-path-input"
                bind:value={draft}
                oninput={() => (error = null)}
                autocomplete="off"
                spellcheck="false"
                placeholder={`e.g. /home/you/notes/${folderName}`}
                aria-describedby="graph-folder-path-help"
                aria-invalid={error !== null}
                class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 font-mono text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
            />
            <p id="graph-folder-path-help" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {#if leafDiffers}
                    <span data-testid="folder-path-mismatch" class="text-amber-700 dark:text-amber-400">
                        This ends in <code>{typedLeaf}</code>, but the folder is called <code>{folderName}</code>.
                        Fine if you have renamed it; otherwise check the path.
                    </span>
                {:else}
                    Change it later under Settings → General.
                {/if}
            </p>
        </div>
        {#if error}<p class="text-sm text-red-600" data-testid="folder-path-error">{error}</p>{/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
        <button
            type="submit"
            data-testid="folder-path-save"
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
        >Remember and copy</button>
    {/snippet}
</Modal>
