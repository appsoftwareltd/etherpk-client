<script lang="ts">
    /**
     * An address of the shape used before ADR 0192, `/g/<id>/…`: sent on to the graph's
     * [[Graph Address]], with the rest of the path, the query and the fragment (a Task Reference
     * is in the fragment). Kept for one release, then removed (MAINTENANCE.md).
     */
    import { onMount } from 'svelte'

    import { goto } from '$app/navigation'

    import LoadingSweep from '#lib/components/LoadingSweep.svelte'
    import { legacyGraphAddress } from '#lib/navigation/graph-address.js'
    import type { GraphRecord } from '#lib/storage/graph-registry.js'
    import { createIdbGraphRegistry } from '#lib/storage/graph-registry-idb.js'

    onMount(async () => {
        let graphs: GraphRecord[] = []
        try {
            graphs = await createIdbGraphRegistry().listGraphs()
        } catch (error) {
            // Without the list the id is taken to be a synced graph's, as an id nothing holds is.
            console.warn('[graph-address] the graph list could not be read for an old address', error)
        }
        const next = legacyGraphAddress(location.pathname, location.search, graphs)
        await goto(next === null ? '/graphs' : `${next}${location.hash}`, { replaceState: true })
    })
</script>

<div class="redirect" data-testid="legacy-graph-address">
    <LoadingSweep label="Opening your graph" />
</div>

<style>
    .redirect {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
    }
</style>
