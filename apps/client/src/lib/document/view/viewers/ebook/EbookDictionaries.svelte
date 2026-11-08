<script lang="ts">
    /**
     * The dictionaries on this device: adding one, and removing one. They are StarDict packs a person
     * brings, read here and sent nowhere, so a word looked up leaves no trace outside this browser.
     */
    import type { EbookDictionaries, HeldDictionary } from "#lib/document/ebook/ebook-dictionaries.js";

    let { dictionaries, onchange, onclose }: { dictionaries: EbookDictionaries; onchange: () => void; onclose: () => void } = $props();

    let held = $state.raw<HeldDictionary[]>([]);
    let adding = $state(false);
    let problem = $state("");
    let input = $state<HTMLInputElement>();

    async function refresh() {
        held = await dictionaries.list();
        onchange();
    }

    $effect(() => void refresh());

    async function onPick(event: Event) {
        const element = event.currentTarget as HTMLInputElement;
        const files = [...(element.files ?? [])];
        if (files.length === 0) return;
        adding = true;
        problem = "";
        try {
            await dictionaries.add(await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))));
            await refresh();
        } catch (error) {
            problem = error instanceof Error ? error.message : String(error);
        } finally {
            adding = false;
            element.value = "";
        }
    }

    async function remove(id: string) {
        await dictionaries.remove(id);
        await refresh();
    }
</script>

<div class="flex shrink-0 flex-col gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) p-2" role="group" aria-label="Dictionaries" data-testid="ebook-dictionaries">
    <p class="text-sm text-(--gk-text-default)">Dictionaries you add stay on this device, and looking up a word sends it nowhere. Use a StarDict pack: an .ifo, an .idx and a .dict.dz file chosen together, or a .zip of them.</p>
    {#if held.length > 0}
        <ul class="flex flex-col gap-1">
            {#each held as dictionary (dictionary.id)}
                <li class="flex items-center gap-2 text-sm text-(--gk-text-default)" data-testid="ebook-dictionary-row">
                    <span class="min-w-0 flex-1 truncate">{dictionary.name}</span>
                    <button type="button" class="rounded-lg border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700" onclick={() => remove(dictionary.id)} data-testid="ebook-dictionary-remove">Remove</button>
                </li>
            {/each}
        </ul>
    {/if}
    {#if problem}<p class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="ebook-dictionary-problem">{problem}</p>{/if}
    <div class="flex flex-wrap items-center gap-2">
        <input bind:this={input} class="sr-only" type="file" multiple accept=".ifo,.idx,.dz,.syn,.zip" tabindex="-1" aria-hidden="true" onchange={onPick} data-testid="ebook-dictionary-file" />
        <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1 text-sm font-medium text-(--gk-surface-0) disabled:opacity-60" disabled={adding} onclick={() => input?.click()} data-testid="ebook-dictionary-add">{adding ? "Adding…" : "Add a dictionary"}</button>
        <button type="button" class="rounded-lg border border-neutral-300 px-3 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700" onclick={onclose} data-testid="ebook-dictionaries-close">Close</button>
    </div>
</div>
