<script lang="ts">
    /**
     * The first-party image viewer: an [[Asset]] at its natural size, in its own tab.
     *
     * Worth having on its own merits, not just for symmetry with the PDF viewer. [[Display
     * Size]] is a *maximum* on how large an image renders inside a document, so until now there
     * was no way to see a large image at full size anywhere in the app.
     *
     * Scrolls in both directions rather than shrinking to fit: the point of opening it here is
     * to see the pixels.
     */
    import type { AssetViewerProps } from "$lib/surface";

    let { url, name }: AssetViewerProps = $props();
</script>

<div class="flex-1 overflow-auto p-4" data-testid="image-asset-viewer">
    <img src={url} alt={name} class="mx-auto block" />
</div>
