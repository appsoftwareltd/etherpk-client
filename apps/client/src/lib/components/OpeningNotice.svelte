<script lang="ts">
    /**
     * The notice every step of opening a graph or a folder shows: the root page choosing what to
     * resume, the offline shell handing its address to the router, an old address sent on, the
     * graph's address reading the list of graphs, and the workspace opening the graph. One notice,
     * drawn in one place with one set of words, so the steps read as one wait rather than as a run
     * of different messages. The words name neither a graph nor a folder, since both open this way.
     *
     * `children` goes under the bar (the workspace's line about a shared note), and `status` stands in
     * for the words once there is a count to show (the workspace loading and indexing documents).
     */
    import type { Snippet } from 'svelte'

    import LoadingSweep from './LoadingSweep.svelte'

    let { testid, children, status }: { testid: string; children?: Snippet; status?: Snippet } = $props()
</script>

<div class="opening" data-testid={testid}>
    <LoadingSweep label="Opening your notes" />
    {@render children?.()}
    {#if status}
        {@render status()}
    {:else}
        <p role="status" data-testid="opening-message">Opening your notes…</p>
    {/if}
</div>

<style>
    .opening {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--gk-text-default);
        max-width: 32rem;
        margin: 0 auto;
        padding: 1rem;
    }
    .opening p {
        margin: 0;
    }
    .opening :global(.loading-sweep) {
        margin: 0 auto;
    }
</style>
