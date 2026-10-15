<script lang="ts">
    /**
     * A fence's widget filling the EtherPK window: over the sidebars and the tabs, with a heading and
     * a close button, the browser's own chrome left alone. Esc stays with the widget (a drawing
     * leaves a tool with it), so the way back is the close button, which takes the keyboard back to
     * where it was when the window opened.
     *
     * The keyboard stays inside while it is open, as in a dialog: it is one, over everything else.
     */
    import { getAppliedResolvedTheme, THEME_CHANGE_EVENT } from "@appsoftwareltd/etherpk-shared/theme";
    import type { Attachment } from "svelte/attachments";

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
    const titleId = $props.id();
    // Named as its tab is: the extension's title for the fence, or its info word.
    const heading = $derived(`${fence.title ?? fenceRef.info}: ${fenceRef.document}`);

    /**
     * The element that had the keyboard as the window opened, to give it back on closing. A loaded
     * extension's widget draws in a shadow root, where `document.activeElement` is only the root's
     * host, so the search follows the focus down into each shadow root to the button itself.
     */
    function focusedElement(): HTMLElement | null {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active instanceof HTMLElement ? active : null;
    }
    const returnTo = focusedElement();

    function close() {
        onclose();
        returnTo?.focus();
    }

    const drawn: Attachment<HTMLElement> = (element) => {
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

    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    /**
     * What Tab can reach in `root`, in the order Tab reaches it, including what a widget draws in a
     * shadow root, which `querySelectorAll` alone does not see.
     */
    function focusables(root: Element | ShadowRoot): HTMLElement[] {
        const found: HTMLElement[] = [];
        for (const candidate of root.querySelectorAll<HTMLElement>("*")) {
            if (candidate.matches(FOCUSABLE) && !candidate.hasAttribute("disabled") && candidate.offsetParent !== null) found.push(candidate);
            if (candidate.shadowRoot) found.push(...focusables(candidate.shadowRoot));
        }
        return found;
    }

    /** Keep Tab inside the window, cycling at its ends, as a dialog does. */
    function trapTab(event: KeyboardEvent) {
        if (event.key !== "Tab") return;
        const focusable = focusables(event.currentTarget as HTMLElement);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = focusedElement();
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    const focusReturn: Attachment<HTMLButtonElement> = (button) => {
        button.focus();
    };
</script>

<div class="fence-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" onkeydown={trapTab} data-testid="fence-window">
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-(--gk-border-soft) px-4 py-2">
        <h2 id={titleId} class="m-0 truncate text-sm font-semibold text-(--gk-text-default)">{heading}</h2>
        <button type="button" class="return" onclick={close} aria-label="Close" title="Close" data-testid="fence-window-return" {@attach focusReturn}><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg></button>
    </header>
    <div class="relative min-h-0 flex-1">
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
            <div class="h-full" {@attach drawn}></div>
        {/if}
    </div>
</div>

<style>
    .fence-window {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-0);
        animation: fence-window-in 150ms ease-out both;
    }
    @keyframes fence-window-in {
        from {
            transform: scale(0.98);
        }
        to {
            transform: none;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .fence-window {
            animation: none;
        }
    }
    /* A close icon in a 2.25rem square, the hit area a phone needs (2.75rem on a coarse pointer). */
    .return {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.375rem;
        color: var(--gk-text-default);
        background: transparent;
    }
    @media (pointer: coarse) {
        .return {
            width: 2.75rem;
            height: 2.75rem;
        }
    }
    .return:hover {
        background: var(--gk-surface-1);
    }
</style>
