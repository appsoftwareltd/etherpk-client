<script lang="ts">
    /**
     * The workspace route group: `/g/[graphId]`, `/g/[graphId]/d/[...concept]`, the
     * Asset tab and Theme editor addresses (`/a/[assetId]`, `/t/[themeId]`) all share this
     * single GraphWorkspace mount, so shallow-routed Visit URL changes AND real navigations
     * between the pages never remount the Layout (ADR 0023). Settings is not a route: it is
     * a query param on whichever of these is beneath it (`?settings=<tab>`).
     * Keyed by graph id: a cross-graph navigation rebuilds the workspace (onMount
     * does the building, and Svelte reuses the component otherwise).
     */
    import type { Snippet } from 'svelte'

    import { isDemoGraph } from '$lib/demo/demo-graph'
    import DemoBar from '$lib/demo/ui/DemoBar.svelte'
    import GraphWorkspace from '$lib/workspace/GraphWorkspace.svelte'

    import type { LayoutData } from './$types'

    let { data, children }: { data: LayoutData; children: Snippet } = $props()

    // The Demo Graph carries a bar under the app header (ADR 0069); the workspace is fixed
    // to the viewport, so it is told how much of the top the bar takes. Both heights reach
    // the stylesheet below as custom properties: whether the bar is shown, and so whether its
    // height is reserved, is decided there by viewport width.
    const HEADER_HEIGHT = '3.5rem'
    const DEMO_BAR_HEIGHT = '2.25rem'
    const demo = $derived(isDemoGraph(data.graphId))
</script>

{#key data.graphId}
    {#if demo}
        <div class="demo-chrome">
            <DemoBar top={HEADER_HEIGHT} />
        </div>
    {/if}
    <div
        class={['workspace-host', { demo }]}
        style:--header-height={HEADER_HEIGHT}
        style:--demo-bar-height={DEMO_BAR_HEIGHT}
    >
        <GraphWorkspace
            graphId={data.graphId}
            opfs={data.opfs}
            autosaveMs={data.autosaveMs}
            server={data.server}
        />
    </div>
{/key}
{@render children()}

<style>
    .workspace-host {
        --workspace-top: var(--header-height);
    }

    /*
     * The demo bar is desktop chrome. Below the presenter breakpoint (LAYOUT_BREAKPOINT_PX in
     * $lib/layout/breakpoint.ts: the same 1024px, kept in px so the bar swaps exactly where
     * the presenter does) the phone presenter mounts and the bar's copy wraps to three lines,
     * past the height reserved for it, covering the tab strip. So below it the bar is left
     * out and nothing is reserved. A stylesheet query rather than one in script: the server
     * render is right without a hydration flash, and one query governs both the bar and its
     * reserve so the two cannot drift apart.
     */
    .demo-chrome {
        display: none;
    }
    @media (min-width: 1024px) {
        .demo-chrome {
            display: contents;
        }
        .workspace-host.demo {
            --workspace-top: calc(var(--header-height) + var(--demo-bar-height));
        }
    }
</style>
