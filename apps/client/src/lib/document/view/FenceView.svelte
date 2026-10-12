<script lang="ts">
    /**
     * A fence's widget in a tab of its own (the `fence` View kind), as a drawing opens bigger beside
     * its document. The target names the fence by its
     * document, its info word and the id its registration reads from its body (`fence-hosting.ts`),
     * and the widget is drawn with `presentation` `tab`, reading and changing the document's text
     * through the store (`detached-fence.ts`), so an open tab of the document shows every change.
     *
     * Every state a person can meet has a sentence and a way on:
     *
     * - **Waiting** for the extension to start, or the document to load: said after a moment.
     * - **Not drawn** where nothing draws its kind, when its extension is off or not installed.
     * - **Gone** when the fence was deleted, or the document renamed or deleted: with a way to open
     *   the document, where it may still be.
     * - **Protected** when the document is a Protected Document, locked or not, where no extension
     *   draws anything (ADR 0118): with a way to open the document.
     */
    import { getAppliedResolvedTheme, THEME_CHANGE_EVENT } from "@appsoftwareltd/etherpk-shared/theme";
    import type { Attachment } from "svelte/attachments";

    import type { ViewProps } from "$lib/layout";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { INTERACTIVE_FENCE_KIND, lookupInteractiveFence } from "./augmentations/interactive-fence-contract";
    import { mountDetachedFence } from "./detached-fence";
    import { parseFenceViewTarget } from "./fence-hosting";

    const { view, visibility }: ViewProps = $props();

    const ref = $derived(parseFenceViewTarget(view.target));
    let status = $state<"waiting" | "ready" | "not-drawn" | "gone" | "protected">("waiting");

    /**
     * Draw the widget into the element once its extension has registered it and the document has
     * loaded, and draw it again if the registration changes (the extension restarted). Read again
     * from scratch on any change of target, which re-runs the attachment.
     */
    function drawn(target: NonNullable<typeof ref>): Attachment<HTMLElement> {
        return (element) => {
            let stopped = false;
            let mounted: ReturnType<typeof mountDetachedFence> = null;
            const store = workspaceService("store");
            const registry = workspaceService("contributions");

            const take = () => {
                mounted?.destroy();
                mounted = null;
                element.replaceChildren();
            };
            const draw = async () => {
                take();
                const fence = lookupInteractiveFence(target.info);
                if (!fence) {
                    status = "not-drawn";
                    return;
                }
                if (!store) return;
                await store.whenReady?.(target.document).catch(() => {});
                if (stopped) return;
                const host = document.createElement("div");
                host.className = "h-full";
                element.append(host);
                try {
                    mounted = mountDetachedFence({
                        doc: store.open(target.document),
                        ref: target,
                        fence,
                        presentation: "tab",
                        host,
                        dark: () => getAppliedResolvedTheme() === "dark",
                        onScreen: () => visibility?.onScreen ?? true,
                        onGone: (reason) => {
                            take();
                            status = reason;
                        },
                        openInTab: () => {},
                        editAsText: () => workspaceService("layout")?.openView({ kind: "document", target: target.document }),
                    });
                } catch (error) {
                    console.error("[fence-view] the widget could not be drawn", error);
                    mounted = null;
                }
                if (mounted) status = "ready";
                else if (status !== "protected") status = "gone";
            };

            // Kept loaded while the tab is open, as a document's own tab keeps it, so another
            // device's change reaches the widget even with the document's editor closed.
            const release = (store as { retainDocument?: (target: string) => () => void } | undefined)?.retainDocument?.(target.document);
            void draw();
            const unsubscribe = registry?.subscribe(INTERACTIVE_FENCE_KIND, () => void draw()) ?? (() => {});
            const onTheme = () => mounted?.refresh();
            window.addEventListener(THEME_CHANGE_EVENT, onTheme);
            const unwatch = visibility?.subscribe(() => mounted?.refresh()) ?? (() => {});
            return () => {
                stopped = true;
                unsubscribe();
                unwatch();
                window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
                mounted?.destroy();
                release?.();
            };
        };
    }

    function openDocument() {
        if (ref) workspaceService("layout")?.openView({ kind: "document", target: ref.document });
    }
</script>

{#if ref === null}
    <div class="flex h-full items-center justify-center p-6" data-testid="fence-view-invalid">
        <p class="m-0 text-sm text-(--gk-text-muted)">This tab doesn't name anything to show.</p>
    </div>
{:else}
    {#key view.target}
        <div class="relative h-full" data-testid="fence-view" data-info={ref.info}>
            <div class={["h-full", status !== "ready" && "hidden"]} {@attach drawn(ref)}></div>
            {#if status === "waiting"}
                <div class="loading absolute inset-0 flex items-center justify-center" aria-busy="true">
                    <p class="m-0 text-sm text-(--gk-text-muted)">Loading…</p>
                </div>
            {:else if status === "not-drawn"}
                <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="fence-view-not-drawn">
                    <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">
                        Nothing on this device draws <code>{ref.info}</code>. The extension that does may be switched off or not installed.
                    </p>
                    <button type="button" class="action" onclick={openDocument}>Open {ref.document}</button>
                </div>
            {:else if status === "gone"}
                <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" role="status" data-testid="fence-view-gone">
                    <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">This is no longer in {ref.document}. It may have been deleted, or the document renamed.</p>
                    <button type="button" class="action" onclick={openDocument}>Open {ref.document}</button>
                </div>
            {:else if status === "protected"}
                <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" role="status" data-testid="fence-view-protected">
                    <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">
                        {ref.document} is a protected document. Extensions don't draw anything in a protected document, so this can't be shown here.
                    </p>
                    <button type="button" class="action" onclick={openDocument}>Open {ref.document}</button>
                </div>
            {/if}
        </div>
    {/key}
{/if}

<style>
    /* Wait before saying anything, so a quick load never flashes a message. */
    .loading {
        animation: fence-view-appear 160ms ease-out 400ms both;
    }
    @keyframes fence-view-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .loading {
            animation-duration: 0ms;
        }
    }
    .action {
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.375rem;
        padding: 0.375rem 0.75rem;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--gk-text-default);
        background: transparent;
    }
    .action:hover {
        background: var(--gk-surface-1);
    }
</style>
