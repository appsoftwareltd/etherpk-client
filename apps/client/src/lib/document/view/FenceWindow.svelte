<script lang="ts">
    /**
     * A fence's widget filling the EtherPK window, in the shared window shell (`FullWindow.svelte`).
     * Esc stays with the widget (a drawing leaves a tool with it), so the way back is the close
     * button, which has the keyboard as the window opens and gives it back to where it was.
     */
    import { getAppliedResolvedTheme, THEME_CHANGE_EVENT } from "@appsoftwareltd/etherpk-shared/theme";
    import type { Attachment } from "svelte/attachments";

    import FullWindow from "$lib/components/FullWindow.svelte";
    import type { DocumentStore } from "../types";
    import type { InteractiveFence } from "./augmentations/interactive-fence-contract";
    import { type DetachedFenceGone, mountDetachedFence } from "./detached-fence";
    import type { FenceRef } from "./fence-hosting";

    const {
        fenceRef,
        fence,
        store,
        onclose,
        onopentab,
    }: {
        fenceRef: FenceRef;
        fence: InteractiveFence;
        store: DocumentStore;
        onclose: () => void;
        onopentab: () => void;
    } = $props();

    /** Why the widget is not drawn, once it is not: its fence went, or its document is protected. */
    let gone = $state<DetachedFenceGone | null>(null);
    // Named as its tab is: the extension's title for the fence, or its info word.
    const heading = $derived(`${fence.title ?? fenceRef.info}: ${fenceRef.document}`);

    /** Draws the widget into its host; `close` is the window's own, which gives the keyboard back. */
    const drawn = (close: () => void): Attachment<HTMLElement> => (element) => {
        let mounted: ReturnType<typeof mountDetachedFence> = null;
        let stopped = false;
        // Kept loaded while the window is open, as a document's own tab keeps it.
        const release = (store as { retainDocument?: (target: string) => () => void }).retainDocument?.(fenceRef.document);
        void (async () => {
            await store.whenReady?.(fenceRef.document).catch(() => {});
            if (stopped) return;
            try {
                mounted = mountDetachedFence({
                    doc: store.open(fenceRef.document),
                    ref: fenceRef,
                    fence,
                    presentation: "window",
                    host: element,
                    dark: () => getAppliedResolvedTheme() === "dark",
                    onScreen: () => true,
                    onGone: (reason) => (gone = reason),
                    closeWindow: close,
                    openInTab: () => {
                        onopentab();
                        close();
                    },
                });
            } catch (error) {
                console.error("[fence-window] the widget could not be drawn", error);
            }
            if (!mounted) gone ??= "gone";
        })();
        const onTheme = () => mounted?.refresh();
        window.addEventListener(THEME_CHANGE_EVENT, onTheme);
        return () => {
            stopped = true;
            window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
            mounted?.destroy();
            release?.();
        };
    };
</script>

<FullWindow title={heading} testId="fence-window" {onclose} focusClose>
    {#snippet children(close)}
        {#if gone === "protected"}
            <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status" data-testid="fence-window-protected">
                <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">
                    {fenceRef.document} is a protected document. Extensions don't draw anything in a protected document, so this can't be shown here.
                </p>
            </div>
        {:else if gone}
            <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status" data-testid="fence-window-gone">
                <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">This is no longer in {fenceRef.document}. It may have been deleted meanwhile.</p>
            </div>
        {:else}
            <div class="h-full" {@attach drawn(close)}></div>
        {/if}
    {/snippet}
</FullWindow>
