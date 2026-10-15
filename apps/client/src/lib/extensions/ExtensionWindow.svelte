<script lang="ts">
    /**
     * Something an extension draws over the whole EtherPK window (`context.layout.openWindow`,
     * ADR 0147), as a fence's widget opens over it (FenceWindow.svelte): a heading and a close
     * button the Client draws, and the extension's content filling the rest. An Agent Chat on a
     * phone is drawn here. The close button and Escape close it, and the keyboard goes back to
     * where it was when the window opened.
     *
     * The keyboard stays inside while it is open, as in a dialog: it is one, over everything else.
     */
    import type { Attachment } from "svelte/attachments";

    const {
        title,
        mount,
        onclose,
    }: {
        title: string;
        mount: (host: HTMLElement, window: { close(): void }) => { destroy(): void };
        onclose: () => void;
    } = $props();

    const titleId = $props.id();

    /** The element that had the keyboard as the window opened, followed down into shadow roots. */
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
        let content: { destroy(): void } | null = null;
        try {
            content = mount(element, { close });
        } catch (error) {
            console.error("[extension-window] the content could not be drawn", error);
        }
        return () => content?.destroy();
    };

    const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function focusables(root: Element | ShadowRoot): HTMLElement[] {
        const found: HTMLElement[] = [];
        for (const candidate of root.querySelectorAll<HTMLElement>("*")) {
            if (candidate.matches(FOCUSABLE) && !candidate.hasAttribute("disabled") && candidate.offsetParent !== null) found.push(candidate);
            if (candidate.shadowRoot) found.push(...focusables(candidate.shadowRoot));
        }
        return found;
    }

    /** Keep Tab inside the window, cycling at its ends, and let Escape close it. */
    function onkeydown(event: KeyboardEvent) {
        if (event.key === "Escape" && !event.defaultPrevented) {
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
</script>

<div class="extension-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" {onkeydown} data-testid="extension-window">
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-(--gk-border-soft) px-4 py-2">
        <h2 id={titleId} class="m-0 truncate text-sm font-semibold text-(--gk-text-default)">{title}</h2>
        <button type="button" class="return" onclick={close} aria-label="Close" title="Close" data-testid="extension-window-return"><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg></button>
    </header>
    <div class="relative min-h-0 flex-1" {@attach drawn}></div>
</div>

<style>
    .extension-window {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-0);
        animation: extension-window-in 150ms ease-out both;
    }
    @keyframes extension-window-in {
        from {
            transform: scale(0.98);
        }
        to {
            transform: none;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .extension-window {
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
