<script lang="ts" module>
    import type { PlainFolderRecord as HeldFolder } from "#lib/plain/plain-folder-registry.js";
    import type { GraphGroup as HeldGroup } from "#lib/storage/index.js";

    /**
     * What the menu last read on this page. The menu is built each time it opens, and reads the
     * registries again each time; a reopened menu draws what it read last at once, so its rows
     * are in place from the first frame and the fresh read changes only what changed.
     */
    let lastRead: { groups: HeldGroup[]; plainFolders: HeldFolder[] } | null = null;
</script>

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
     * A group is one block of rows that meet edge to edge (`graph-menu-band.ts`). Every row is
     * painted in its graph's toolbar colour (Graph Settings, ADR 0071) when one is known, so a
     * graph can be told apart here the way its bar tells it apart in the workspace, and in the
     * theme's neutral fill when none is, so a graph with no colour still reads as one of the group.
     * The open graph's colour is the live one the workspace publishes; the others come from the
     * registry record's cache, refreshed each time a graph is opened or its settings saved, so a
     * graph never opened on this device since it was coloured shows no colour until it is. The
     * open graph is marked by a tick and `aria-current`, since colour alone no longer says which
     * row is open. Which graph is open is the workspace's to say, by id: two folder graphs kept in
     * folders with one name have one address (ADR 0192), so the address would mark both, and a
     * link to it would not say which to open. A row therefore carries its graph to the workspace
     * with the navigation (chosen-graph.ts). The name's ink is chosen by the colour's luminance so it reads on any pick.
     *
     * The Plain Folders this device holds (ADR 0194) come last, in a group of their own. A Plain
     * Folder is not a graph, so its rows are not the graphs' band: each is an ordinary menu row
     * with a folder icon and no colour. The open one is marked the same way, by the workspace's
     * word and not the address, since two folders can share a name as two Folder graphs can.
     */
    import { onMount } from "svelte";

    import { afterNavigate, goto } from "$app/navigation";
    import { page } from "$app/state";
    import { bandCornerClass } from "#lib/components/graph-menu-band.js";
    import { inkFor } from "#lib/contrast-ink.js";
    import { graphUrl } from "#lib/navigation/document-url.js";
    import { currentGraphId, graphAddressOf, parseGraphAddressPath } from "#lib/navigation/graph-address.js";
    import { queueHistoryWrite } from "#lib/navigation/history-writes.js";
    import { chosenPlainFolderState, plainFolderUrl } from "#lib/plain/plain-address.js";
    import { createIdbPlainFolderRegistry } from "#lib/plain/plain-folder-registry-idb.js";
    import type { PlainFolderRecord } from "#lib/plain/plain-folder-registry.js";
    import { plainSession } from "#lib/plain/plain-session.svelte.js";
    import { createIdbGraphRegistry, type GraphGroup, type GraphRecord } from "#lib/storage/index.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { serverHost } from "#lib/sync/sync-connections.js";
    import { chosenGraphState } from "#lib/workspace/chosen-graph.js";
    import { graphAccentFor } from "#lib/workspace/graph-accent.svelte.js";
    import { graphGroups } from "#lib/workspace/graph-order-state.js";
    import { openGraphId } from "#lib/workspace/open-graph-id.svelte.js";

    // Nothing here closes the menu by hand: the header does that on `afterNavigate`, so a link
    // is never torn out of the DOM by its own click handler on the way to the destination.

    let groups = $state.raw<GraphGroup[]>(lastRead?.groups ?? []);
    let plainFolders = $state.raw<PlainFolderRecord[]>(lastRead?.plainFolders ?? []);
    /**
     * Whether there is a list to draw. Until the first read lands, the menu draws nothing, not
     * even All Graphs: drawn alone, the rows would arrive above it and push it from under the
     * pointer. An IndexedDB read takes a few milliseconds.
     */
    let loaded = $state(lastRead !== null);
    const labelId = $props.id();

    async function load(): Promise<void> {
        // Two registries, read together: a slow one does not hold the other's rows back for long,
        // and neither failing empties the other's group.
        const [graphs, folders] = await Promise.allSettled([createIdbGraphRegistry().listGraphs(), createIdbPlainFolderRegistry().list()]);
        // A registry that will not open is not worth an error here; the picker owns that
        // conversation, and "All graphs" below still reaches it.
        groups = graphs.status === "fulfilled" ? graphGroups(graphs.value) : [];
        plainFolders = folders.status === "fulfilled" ? folders.value : [];
        lastRead = { groups, plainFolders };
        loaded = true;
    }

    /**
     * The graph the page is in: the one the workspace has open, and before it has one, the graph
     * the address names when it names only one. While a link is asking which of two folders with
     * one name is meant, no row is marked.
     */
    const currentId = $derived(
        currentGraphId(
            parseGraphAddressPath(page.url.pathname)?.address ?? null,
            openGraphId.current,
            groups.flatMap((group) => group.graphs),
        ),
    );

    /**
     * Follow a row with its graph in the history entry, so the workspace opens that graph and not
     * whichever shares its address. A click that opens another tab or window is the browser's: it
     * carries no state, and the new tab asks, as any link from outside does.
     */
    function follow(event: MouseEvent, graph: GraphRecord): void {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        // Queued behind the workspace's own history writes, so none of them lands on the graph this opens.
        void queueHistoryWrite(() => goto(graphUrl(graphAddressOf(graph)), { state: chosenGraphState(graph) }));
    }

    /** The same for a Plain Folder's row: the workspace opens the folder that was pressed, not another with its name. */
    function followFolder(event: MouseEvent, folder: PlainFolderRecord): void {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void queueHistoryWrite(() => goto(plainFolderUrl(folder.name), { state: chosenPlainFolderState(folder) }));
    }

    /** A group's graphs with their colours, in list order: live for the open graph, cached for the rest. */
    function rowsOf(group: GraphGroup) {
        return group.graphs.map((graph) => ({ graph, accent: graphAccentFor(graph.id, graph.toolbarColor) }));
    }

    /** What the group is called. A server is named only where there is another to tell it from. */
    function labelOf(group: GraphGroup): string {
        if (group.origin === null) return "Folder graphs";
        const servers = groups.filter((other) => other.origin !== null).length;
        return servers > 1 ? `Synced graphs on ${serverHost(group.origin)}` : "Synced graphs";
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

{#if loaded}
<div>
    {#if groups.length === 0}
        <p data-testid="graph-menu-empty" class="px-3 py-1.5 text-sm text-(--gk-text-muted)">
            No graphs yet.
        </p>
    {:else}
        {#each groups as group, groupIndex (group.origin)}
            {@const rows = rowsOf(group)}
            {@const label = labelOf(group)}
            {#if groupIndex > 0}<hr class="gk-menu-separator separator" />{/if}
            <!-- Inset, so the group's rows read as one block with rounded ends (graph-menu-band.ts). -->
            <div role="group" aria-labelledby="{labelId}-{groupIndex}" class="px-2 pb-1">
                <p
                    id="{labelId}-{groupIndex}"
                    data-testid="graph-menu-group-label"
                    title={label}
                    class="truncate px-1 py-1 text-sm font-semibold uppercase tracking-wider text-(--gk-text-muted)"
                >
                    {label}
                </p>
                {#each rows as { graph, accent }, index (graph.id)}
                    {@const current = graph.id === currentId}
                    <!-- A menu row (`gk-menu-item`) with the band's corners. Inline styles win over the
                         classes, so a coloured row drops the theme's fill and hover rather than
                         fighting them; a brightness shift stands in for hover there. A row with no
                         colour takes the menu's neutral fill, a step stronger on hover and on the
                         open graph. -->
                    <a
                        href={graphUrl(graphAddressOf(graph))}
                        onclick={(event) => follow(event, graph)}
                        aria-current={current ? "page" : undefined}
                        class={[
                            "gk-menu-item",
                            bandCornerClass(index, rows.length),
                            current ? "font-semibold" : "font-medium",
                            accent
                                ? "hover:brightness-95 dark:hover:brightness-110"
                                : current
                                  ? "bg-(--gk-selection) text-(--gk-text-strong)"
                                  : "bg-(--gk-menu-hover) hover:bg-(--gk-selection)",
                        ]}
                        style:background-color={accent}
                        style:color={accent ? inkFor(accent) : null}
                        title={graph.name}
                        data-testid="graph-menu-row"
                        data-graph-id={graph.id}
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
    {#if plainFolders.length > 0}
        {@const openFolderId = plainSession.current?.id ?? null}
        <hr class="gk-menu-separator" />
        <div role="group" aria-labelledby="{labelId}-plain" class="px-2 pb-1">
            <p id="{labelId}-plain" data-testid="plain-folder-menu-label" class="truncate px-1 py-1 text-sm font-semibold uppercase tracking-wider text-(--gk-text-muted)">Plain Folders</p>
            {#each plainFolders as folder (folder.id)}
                {@const current = folder.id === openFolderId}
                <a
                    href={plainFolderUrl(folder.name)}
                    onclick={(event) => followFolder(event, folder)}
                    aria-current={current ? "page" : undefined}
                    class={["gk-menu-item rounded-lg", current ? "bg-(--gk-selection) font-semibold text-(--gk-text-strong)" : "font-medium"]}
                    title={folder.name}
                    data-testid="plain-folder-menu-row"
                    data-folder-id={folder.id}
                >
                    <!-- Decorative: the group's label says what these are. In-repo constant markup from the icon table. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    <span class="shrink-0 text-(--gk-text-muted)" aria-hidden="true">{@html iconSvg("folder", { size: 16 })}</span>
                    <span class="min-w-0 flex-1 truncate">{folder.name}</span>
                    {#if current}
                        <!-- Decorative: `aria-current` already says it. The same constant markup. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        <span class="shrink-0" data-testid="plain-folder-menu-current">{@html iconSvg("check", { size: 14 })}</span>
                    {/if}
                </a>
            {/each}
        </div>
    {/if}
</div>
<hr class="gk-menu-separator separator separator--above-row" />
<a href="/graphs" class="gk-menu-item">All Graphs</a>
{/if}

<style>
    /* In the phone's navigation drawer (`data-drawer-submenu`, ApplicationHeader) this menu hangs
       off a guide line, its rows 1rem to the right of it. A divider there spans the rows rather
       than the indent beside them (the group's 0.5rem), with the same 1rem between it and the rows
       above and below: 0.75rem here, as the group's own 0.25rem foot and the label's 0.25rem top
       make up the rest. The dropdown on a wider screen keeps the menu's full-width dividers. */
    :global([data-drawer-submenu]) .separator {
        margin: 0.75rem 0.5rem;
    }
    /* All Graphs is a row of words, whose own 0.375rem padding makes up the rest of its 1rem. */
    :global([data-drawer-submenu]) .separator--above-row {
        margin-bottom: 0.625rem;
    }
</style>
