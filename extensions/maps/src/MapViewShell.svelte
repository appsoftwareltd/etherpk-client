<script lang="ts">
    /**
     * The component the maps extension registers for its two [[Map View]] kinds, kept small on
     * purpose, as the Graph View's shell is.
     *
     * The desktop mounts every tab when a graph opens, so whatever this imports is paid for by
     * every graph that left a map open, whether or not anyone looks at it. All it does is follow
     * the View's visibility (view-visibility.ts) and load the real thing, the panel with MapLibre
     * behind it, with `import()` the first time the View is on screen. After that it hands the
     * panel the same visibility, which is what stops the panel's reads when the tab goes behind
     * another or the browser tab is hidden.
     */
    import type { ViewMountProps } from '@appsoftwareltd/etherpk-extension-api'
    import type { Component } from 'svelte'
    import { createSubscriber } from 'svelte/reactivity'

    import { mapViewConcept } from './identity'
    import type { MapViewPanelProps } from './map-view-panel-props'

    const { view, panelId, visibility }: ViewMountProps = $props()

    const concept = $derived(mapViewConcept(view))

    // A presenter hands a View one visibility object for its whole life, so the subscription is
    // made once, the first time anything reads `onScreen`.
    const watchVisibility = createSubscriber((update) => visibility.subscribe(() => update()))
    const onScreen = $derived.by(() => {
        watchVisibility()
        return visibility.onScreen
    })

    type PanelModule = { default: Component<MapViewPanelProps> }
    // Plain, not $state: the promise is created once and never replaced except by a retry, which
    // bumps `attempt` so the derived below reads it again.
    let panel: Promise<PanelModule> | undefined
    let attempt = $state(0)
    /** The panel's module, requested the first time the View is on screen and kept from then on. */
    const loaded = $derived.by(() => {
        void attempt
        if (onScreen) panel ??= import('./MapViewPanel.svelte')
        return panel
    })

    function retry() {
        panel = undefined
        attempt += 1
    }
</script>

<div class="h-full bg-(--gk-surface-0)" data-testid="map-view" data-scope={concept === null ? 'whole' : 'concept'} data-on-screen={onScreen}>
    {#if loaded}
        {#await loaded}
            <!-- The chunk usually lands within a frame or two; the hint only fades in if it does not. -->
            <div class="map-view-loading flex h-full items-center justify-center" aria-busy="true" data-testid="map-view-loading">
                <p class="m-0 text-sm text-(--gk-text-muted)">Loading the map…</p>
            </div>
        {:then module}
            <module.default {concept} {panelId} {onScreen} />
        {:catch}
            <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="map-view-load-failed">
                <p class="m-0 max-w-sm text-sm text-(--gk-text-muted)">The map couldn't load. Check your connection, then try again.</p>
                <button
                    type="button"
                    class="rounded-md border border-(--gk-border-strong) px-3 py-1.5 text-sm font-medium text-(--gk-text-default) hover:bg-(--gk-surface-1)"
                    onclick={retry}
                    data-testid="map-view-retry">Try again</button
                >
            </div>
        {/await}
    {/if}
</div>

<style>
    /* Wait before saying anything, so a load that finishes quickly never flashes a message. */
    .map-view-loading {
        animation: map-view-appear 160ms ease-out 400ms both;
    }
    @keyframes map-view-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .map-view-loading {
            animation-duration: 0ms;
        }
    }
</style>
