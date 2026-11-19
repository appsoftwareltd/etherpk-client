<script lang="ts">
    /**
     * The workspace route group: `/graph/[where]/[name]`, `…/d/[...concept]`, the
     * Asset tab and Theme editor addresses (`/a/[assetId]`, `/t/[themeId]`) all share this
     * single GraphWorkspace mount, so shallow-routed Visit URL changes AND real navigations
     * between the pages never remount the Layout (ADR 0023). Settings is not a route: it is
     * a query param on whichever of these is beneath it (`?settings=<tab>`).
     * Keyed by Graph Address: a cross-graph navigation rebuilds the workspace (onMount
     * does the building, and Svelte reuses the component otherwise). The gate turns the
     * address into a graph this browser holds before the workspace mounts (ADR 0192).
     */
    import { onMount, type Snippet } from 'svelte'

    import { isDemoGraph } from '#lib/demo/demo-graph.js'
    import { ensurePersistentStorage, persistenceExplained, persistenceStep } from '#lib/storage/storage-persistence.js'
    import PersistentStorageDialog from '#lib/workspace/PersistentStorageDialog.svelte'
    import { appHeaderHiddenOnPhone } from '#lib/workspace/app-header.svelte.js'
    import DemoBar from '#lib/demo/ui/DemoBar.svelte'
    import { graphAddressPath } from '#lib/navigation/graph-address.js'
    import GraphAddressGate from '#lib/workspace/GraphAddressGate.svelte'

    import type { LayoutData } from './$types'

    let { data, children }: { data: LayoutData; children: Snippet } = $props()

    // The Demo Graph carries a bar under the app header (ADR 0069); the workspace is fixed
    // to the viewport, so it is told how much of the top the bar takes. Both heights reach
    // the stylesheet below as custom properties: whether the bar is shown, and so whether its
    // height is reserved, is decided there by viewport width.
    const HEADER_HEIGHT = '3.5rem'
    const DEMO_BAR_HEIGHT = '2.25rem'
    const demo = $derived(data.address.where === 'browser' && isDemoGraph(data.address.name))

    // Ask the browser not to evict the graph registry, Local Cache and Derived Index under disk
    // pressure. Asked here, where a graph opens, and not on the public pages: Firefox answers with
    // a permission prompt, which a visitor reading the landing page has no reason to meet. Where
    // the browser decides on its own (Chromium, Safari) the request is made at once and a refusal
    // is logged. Firefox gets EtherPK's reason first (`PersistentStorageDialog`), once, and its
    // Continue button makes the request. The demo is left alone: nothing in it needs keeping.
    let explainPersistence = $state(false)
    onMount(() => {
        if (demo) return
        void persistenceStep({
            storage: navigator.storage,
            permissions: navigator.permissions,
            userAgent: navigator.userAgent,
            explained: persistenceExplained(),
        }).then((step) => {
            if (step === 'explain') explainPersistence = true
            if (step !== 'request') return
            void ensurePersistentStorage().then((outcome) => {
                if (outcome.supported && !outcome.persisted) {
                    console.warn(
                        '[storage] Persistent storage was not granted; this browser may evict folder graph data under disk pressure.',
                    )
                }
            })
        })
    })
</script>

{#key graphAddressPath(data.address)}
    {#if demo}
        <div class="demo-chrome">
            <DemoBar top={HEADER_HEIGHT} />
        </div>
    {/if}
    <div
        class={['workspace-host', { demo, 'no-header-on-phone': appHeaderHiddenOnPhone.current }]}
        style:--header-height={HEADER_HEIGHT}
        style:--demo-bar-height={DEMO_BAR_HEIGHT}
    >
        <GraphAddressGate
            address={data.address}
            autosaveMs={data.autosaveMs}
            indexingIconMs={data.indexingIconMs}
            server={data.server}
        />
    </div>
{/key}
{@render children()}
<PersistentStorageDialog open={explainPersistence} onclose={() => (explainPersistence = false)} />

<style>
    .workspace-host {
        --workspace-top: var(--header-height);
    }

    /*
     * The demo bar is desktop chrome. Below the presenter breakpoint (LAYOUT_BREAKPOINT_PX in
     * #lib/layout/breakpoint.ts: the same 1024px, kept in px so the bar swaps exactly where
     * the presenter does) the phone presenter mounts and the bar's copy wraps to three lines,
     * past the height reserved for it, covering the tab strip. So below it the bar is left
     * out and nothing is reserved. A stylesheet query rather than one in script: the server
     * render is right without a hydration flash, and one query governs both the bar and its
     * reserve so the two cannot drift apart.
     */
    .demo-chrome {
        display: none;
    }
    /* The app layout hides its header under the same query, so the workspace moves into the room. */
    @media not all and (min-width: 1024px) {
        .workspace-host.no-header-on-phone {
            --workspace-top: 0px;
        }
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
