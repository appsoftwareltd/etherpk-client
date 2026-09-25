<script lang="ts">
    /**
     * The graphs on this device, listed under the header's Graphs link.
     *
     * Only the Client can render this: the registry is IndexedDB on this origin, so no other
     * application could enumerate it however the header is shared. `listGraphs` already hides
     * records whose membership check last failed, so this shows exactly what the picker shows.
     *
     * Re-read on every navigation rather than cached for the session: creating, importing,
     * renaming and forgetting all land somewhere, and a stale switcher is worse than a cheap
     * IndexedDB read.
     *
     * Every row is painted in its graph's toolbar colour (Graph Settings, ADR 0071) when one is
     * known, so a graph can be told apart here the way its bar tells it apart in the workspace.
     * The open graph's colour is the live one the workspace publishes; the others come from the
     * registry record's cache, refreshed each time a graph is opened or its settings saved, so a
     * graph never opened on this device since it was coloured shows no colour until it is. The
     * open graph is marked by a tick and `aria-current`, since colour alone no longer says which
     * row is open. The name's ink is chosen by the colour's luminance so it reads on any pick.
     */
    import { onMount } from "svelte";

    import { afterNavigate } from "$app/navigation";
    import { page } from "$app/state";
    import { inkFor } from "$lib/contrast-ink";
    import { createIdbGraphRegistry, type GraphRecord } from "$lib/storage";
    import { iconSvg } from "$lib/surface/icons";
    import { graphAccentFor } from "$lib/workspace/graph-accent.svelte";

    // Nothing here closes the menu by hand: the header does that on `afterNavigate`, so a link
    // is never torn out of the DOM by its own click handler on the way to the destination.

    let graphs = $state.raw<GraphRecord[]>([]);
    let loaded = $state(false);

    async function load(): Promise<void> {
        try {
            graphs = await createIdbGraphRegistry().listGraphs();
        } catch {
            // A registry that will not open is not worth an error here; the picker owns that
            // conversation, and "All graphs" below still reaches it.
            graphs = [];
        }
        loaded = true;
    }

    function isCurrent(id: string): boolean {
        return page.url.pathname === `/g/${id}` || page.url.pathname.startsWith(`/g/${id}/`);
    }

    /** Each row with its colour, in list order: live for the open graph, cached for the rest. */
    const rows = $derived(
        graphs.map((graph) => ({ graph, accent: graphAccentFor(graph.id, graph.toolbarColor) })),
    );

    /**
     * A coloured row's corners. Rounded like every row, except on an edge it shares with another
     * coloured row: consecutive colours then meet edge to edge as one banded block rather than a
     * stack of separate pills, which is how a strip of colour swatches reads.
     */
    function cornerClass(index: number): string {
        const above = index > 0 && rows[index - 1].accent !== null;
        const below = index < rows.length - 1 && rows[index + 1].accent !== null;
        if (above && below) return "rounded-none";
        if (above) return "rounded-b-lg";
        if (below) return "rounded-t-lg";
        return "rounded-lg";
    }

    onMount(() => {
        void load();
    });

    afterNavigate(() => {
        void load();
    });
</script>

<div class="p-2">
    <p class="px-3 pb-1 pt-1 text-sm font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        On this device
    </p>
    {#if loaded && graphs.length === 0}
        <p data-testid="graph-menu-empty" class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
            No graphs yet.
        </p>
    {:else}
        {#each rows as { graph, accent }, index (graph.id)}
            {@const current = isCurrent(graph.id)}
            <!-- Inline styles win over the classes, so on a coloured row the theme's own
                 highlight and hover are simply left off rather than fought; a brightness
                 shift stands in for hover there. -->
            <a
                href="/g/{graph.id}"
                aria-current={current ? "page" : undefined}
                class="flex items-center gap-2 px-3 py-2 text-sm transition-colors {current ? 'font-semibold' : 'font-medium'} {accent
                    ? `${cornerClass(index)} hover:brightness-95 dark:hover:brightness-110`
                    : current
                      ? 'rounded-lg bg-gray-100 text-gray-950 dark:bg-white/10 dark:text-white'
                      : 'rounded-lg text-gray-700 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white'}"
                style:background-color={accent}
                style:color={accent ? inkFor(accent) : null}
                title={graph.name}
                data-testid="graph-menu-row"
            >
                <span class="min-w-0 flex-1 truncate">{graph.name}</span>
                {#if current}
                    <!-- Decorative: `aria-current` already says it. In-repo constant markup from
                         the icon table, never user content. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    <span class="shrink-0" data-testid="graph-menu-current">{@html iconSvg("check", { size: 14 })}</span>
                {/if}
            </a>
        {/each}
    {/if}
</div>
<div class="border-t border-gray-950/5 p-2 dark:border-white/10">
    <a
        href="/graphs"
        class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
    >
        All Graphs
    </a>
</div>
