<script lang="ts">
    /**
     * The first-party audio and video viewer: a recording in its own tab, in the same player a
     * document draws under a media line (`media/media-player.ts`). The Asset View has read the
     * file by the time it mounts this, so the player starts ready and nothing is read on play.
     */
    import { mediaKindOfExtension } from "#lib/document/media-line.js";
    import { assetExtension, type AssetViewerProps } from "#lib/surface/index.js";

    import { createMediaPlayer } from "../media/media-player";

    let { url, name, type }: AssetViewerProps = $props();

    // Registered for audio and video extensions only, so the name always says which.
    const kind = $derived(mediaKindOfExtension(assetExtension(name)) ?? "video");

    /** Mount the player, and build it again when the tab is given another file. */
    function player(host: HTMLElement) {
        const made = createMediaPlayer({ kind, name, source: { url, type } });
        host.appendChild(made.element);
        return () => {
            made.destroy();
            made.element.remove();
        };
    }
</script>

<div class="flex flex-1 items-start justify-center overflow-auto p-4" data-testid="media-asset-viewer" data-media-kind={kind} {@attach player}></div>
