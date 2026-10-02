<script lang="ts">
    /**
     * The component the [[Graph View]] registers for its View kind, kept small on purpose.
     *
     * The desktop mounts every tab when a graph opens, the resident included, so whatever this
     * imports is paid for by every graph whether or not anyone looks at the picture. All it does
     * is follow the View's visibility (view-visibility.ts) and load the real thing, the panel with
     * sigma and graphology behind it, with `import()` the first time the View is on screen. After
     * that it hands the panel the same visibility, which is what stops the panel's work when the
     * tab goes behind another, the Sidebar collapses or the browser tab is hidden.
     */
    import type { Component } from "svelte";
    import { createSubscriber, MediaQuery } from "svelte/reactivity";

    import type { ViewProps } from "$lib/layout";
    import { DESKTOP_MEDIA_QUERY } from "$lib/layout/breakpoint";

    import { graphViewMode } from "./identity";
    import type { GraphViewPanelProps } from "./panel-props";

    const { view, panelId, visibility }: ViewProps = $props();

    const desktop = new MediaQuery(DESKTOP_MEDIA_QUERY);
    const mode = $derived(graphViewMode(view));

    // A presenter hands a View one visibility object for its whole life, so the subscription is
    // made once, the first time anything reads `onScreen`.
    const watchVisibility = createSubscriber((update) => visibility?.subscribe(() => update()));
    const onScreen = $derived.by(() => {
        watchVisibility();
        return visibility?.onScreen ?? true;
    });

    type PanelModule = { default: Component<GraphViewPanelProps> };
    // Plain, not $state: the promise is created once and never replaced except by a retry, which
    // bumps `attempt` so the derived below reads it again.
    let panel: Promise<PanelModule> | undefined;
    let attempt = $state(0);
    /** The panel's module, requested the first time the View is on screen and kept from then on. */
    const loaded = $derived.by(() => {
        void attempt;
        if (onScreen && desktop.current) panel ??= import("./GraphViewPanel.svelte");
        return panel;
    });

    function retry() {
        panel = undefined;
        attempt += 1;
    }
</script>

<div class="h-full bg-(--gk-surface-0)" data-testid="graph-view" data-mode={mode} data-on-screen={onScreen}>
    {#if !desktop.current}
        <div class="flex h-full items-center justify-center p-6" data-testid="graph-view-needs-wider">
            <p class="m-0 max-w-sm text-center text-sm text-(--gk-text-muted)">
                The Graph View needs a wider window. Widen this one, or open your graph on a larger screen.
            </p>
        </div>
    {:else if loaded}
        {#await loaded}
            <!-- The chunk usually lands within a frame or two; the hint only fades in if it does not. -->
            <div class="graph-view-loading flex h-full items-center justify-center" aria-busy="true" data-testid="graph-view-loading">
                <p class="m-0 text-sm text-(--gk-text-muted)">Loading the Graph View…</p>
            </div>
        {:then module}
            <module.default {mode} {panelId} {onScreen} />
        {:catch}
            <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="graph-view-load-failed">
                <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">
                    The Graph View couldn't load. Check your connection, then try again.
                </p>
                <button
                    type="button"
                    class="rounded-md border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-1)"
                    onclick={retry}
                    data-testid="graph-view-retry">Try again</button
                >
            </div>
        {/await}
    {/if}
</div>

<style>
    /* Wait before saying anything, so a load that finishes quickly never flashes a message. */
    .graph-view-loading {
        animation: graph-view-appear 160ms ease-out 400ms both;
    }
    @keyframes graph-view-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .graph-view-loading {
            animation-duration: 0ms;
        }
    }
</style>
