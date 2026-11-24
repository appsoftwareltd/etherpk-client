<script lang="ts">
    /**
     * The icon after a graph's name on its Graphs page card, saying where the graph is kept: the
     * server stack for a synced graph (the Style Guide's one picture for sync), a folder for a
     * Folder graph. It took the place of the "Folder" tag, and says the same of a synced graph,
     * whose card said it only by the group it was listed in.
     *
     * A picture, not a control: named for a screen reader, with a tooltip of the same words.
     */
    import { FOLDER_ICON, SYNC_ICON } from './graphs-page-icons'

    let {
        kind,
        coloured = false,
    }: {
        kind: 'synced' | 'folder'
        /** On a band in the graph's own colour, where the icon takes the band's ink as the name does. */
        coloured?: boolean
    } = $props()

    const words = $derived(kind === 'synced' ? 'Synced graph' : 'Folder graph')
</script>

<span
    role="img"
    aria-label={words}
    data-tooltip={words}
    data-testid="graph-kind-icon"
    data-kind={kind}
    class={['inline-flex shrink-0', !coloured && 'text-neutral-500 dark:text-neutral-400']}
>
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d={kind === 'synced' ? SYNC_ICON : FOLDER_ICON} />
    </svg>
</span>
