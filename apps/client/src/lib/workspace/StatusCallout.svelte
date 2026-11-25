<script lang="ts">
    /**
     * The notice beside the graph's status dot: one or two sentences shown without a press, when
     * sync has stopped in a way the person should hear about (graph-status.ts). It hangs under the
     * dot with a pointer to it, and stays until closed or until the state passes.
     *
     * The parent positions it: this is absolutely placed under the nearest positioned ancestor,
     * which wraps the dot, and lines up with that wrapper's left edge. The dot is near the left
     * end of the app's header, so the notice stays inside the viewport.
     */
    import type { StatusCallout } from './graph-status'

    let {
        callout,
        ondismiss,
    }: {
        callout: StatusCallout
        ondismiss: () => void
    } = $props()
</script>

<!-- A live region, so a screen reader hears the notice when the state arrives: this is the one
     announcement, and the states it covers are rare. -->
<div class="callout" data-testid="graph-status-callout" data-callout={callout.id} role="status">
    <p>{callout.text}</p>
    <button type="button" class="close" aria-label="Close this notice" data-testid="graph-status-callout-close" onclick={ondismiss}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" d="M6 6l12 12M18 6 6 18" />
        </svg>
    </button>
</div>

<style>
    .callout {
        position: absolute;
        top: calc(100% + 10px);
        left: -4px;
        z-index: 40;
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        box-sizing: border-box;
        width: min(19rem, calc(100vw - 24px));
        padding: 0.6rem 0.5rem 0.6rem 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 8px;
        background: var(--gk-surface-0, #fff);
        color: var(--gk-text-default);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        font-size: 0.875rem;
        font-weight: 400;
        line-height: 1.4;
        text-align: left;
        animation: callout-in 160ms ease-out;
    }
    /* The pointer: a square turned on its corner, sharing the bubble's border on its two upper sides. */
    .callout::before {
        content: '';
        position: absolute;
        top: -6px;
        left: 14px;
        width: 10px;
        height: 10px;
        border-left: 1px solid var(--gk-border-soft);
        border-top: 1px solid var(--gk-border-soft);
        background: inherit;
        transform: rotate(45deg);
    }
    p {
        margin: 0;
        flex: 1;
        min-width: 0;
    }
    .close {
        flex: none;
        display: inline-flex;
        padding: 0.3rem;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--gk-text-muted);
        cursor: pointer;
    }
    .close:hover {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
        color: var(--gk-text-default);
    }
    .close:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 1px;
    }
    .close svg {
        width: 1rem;
        height: 1rem;
        display: block;
    }
    @keyframes callout-in {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .callout {
            animation: none;
        }
    }
</style>
