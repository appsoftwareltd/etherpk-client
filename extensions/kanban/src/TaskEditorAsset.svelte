<script lang="ts">
    /**
     * One row of the [[Task Editor]]'s Assets list (ADR 0170): a square picture of an image asset, or a
     * file icon for any other, with the asset's name beside it. The picture is read through the graph's
     * assets (`task-editor-assets.ts`), as the document's editor reads the images it draws, so an
     * image in a synced graph shows decrypted. Until it is read the square stays empty, the size it
     * will be, so nothing moves when it lands; an image that cannot be read shows the file icon.
     *
     * An image's picture and name are one button, "View <name>", that opens it larger in the Client's
     * Lightbox (`onview`). Any other file is not a button: there is nothing to show it in.
     */
    import { iconSvg } from "#lib/surface/icons.js";

    import { type AssetShown, taskAssetImage } from "./task-editor-assets";

    const { asset, onview }: { asset: AssetShown; onview?: () => void } = $props();

    /** The picture's address, or null when there is none to show: read again only for another asset. */
    const picture = $derived(asset.image ? taskAssetImage(asset.ref) : Promise.resolve(null));
    /** The picture failed to draw: the file icon shows instead. */
    let broken = $state(false);
</script>

{#snippet pictureAndName()}
    <span class="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-(--gk-border-soft) bg-(--gk-surface-2) text-(--gk-text-muted)">
        {#await picture then url}
            {#if url && !broken}
                <img src={url} alt={asset.name} loading="lazy" decoding="async" class="size-full object-cover" onerror={() => (broken = true)} data-testid="task-editor-asset-thumbnail" />
            {:else}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
                <span class="grid size-5 place-items-center" aria-hidden="true" data-testid="task-editor-asset-icon">{@html iconSvg(asset.image ? "image" : "page")}</span>
            {/if}
        {/await}
    </span>
    <span class="min-w-0 truncate text-sm text-(--gk-text-default)" data-testid="task-editor-asset-name">{asset.name}</span>
{/snippet}

<li class="flex min-w-0" title={asset.fileName} data-testid="task-editor-asset" data-image={asset.image || undefined}>
    {#if asset.image && onview}
        <!-- The whole row is the target, with the focus ring round it rather than the small square. -->
        <button
            type="button"
            class="-m-1 flex min-w-0 flex-1 cursor-zoom-in items-center gap-3 rounded-lg p-1 text-left hover:bg-(--gk-control-hover) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--gk-accent)"
            aria-label="View {asset.name}"
            onclick={onview}
            data-testid="task-editor-asset-view"
        >
            {@render pictureAndName()}
        </button>
    {:else}
        <span class="flex min-w-0 flex-1 items-center gap-3">{@render pictureAndName()}</span>
    {/if}
</li>
