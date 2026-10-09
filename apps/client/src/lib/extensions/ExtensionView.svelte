<script lang="ts">
    /**
     * The component behind every View kind an extension declares (ADR 0121). The workspace
     * registers it for each kind with the kind's slot, before any extension runs, so a tab the
     * Layout restores always has something to draw: what the extension supplied, or why not yet.
     *
     * - **Waiting:** the extension is starting. Said only after a moment, so a quick start never
     *   flashes a message.
     * - **Ready:** the extension's `mount(element, props)` draws into an element of its own. For a
     *   loaded extension that element sits in a shadow root holding the extension's stylesheets,
     *   so neither side's CSS reaches the other but the `--gk-*` tokens and inherited text styles.
     * - **Failed** or **off:** what happened, and the one thing to do about it, here in the tab.
     */
    import type { MountedView, ViewContribution, ViewMountProps } from "@appsoftwareltd/etherpk-extension-api";
    import { untrack } from "svelte";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import type { ViewProps } from "$lib/layout";

    import type { ExtensionHost, ViewSlot } from "./host";
    import { extensionStyleSheets } from "./styles";

    interface Props extends ViewProps {
        slot: ViewSlot;
        host: Pick<ExtensionHost, "setOn" | "retry">;
    }
    const { view, panelId, visibility, slot, host }: Props = $props();

    // The slot lives as long as the workspace: one subscription for the component's life.
    const watchSlot = createSubscriber((update) => slot.subscribe(update));
    const slotState = $derived.by(() => {
        watchSlot();
        return slot.state();
    });

    /** A View with no presenter-given visibility is always on screen. */
    const alwaysOnScreen = { onScreen: true, subscribe: () => () => {} };

    /**
     * A View whose `mount` threw, or whose stylesheets would not load, and why. Tied to that View,
     * so once the extension supplies a new one (after Try again) the message goes by itself.
     */
    let drawFailure = $state<{ view: ViewContribution; message: string } | null>(null);
    const drawError = $derived(slotState.status === "ready" && drawFailure?.view === slotState.view ? drawFailure.message : null);
    let mounted: MountedView | undefined;
    let busy = $state(false);

    const mountProps = (): ViewMountProps => ({
        view,
        ...(panelId === undefined ? {} : { panelId }),
        visibility: visibility ?? alwaysOnScreen,
    });

    /**
     * Draw `supplied` into the element, and take it down when the slot supplies another View or
     * the tab goes. The props are read untracked: a change to them updates the View (below)
     * rather than drawing it again from nothing.
     */
    function drawn(supplied: ViewContribution): Attachment<HTMLElement> {
        return (target) => {
            let cancelled = false;
            let root: HTMLElement | undefined;
            const failed = (error: unknown) => {
                console.error(`[extensions] ${slot.kind} could not draw`, error);
                drawFailure = { view: supplied, message: error instanceof Error ? error.message : String(error) };
            };
            const draw = (element: HTMLElement) => {
                try {
                    mounted = supplied.mount(element, untrack(mountProps));
                } catch (error) {
                    failed(error);
                }
            };

            if (slot.isolation) {
                const shadow = target.shadowRoot ?? target.attachShadow({ mode: "open" });
                extensionStyleSheets(slot.isolation.styles).then(
                    (sheets) => {
                        if (cancelled) return;
                        shadow.adoptedStyleSheets = sheets;
                        root = document.createElement("div");
                        root.className = "extension-view";
                        shadow.append(root);
                        draw(root);
                    },
                    (error: unknown) => {
                        if (!cancelled) failed(error);
                    },
                );
            } else {
                draw(target);
            }

            return () => {
                cancelled = true;
                const done = mounted;
                mounted = undefined;
                try {
                    done?.destroy();
                } catch (error) {
                    console.error(`[extensions] ${slot.kind} failed to take its View down`, error);
                }
                root?.remove();
            };
        };
    }

    // A rename re-keys the target, a move changes the panel: the mounted View hears it.
    $effect(() => {
        const props = mountProps();
        untrack(() => mounted?.update?.(props));
    });

    /** Run a button's action once, however often it is pressed while it runs. */
    async function act(action: () => Promise<void>) {
        if (busy) return;
        busy = true;
        try {
            await action();
        } finally {
            busy = false;
        }
    }
</script>

{#if slotState.status === "ready" && drawError === null}
    <div class="h-full" {@attach drawn(slotState.view)} data-testid="extension-view" data-extension={slot.extensionId} data-kind={slot.kind}></div>
{:else if slotState.status === "waiting"}
    <div class="loading flex h-full items-center justify-center" aria-busy="true" data-testid="extension-view-loading">
        <p class="m-0 text-sm text-(--gk-text-muted)">Loading {slot.displayName}…</p>
    </div>
{:else if slotState.status === "off"}
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="extension-view-off">
        <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">{slot.displayName} is switched off on this device.</p>
        <button type="button" class="action" disabled={busy} onclick={() => act(() => host.setOn(slot.extensionId, true))} data-testid="extension-view-switch-on"
            >Switch it on</button
        >
    </div>
{:else}
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="extension-view-failed">
        <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">
            {slotState.status === "failed" ? slotState.message : `${slot.displayName} couldn't draw this view: ${drawError}`}
        </p>
        <button type="button" class="action" disabled={busy} onclick={() => act(() => host.retry(slot.extensionId))} data-testid="extension-view-retry"
            >Try again</button
        >
    </div>
{/if}

<style>
    /* Wait before saying anything, so a start that finishes quickly never flashes a message. */
    .loading {
        animation: extension-view-appear 160ms ease-out 400ms both;
    }
    @keyframes extension-view-appear {
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
    .action:hover:not(:disabled) {
        background: var(--gk-surface-1);
    }
    .action:disabled {
        color: var(--gk-text-muted);
    }
</style>
