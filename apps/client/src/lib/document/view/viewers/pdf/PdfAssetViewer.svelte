<script lang="ts">
    /**
     * The first-party PDF viewer. A tab pointed at another file starts a reader of its own, because
     * a reader is tied to one file's bytes, state and password.
     */
    import type { AssetViewerProps } from "#lib/surface/index.js";

    import PdfReaderView from "./PdfReaderView.svelte";

    let { url, name, target }: AssetViewerProps = $props();
</script>

{#key url}
    <PdfReaderView {url} {name} target={target ?? name} />
{/key}
