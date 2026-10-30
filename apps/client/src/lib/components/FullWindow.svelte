<script lang="ts">
    /**
     * A window filling the whole EtherPK window, over the sidebars and the tabs, with the browser's
     * own chrome left alone: a heading, a close button, and the caller's content filling the rest.
     * The shell of the Fence Window (`FenceWindow.svelte`) and of an extension's window
     * (`ExtensionWindow.svelte`, ADR 0147).
     *
     * The keyboard stays inside while it is open, as in a dialog: it is one, over everything else.
     * Content an extension draws sits in shadow roots, so the Tab trap and the focus it gives back
     * follow the focus down into them, which the shared `dialogFocus` does not.
     *
     * It sits on `--z-window`, under every dialog (`etherpk-shared/layers.css`), so a dialog opened
     * from inside a window, such as an extension's prompt, is drawn over it, and toasts show over it.
     */
    import type { Snippet } from "svelte";
    import type { Attachment } from "svelte/attachments";

    const {
        title,
        testId,
        onclose,
        closeOnEscape = false,
        focusClose = false,
        children,
    }: {
        title: string;
        /** `data-testid` of the window; its close button is `<testId>-return`. */
        testId: string;
        onclose: () => void;
        /**
         * Escape closes the window. Off for a widget that keeps Escape for itself (a drawing
         * leaves a tool with it), where the way back is the close button.
         */
        closeOnEscape?: boolean;
        /** The close button takes the keyboard as the window opens. */
        focusClose?: boolean;
        /** The content, handed the window's own close: it also gives the keyboard back. */
        children: Snippet<[close: () => void]>;
    } = $props();

    const titleId = $props.id();

    /**
     * The element that has the keyboard. In a shadow root `document.activeElement` is only the
     * root's host, so the search follows the focus down into each shadow root to the element itself.
     */
    function focusedElement(): HTMLElement | null {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active instanceof HTMLElement ? active : null;
    }
    /** The element that had the keyboard as the window opened, to give it back on closing. */
    const returnTo = focusedElement();

    function close() {
        onclose();
        returnTo?.focus();
    }

    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    /**
     * What Tab can reach in `root`, in the order Tab reaches it, including what is drawn in a
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

    /** Keep Tab inside the window, cycling at its ends, and let Escape close it when asked to. */
    function onkeydown(event: KeyboardEvent) {
        if (closeOnEscape && event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            close();
            return;
        }
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

    const focusOnOpen: Attachment<HTMLButtonElement> = (button) => {
        if (focusClose) button.focus();
    };
</script>

<div class="full-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" {onkeydown} data-testid={testId}>
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-(--gk-border-soft) px-4 py-2">
        <h2 id={titleId} class="m-0 truncate text-sm font-semibold text-(--gk-text-default)">{title}</h2>
        <button type="button" class="return" onclick={close} aria-label="Close" title="Close" data-testid="{testId}-return" {@attach focusOnOpen}><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg></button>
    </header>
    <div class="relative min-h-0 flex-1">
        {@render children(close)}
    </div>
</div>

<style>
    .full-window {
        position: fixed;
        inset: 0;
        z-index: var(--z-window);
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-0);
        animation: full-window-in 150ms ease-out both;
    }
    @keyframes full-window-in {
        from {
            transform: scale(0.98);
        }
        to {
            transform: none;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .full-window {
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
