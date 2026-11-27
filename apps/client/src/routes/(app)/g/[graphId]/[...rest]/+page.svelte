<script lang="ts">
    /**
     * An address of the shape used before ADR 0192, `/g/<id>/…`: sent on to the graph's
     * [[Graph Address]], with the rest of the path, the query and the fragment (a Task Reference
     * is in the fragment). Kept for one release, then removed (MAINTENANCE.md).
     */
    import { onMount } from 'svelte'

    import { goto } from '$app/navigation'
    import { page } from '$app/state'

    import OpeningNotice from '#lib/components/OpeningNotice.svelte'
    import { legacyGraphAddress } from '#lib/navigation/graph-address.js'
    import type { GraphRecord } from '#lib/storage/graph-registry.js'
    import { createIdbGraphRegistry } from '#lib/storage/graph-registry-idb.js'
    import { chosenGraphState } from '#lib/workspace/chosen-graph.js'

    onMount(async () => {
        let graphs: GraphRecord[] = []
        try {
            graphs = await createIdbGraphRegistry().listGraphs()
        } catch (error) {
            // Without the list the id is taken to be a synced graph's, as an id nothing holds is.
            console.warn('[graph-address] the graph list could not be read for an old address', error)
        }
        const next = legacyGraphAddress(location.pathname, location.search, graphs)
        // The id found the graph, which its new address may not do alone: two folders can have one name (chosen-graph.ts).
        const held = graphs.find((graph) => graph.id === page.params.graphId)
        await goto(next === null ? '/graphs' : `${next}${location.hash}`, { replace: true, state: held ? chosenGraphState(held) : {} })
    })
</script>

<OpeningNotice testid="legacy-graph-address" />
