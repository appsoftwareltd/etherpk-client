<script lang="ts">
    /**
     * The one piece of chrome that tells a visitor what the [[Demo Graph]] is (ADR 0069):
     * that it lives in this browser only, and where the two exits are. Not dismissible, so a
     * returning visitor is never left believing their edits are safe. Nothing about sign-up
     * or pricing: the picker is where the real graph options are explained.
     *
     * Desktop chrome only: the workspace route layout that mounts it leaves it out below the
     * presenter breakpoint, where its copy would wrap over the phone's tab strip, and drops
     * the reserve it makes for the bar's height in the same rule.
     */
    let { top = "3.5rem" }: { top?: string } = $props();
</script>

<div class="demo-bar" data-testid="demo-bar" role="note" style:--demo-bar-top={top}>
    <p class="copy">
        <strong>Demo graph.</strong>
        It lives in this browser's storage only, so edit freely. It is not backed up anywhere.
    </p>
    <span class="actions">
        <a href="/demo?reset=1" data-testid="demo-bar-reset">Reset demo</a>
        <a href="/graphs" data-testid="demo-bar-own">Start your own graph</a>
    </span>
</div>

<style>
    .demo-bar {
        position: fixed;
        top: var(--demo-bar-top);
        left: 0;
        right: 0;
        /* Under the application header (z-30) and its menu backdrop (z-20): the header's Graphs
           dropdown opens down over this bar, and a bar at the header's own level painted over
           it. The workspace is offset below the bar, so nothing of it needs covering. */
        z-index: 10;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.25rem 1rem;
        min-height: 2.25rem;
        padding: 0.3rem 1rem;
        background: color-mix(in srgb, var(--gk-accent, #2563eb) 12%, var(--gk-surface-1));
        border-bottom: 1px solid var(--gk-border-soft);
        color: var(--gk-text-default);
        font-size: 0.8125rem;
        line-height: 1.3;
    }
    .copy {
        margin: 0;
        min-width: 0;
    }
    .actions {
        display: flex;
        gap: 1rem;
        white-space: nowrap;
    }
    .actions a {
        color: inherit;
        font-weight: 600;
        text-decoration: underline;
        text-underline-offset: 2px;
    }
</style>
