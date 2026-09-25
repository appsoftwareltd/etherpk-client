<script lang="ts">
    /**
     * The app's one indeterminate loading indicator: a thin sweeping bar, the same visual
     * language as the Activity Toast's progress sweep (ADR 0035). It replaces the rotating
     * ring spinners, which read as FROZEN whenever anything kept them from turning —
     * reduced-motion settings, a busy first paint — and a frozen spinner reads as a hung
     * app (live, 2026-07-28/29). Under reduced motion the bar fills and gently pulses
     * opacity instead of travelling: still visibly alive, minimally moving.
     */
    let { label = 'Loading' }: { label?: string } = $props()
</script>

<div class="loading-sweep" data-testid="loading-sweep" role="status" aria-label={label}>
    <div class="loading-sweep__bar" aria-hidden="true"></div>
</div>

<style>
    .loading-sweep {
        width: 100%;
        max-width: 14rem;
        height: 3px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--gk-border-soft);
    }
    .loading-sweep__bar {
        width: 40%;
        height: 100%;
        border-radius: inherit;
        background: var(--gk-text-default);
        animation: gk-sweep 1.2s ease-in-out infinite;
        /* Compositor layer: keeps sweeping while the main thread works. */
        will-change: transform;
    }
    @keyframes gk-sweep {
        0% {
            transform: translateX(-110%);
        }
        100% {
            transform: translateX(360%);
        }
    }
    @keyframes gk-sweep-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.35;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .loading-sweep__bar {
            width: 100%;
            animation: gk-sweep-pulse 1.6s ease-in-out infinite;
        }
    }
</style>
