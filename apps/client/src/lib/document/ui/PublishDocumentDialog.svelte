<script lang="ts">
    /**
     * The dialog behind **Publish…** on a document (ADR 0082): the consent switch and the
     * publications the document belongs to, written into its frontmatter as `public: true` and
     * `publications: [...]`. It reads the graph's publications when it opens, because they are
     * pages, not a settings list.
     *
     * States it has to show: a protected document (never published; nothing to tick), a graph
     * with no publication yet (the switch alone does nothing, and the dialog says so), a
     * publication that takes every public document (ticked and locked), and a public document
     * in no publication.
     */
    import { onMount } from "svelte";

    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import type { Publication } from "../publish/types";

    let {
        concept,
        isProtected,
        current,
        loadPublications,
        onsave,
        onclose,
        onopensettings,
    }: {
        concept: string;
        /** The document holds a cipher fence: never published, whatever the switch says. */
        isProtected: boolean;
        current: { isPublic: boolean; publications: string[] };
        loadPublications: () => Promise<Publication[]>;
        onsave: (next: { isPublic: boolean; publications: string[] }) => Promise<void>;
        onclose: () => void;
        /** Open the Publish tab of the Settings modal, to create a publication. */
        onopensettings: () => void;
    } = $props();

    let publications = $state<Publication[] | null>(null);
    let loadError = $state<string | null>(null);
    // svelte-ignore state_referenced_locally
    let isPublic = $state(current.isPublic);
    // svelte-ignore state_referenced_locally
    let chosen = $state<string[]>([...current.publications]);
    let saving = $state(false);
    let saveError = $state<string | null>(null);

    onMount(() => {
        void loadPublications().then(
            (list) => (publications = list),
            (error) => (loadError = error instanceof Error ? error.message : String(error)),
        );
    });

    const named = $derived(publications?.filter((p) => p.selection === "named") ?? []);
    const allPublic = $derived(publications?.filter((p) => p.selection === "all-public") ?? []);
    const unknown = $derived(chosen.filter((id) => !publications?.some((p) => p.id === id)));
    const inNone = $derived(isPublic && publications !== null && allPublic.length === 0 && !chosen.some((id) => named.some((p) => p.id === id)));
    const changed = $derived(isPublic !== current.isPublic || chosen.slice().sort().join() !== current.publications.slice().sort().join());

    function toggle(id: string, on: boolean): void {
        chosen = on ? [...new Set([...chosen, id])] : chosen.filter((c) => c !== id);
        if (on) isPublic = true;
    }

    async function save(): Promise<void> {
        if (saving) return;
        saving = true;
        saveError = null;
        try {
            await onsave({ isPublic, publications: chosen });
            onclose();
        } catch (error) {
            saveError = error instanceof Error ? error.message : String(error);
        } finally {
            saving = false;
        }
    }
</script>

<Dialog open={true} title="Publish" testId="publish-document-dialog" busy={saving} busyReason="Saving…" onclose={onclose} onsubmit={() => void save()}>
    {#snippet body()}
        <p class="text-sm text-gray-600 dark:text-gray-400">
            <span class="font-medium text-gray-900 dark:text-gray-100">{concept}</span>
        </p>
        {#if isProtected}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="publish-document-protected">
                This is a protected document. It is never published, whatever its frontmatter says, and there is nothing to set here.
            </p>
        {:else}
            <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                <input type="checkbox" class="mt-0.5" bind:checked={isPublic} data-testid="publish-document-public" />
                <span>
                    <span class="font-medium">Public</span><br />
                    <span class="text-gray-600 dark:text-gray-400">Required before any publication can include it. Unticking it withdraws the document from every site at once.</span>
                </span>
            </label>

            {#if publications === null && !loadError}
                <p role="status" class="text-sm text-gray-500 dark:text-gray-400">Reading the graph's publications…</p>
            {:else if loadError}
                <p role="alert" class="text-sm text-red-700 dark:text-red-300">The publications could not be read: {loadError}</p>
            {:else if publications && publications.length === 0}
                <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="publish-document-none">
                    This graph has no publication yet, so a public document goes nowhere until one exists.
                    <button type="button" class="font-medium text-[var(--gk-accent,#007ACC)] underline underline-offset-2" onclick={onopensettings}>Create one in Settings → Publish</button>.
                </p>
            {:else if publications}
                <fieldset class="space-y-2" data-testid="publish-document-publications">
                    <legend class="text-sm font-medium text-gray-500 dark:text-gray-400">Publications</legend>
                    {#each named as p (p.id)}
                        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                            <input type="checkbox" class="mt-0.5" checked={chosen.includes(p.id)} onchange={(e) => toggle(p.id, (e.currentTarget as HTMLInputElement).checked)} data-testid="publish-document-in-{p.id}" />
                            <span><span class="font-medium">{p.name}</span> <span class="text-gray-500 dark:text-gray-400"><code>{p.id}</code></span></span>
                        </label>
                    {/each}
                    {#each allPublic as p (p.id)}
                        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                            <input type="checkbox" class="mt-0.5" checked={isPublic} disabled data-testid="publish-document-in-{p.id}" />
                            <span><span class="font-medium">{p.name}</span> <span class="text-gray-500 dark:text-gray-400">includes every public document</span></span>
                        </label>
                    {/each}
                    {#each unknown as id (id)}
                        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                            <input type="checkbox" class="mt-0.5" checked onchange={(e) => toggle(id, (e.currentTarget as HTMLInputElement).checked)} />
                            <span><code>{id}</code> <span class="text-amber-800 dark:text-amber-200">no publication has this id</span></span>
                        </label>
                    {/each}
                </fieldset>
                {#if inNone}
                    <p class="text-sm text-amber-800 dark:text-amber-200" data-testid="publish-document-in-none">Public, but in no publication: it will not appear on any site until one is ticked here, or named in the empty <code>publications:</code> list this leaves in the frontmatter.</p>
                {/if}
            {/if}
            {#if saveError}<p role="alert" class="text-sm text-red-700 dark:text-red-300">{saveError}</p>{/if}
        {/if}
    {/snippet}

    {#snippet footer()}
        <button type="button" class="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10" onclick={onclose}>{isProtected ? "Close" : "Cancel"}</button>
        {#if !isProtected}
            <button type="button" class="rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50" disabled={!changed || saving} onclick={() => void save()} data-testid="publish-document-save">{saving ? "Saving…" : "Save"}</button>
        {/if}
    {/snippet}
</Dialog>
