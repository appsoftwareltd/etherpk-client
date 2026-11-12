<script lang="ts">
    /**
     * A file in a [[Quick Note]], as the Quick Notes View shows it (ADR 0186): a picture as a
     * thumbnail, any other file as its name, which downloads it. The bytes come from the open
     * graph's [[Asset]] store, which on a synced graph may still be on their way up or down, so
     * the row keeps its height while it waits and says so when the file is not here yet.
     */
    import { displayNameForRef } from "#lib/storage/fs/asset-store.js";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import { parseImageDisplaySizeHint } from "./augmentations/image-display-size";

    let { url, kind, alt = "" }: { url: string; kind: "image" | "file"; alt?: string } = $props();

    const name = $derived(displayNameForRef(url));
    const resolved = $derived(tryGetActiveAssetStore()?.resolve(url) ?? Promise.resolve(null));
    /** The label without its display-size hint: what a screen reader should hear. */
    const spoken = $derived(parseImageDisplaySizeHint(alt).cleanAlt);
</script>

{#await resolved}
    <p class={["text-sm text-(--gk-text-muted)", kind === "image" && "flex h-24 items-center"]} data-testid="quick-notes-asset" data-state="loading">
        {name}
    </p>
{:then asset}
    {#if !asset}
        <p class="text-sm text-(--gk-text-muted)" data-testid="quick-notes-asset" data-state="missing">{name} (not on this device)</p>
    {:else if kind === "image"}
        <img
            src={asset.url}
            alt={spoken || name}
            class="max-h-40 max-w-full rounded-md border border-(--gk-border-soft) object-contain"
            data-testid="quick-notes-asset"
            data-state="shown"
        />
    {:else}
        <a
            href={asset.url}
            download={asset.name}
            class="inline-flex max-w-full items-center gap-1.5 rounded-md text-sm text-(--gk-accent) underline-offset-2 hover:underline pointer-coarse:min-h-11"
            data-testid="quick-notes-asset"
            data-state="shown"
        >
            <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
            <span class="truncate">{asset.name}</span>
        </a>
    {/if}
{:catch}
    <p class="text-sm text-(--gk-text-muted)" data-testid="quick-notes-asset" data-state="waiting">{name} (not loaded yet)</p>
{/await}
