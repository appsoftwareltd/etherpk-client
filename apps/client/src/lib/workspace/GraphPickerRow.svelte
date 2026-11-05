<script lang="ts">
    /**
     * A local graph's card on the Graphs page: a folder on this computer, or the demo. Open
     * is its one primary action; the name beside it is a label, not a second way in. Synced graphs
     * have a card of their own (SyncedGraphRow). A coloured graph's band takes its colour (graph-card.ts).
     */
    import { inkFor } from '#lib/contrast-ink.js'
    import { isDemoGraph } from '#lib/demo/demo-graph.js'
    import type { GraphRecord } from '#lib/storage/index.js'
    import GraphGrip, { type GraphGripProps } from './GraphGrip.svelte'
    import { BADGE_ON_COLOUR, GRAPH_CARD, ICON_ON_COLOUR, OPEN_ON_COLOUR } from './graph-card'
    import { OPEN_BUTTON, OPEN_ICON, RESET_ICON } from './graphs-page-icons'

    let {
        graph,
        grip = null,
        message = null,
        onopen,
        onrename,
        onsettings,
        onforget,
        onreset,
    }: {
        graph: GraphRecord
        /** Its handle in a list that can be put in order; null where there is nothing to order. */
        grip?: GraphGripProps | null
        /**
         * The outcome of the last action taken on THIS graph, reported here rather than in the
         * page banner: a rename or a permission refusal used to confirm itself well above the
         * row that was clicked (AGENTS.md rule 6).
         */
        message?: { text: string; tone: 'info' | 'error' } | null
        onopen: () => void
        onrename: () => void
        onsettings: () => void
        onforget: () => void
        /** The Demo Graph offers a reset where an ordinary graph offers forget (ADR 0069). */
        onreset?: () => void
    } = $props()

    const demo = $derived(isDemoGraph(graph.id))
    const accent = $derived(graph.toolbarColor ?? null)
    const ink = $derived(accent ? inkFor(accent) : null)
    /** The row's quieter text: the theme's grey, or on a colour the ink, since no grey can be promised to read there. */
    const quiet = $derived(accent ? '' : 'text-neutral-500 dark:text-neutral-400')

    const folderName = $derived.by(() => {
        const name = (graph.handle as { name?: unknown } | null)?.name
        return typeof name === 'string' && name !== '' ? name : null
    })
</script>

<div data-testid="graph-card" data-graph-id={graph.id} class={GRAPH_CARD}>
    <div
        data-testid="graph-band"
        class="flex flex-wrap items-center gap-2 px-4 py-3"
        style:background-color={accent}
        style:color={ink}
        style:--graph-colour={accent}
        style:--graph-ink={ink}
    >
    {#if grip}<GraphGrip {grip} coloured={accent !== null} />{/if}
    <!-- The basis keeps room for the name: on a narrow screen the controls drop to a line of their
         own rather than squeezing it away. -->
    <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
            <span data-testid="graph-card-name" class="truncate text-sm font-medium {accent ? '' : 'text-neutral-950 dark:text-white'}">{graph.name}</span>
            <span class={accent ? BADGE_ON_COLOUR : 'rounded-full bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600 dark:bg-white/10 dark:text-neutral-400'} data-testid="graphs-backend-tag">
                {demo ? 'Demo' : graph.backend === 'server' ? 'Synced' : 'Local'}
            </span>
        </span>
        {#if demo}
            <!-- The demo's reset is the only thing that can undo a visitor's edits, and it sits with
                 what says the demo is disposable rather than where an ordinary row's Forget goes. -->
            <span class="text-sm {quiet}">
                <span
                    data-testid="graphs-demo-hint"
                    title="The demo graph is stored in this browser only and is not backed up anywhere"
                >In this browser only</span>
                ·
                <button
                    type="button"
                    data-testid="graphs-demo-reset"
                    title="Reset the demo (puts every page back as it shipped)"
                    onclick={onreset}
                    class="font-medium underline underline-offset-2 pointer-coarse:min-h-11 {accent ? '' : 'text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white'}"
                >Reset the demo</button>
            </span>
        {:else if graph.backend !== 'server'}
            {#if folderName}
                <span
                    class="truncate text-sm {quiet}"
                    data-testid="graphs-folder-hint"
                    title="Folder on disk"
                >…/{folderName}</span>
            {/if}
        {:else}
            <span
                class="truncate text-sm {quiet}"
                data-testid="graphs-cache-hint"
                title="A synced graph's local copy is stored in the browser, not in a folder"
            >Local browser cache</span>
        {/if}
    </div>
    <div class="ml-auto flex items-center gap-2">
    <button data-testid="graphs-open" aria-label={`Open ${graph.name}`} onclick={onopen} class={accent ? OPEN_ON_COLOUR : OPEN_BUTTON}>
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d={OPEN_ICON} />
        </svg>
        Open
    </button>
    <button
        data-testid="graphs-rename"
        title={graph.backend === 'server'
            ? 'Rename (changes graph name for all members)'
            : 'Rename (changes display name only - folder on disk retains its name)'}
        aria-label="Rename graph"
        onclick={onrename}
        class={accent ? ICON_ON_COLOUR : 'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300'}
    >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
        </svg>
    </button>
    <button
        title={graph.backend === 'server'
            ? 'Graph settings (shared by all members)'
            : 'Graph settings'}
        aria-label="Graph settings"
        data-testid={graph.backend === 'server' ? 'graphs-synced-settings' : 'graphs-settings'}
        onclick={onsettings}
        class={accent ? ICON_ON_COLOUR : 'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300'}
    >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
    </button>
    {#if !demo}
    <button
        data-testid="graphs-remove"
        title={graph.backend === 'server'
            ? 'Forget this graph (deletes the local browser cache - does not delete the remote synced graph)'
            : 'Forget this graph (does not delete files)'}
        onclick={onforget}
        class={accent ? ICON_ON_COLOUR : 'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3.5 text-neutral-400 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-white/10'}
        aria-label="Forget graph"
    >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    </button>
    {:else}
    <!-- The demo cannot be forgotten, so its last slot resets it: the same as the link beside its
         hint, and it keeps the row's icons in line with every other row's. -->
    <button
        type="button"
        data-testid="graphs-demo-reset-icon"
        title="Reset the demo (puts every page back as it shipped)"
        aria-label="Reset the demo"
        onclick={onreset}
        class={accent ? ICON_ON_COLOUR : 'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-300'}
    >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d={RESET_ICON} />
        </svg>
    </button>
    {/if}
    </div>
    </div>
    {#if message}
        <!-- Below the band: red cannot be promised to read on a colour a person chose. -->
        <p
            data-testid="graphs-row-status"
            role={message.tone === 'error' ? 'alert' : 'status'}
            class="px-4 py-2 text-sm {message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'}"
        >{message.text}</p>
    {/if}
</div>
