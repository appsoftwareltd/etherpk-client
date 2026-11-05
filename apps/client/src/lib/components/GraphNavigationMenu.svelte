<script lang="ts">
    /**
     * The graphs on this device, listed under the header's Graphs link, in the groups and the Graph
     * Order the Graphs page shows them in, each group under a label.
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
    import { inkFor } from "#lib/contrast-ink.js";
    import { createIdbGraphRegistry, type GraphGroup } from "#lib/storage/index.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { serverHost } from "#lib/sync/sync-connections.js";
    import { graphAccentFor } from "#lib/workspace/graph-accent.svelte.js";
    import { graphGroups } from "#lib/workspace/graph-order-state.js";

    // Nothing here closes the menu by hand: the header does that on `afterNavigate`, so a link
    // is never torn out of the DOM by its own click handler on the way to the destination.

    let groups = $state.raw<GraphGroup[]>([]);
    let loaded = $state(false);
    const labelId = $props.id();

    async function load(): Promise<void> {
        try {
            groups = graphGroups(await createIdbGraphRegistry().listGraphs());
        } catch {
            // A registry that will not open is not worth an error here; the picker owns that
            // conversation, and "All graphs" below still reaches it.
            groups = [];
        }
        loaded = true;
    }

    function isCurrent(id: string): boolean {
        return page.url.pathname === `/g/${id}` || page.url.pathname.startsWith(`/g/${id}/`);
    }

    /** A group's graphs with their colours, in list order: live for the open graph, cached for the rest. */
    function rowsOf(group: GraphGroup) {
        return group.graphs.map((graph) => ({ graph, accent: graphAccentFor(graph.id, graph.toolbarColor) }));
    }

    /** What the group is called. A server is named only where there is another to tell it from. */
    function labelOf(group: GraphGroup): string {
        if (group.origin === null) return "Local graphs";
        const servers = groups.filter((other) => other.origin !== null).length;
        return servers > 1 ? `Synced graphs on ${serverHost(group.origin)}` : "Synced graphs";
    }

    /**
     * A coloured row's corners. Rounded like every row, except on an edge it shares with another
     * coloured row: consecutive colours then meet edge to edge as one banded block rather than a
     * stack of separate pills, which is how a strip of colour swatches reads. A group's label stands
     * between groups, so only the rows of one group ever meet.
     */
    function cornerClass(rows: ReadonlyArray<{ accent: string | null }>, index: number): string {
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

    afterNavigate(({ shallow, type }) => {
        // A shallow entry is not a page change (it runs the navigation hooks since SvelteKit 3).
        if (shallow && type === "goto") return;
        void load();
    });
</script>

<div class="space-y-3 p-2">
    {#if loaded && groups.length === 0}
        <p data-testid="graph-menu-empty" class="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400">
            No graphs yet.
        </p>
    {:else}
        {#each groups as group, groupIndex (group.origin)}
            {@const rows = rowsOf(group)}
            {@const label = labelOf(group)}
            <div role="group" aria-labelledby="{labelId}-{groupIndex}">
                <p
                    id="{labelId}-{groupIndex}"
                    data-testid="graph-menu-group-label"
                    title={label}
                    class="truncate px-3 pb-1 pt-1 text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400"
                >
                    {label}
                </p>
                {#each rows as { graph, accent }, index (graph.id)}
                    {@const current = isCurrent(graph.id)}
                    <!-- Inline styles win over the classes, so on a coloured row the theme's own
                         highlight and hover are simply left off rather than fought; a brightness
                         shift stands in for hover there. -->
                    <a
                        href="/g/{graph.id}"
                        aria-current={current ? "page" : undefined}
                        class="flex items-center gap-2 px-3 py-2 text-sm transition-colors {current ? 'font-semibold' : 'font-medium'} {accent
                            ? `${cornerClass(rows, index)} hover:brightness-95 dark:hover:brightness-110`
                            : current
                              ? 'rounded-lg bg-neutral-100 text-neutral-950 dark:bg-white/10 dark:text-white'
                              : 'rounded-lg text-neutral-700 hover:bg-neutral-50 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white'}"
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
            </div>
        {/each}
    {/if}
</div>
<div class="border-t border-neutral-950/5 p-2 dark:border-white/10">
    <a
        href="/graphs"
        class="block rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white"
    >
        All Graphs
    </a>
</div>
