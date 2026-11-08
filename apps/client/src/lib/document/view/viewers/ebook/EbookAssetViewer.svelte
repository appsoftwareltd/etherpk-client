<script lang="ts">
    /**
     * The first-party EBook viewer. A tab pointed at another file starts a reader of its own, because a
     * reader is tied to one file's bytes and state.
     */
    import type { AssetViewerProps } from "#lib/surface/index.js";

    import EbookReaderView from "./EbookReaderView.svelte";

    let { url, name, target }: AssetViewerProps = $props();
    /** Bumped by **Try again**, which starts the reader afresh. */
    let attempt = $state(0);
</script>

{#key `${url} ${attempt}`}
    <EbookReaderView {url} {name} target={target ?? name} onretry={() => (attempt += 1)} />
{/key}
