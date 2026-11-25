<script lang="ts">
    /**
     * The two icons after the name of a graph or a folder: on its Graphs page card, and on the
     * workspace toolbar while it is open (workspace-heading.ts).
     *
     * The first says what kind of thing it is: three linked nodes for a graph, a folder for a
     * [[Plain Folder]], a sheet for one file opened without its folder. The second says where it
     * is kept: the server stack for a Sync Server (the Style Guide's one picture for sync), the
     * desktop computer for this device. So a synced graph is nodes and a server, a Folder graph
     * nodes and a computer, and a Plain Folder a folder and a computer.
     *
     * A picture, not a control: the pair is named once for a screen reader ("Synced graph"), with
     * a tooltip of the same words. After a heading that says those words already (the Graphs
     * page's "Synced graphs", "Folder graphs" and "Plain Folders"), the pair is `decorative`: no
     * name and no tooltip, and 20px, the size of an icon beside a heading.
     */
    import { iconSvg } from '#lib/surface/icons.js'

    import { FOLDER_GRAPHS_ICON, FOLDER_ICON, SYNC_ICON } from './graphs-page-icons'
    import type { WorkspaceKind } from './workspace-heading'

    let {
        kind,
        coloured = false,
        decorative = false,
    }: {
        kind: WorkspaceKind
        /** Beside a heading that says the kind in words: unnamed, with no tooltip, and 20px. */
        decorative?: boolean
        /** On a surface whose ink is not the theme's (a band in the graph's own colour, the workspace toolbar): the icons take that ink, as the name does. */
        coloured?: boolean
    } = $props()

    /** 16px after a name, 20px beside a heading (Style Guide, Icons). */
    const size = $derived(decorative ? 20 : 16)
</script>

<!-- Heroicons outline at their own weight, 1.5 of 24. The table's icons are drawn to match: at
     16px a stroke of 1 is the same line. -->
{#snippet heroicon(d: string)}
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" {d} />
    </svg>
{/snippet}

<span
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : kind.words}
    aria-hidden={decorative ? 'true' : undefined}
    data-tooltip={decorative ? undefined : kind.words}
    data-testid="kind-icons"
    data-what={kind.what}
    data-kept={kind.kept}
    class={['inline-flex shrink-0 items-center gap-1', !coloured && 'text-neutral-500 dark:text-neutral-400']}
>
    <span class="inline-flex" data-testid="kind-icon-what">
        {#if kind.what === 'folder'}
            {@render heroicon(FOLDER_ICON)}
        {:else}
            <!-- In-repo constant markup from the icon table. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg(kind.what === 'graph' ? 'graph' : 'file-text', { size, strokeWidth: 1 })}
        {/if}
    </span>
    <span class="inline-flex" data-testid="kind-icon-kept">
        {@render heroicon(kind.kept === 'synced' ? SYNC_ICON : FOLDER_GRAPHS_ICON)}
    </span>
</span>
