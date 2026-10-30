<script lang="ts">
    /**
     * Something an extension draws over the whole EtherPK window (`context.layout.openWindow`,
     * ADR 0147), in the shared window shell (`FullWindow.svelte`) a fence's widget also opens in:
     * a heading and a close button the Client draws, and the extension's content filling the rest.
     * An Agent Chat on a phone is drawn here. The close button and Escape close it, and the
     * keyboard goes back to where it was when the window opened.
     */
    import type { Attachment } from "svelte/attachments";

    import FullWindow from "$lib/components/FullWindow.svelte";

    const {
        title,
        mount,
        onclose,
    }: {
        title: string;
        mount: (host: HTMLElement, window: { close(): void }) => { destroy(): void };
        onclose: () => void;
    } = $props();

    /** Draws the extension's content into its host, handing it the window's own close. */
    const drawn =
        (close: () => void): Attachment<HTMLElement> =>
        (element) => {
            let content: { destroy(): void } | null = null;
            try {
                content = mount(element, { close });
            } catch (error) {
                console.error("[extension-window] the content could not be drawn", error);
            }
            return () => content?.destroy();
        };
</script>

<FullWindow {title} testId="extension-window" {onclose} closeOnEscape>
    {#snippet children(close)}
        <div class="relative h-full" {@attach drawn(close)}></div>
    {/snippet}
</FullWindow>
