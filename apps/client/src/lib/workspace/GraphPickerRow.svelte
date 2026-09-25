<script lang="ts">
    import { isDemoGraph } from '$lib/demo/demo-graph'
    import type { GraphRecord } from '$lib/storage'

    let {
        graph,
        message = null,
        onopen,
        onrename,
        onsettings,
        onforget,
    }: {
        graph: GraphRecord
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

    const folderName = $derived.by(() => {
        const name = (graph.handle as { name?: unknown } | null)?.name
        return typeof name === 'string' && name !== '' ? name : null
    })
</script>

<li class="px-4 py-3">
    {#if message}
        <p
            data-testid="graphs-row-status"
            role={message.tone === 'error' ? 'alert' : 'status'}
            class="mb-2 text-sm {message.tone === 'error' ? 'text-red-600' : 'text-gray-600 dark:text-gray-400'}"
        >{message.text}</p>
    {/if}
    <div class="flex items-center gap-2">
    <button
        class="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        data-testid="graphs-open"
        onclick={onopen}
    >
        <span class="flex items-center gap-3">
            <span class="truncate text-sm font-medium text-gray-950 dark:text-white">{graph.name}</span>
            <span class="rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-600 dark:bg-white/10 dark:text-gray-400" data-testid="graphs-backend-tag">
                {demo ? 'Demo' : graph.backend === 'server' ? 'Synced' : 'Local'}
            </span>
        </span>
        {#if demo}
            <span
                class="truncate text-sm text-gray-400 dark:text-gray-500"
                data-testid="graphs-demo-hint"
                title="The demo graph lives in this browser's storage and is not backed up anywhere"
            >In this browser only</span>
        {:else if graph.backend !== 'server'}
            {#if folderName}
                <span
                    class="truncate text-sm text-gray-400 dark:text-gray-500"
                    data-testid="graphs-folder-hint"
                    title="Folder on disk"
                >…/{folderName}</span>
            {/if}
        {:else}
            <span
                class="truncate text-sm text-gray-400 dark:text-gray-500"
                data-testid="graphs-cache-hint"
                title="A synced graph's local copy lives in browser storage, not a folder"
            >Local browser cache</span>
        {/if}
    </button>
    <button
        data-testid="graphs-rename"
        title={graph.backend === 'server'
            ? 'Rename (changes graph name for all members)'
            : 'Rename (changes display name only; folder on disk retains its name)'}
        aria-label="Rename graph"
        onclick={onrename}
        class="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300"
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
        class="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300"
    >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
    </button>
    {#if demo}
    <button
        data-testid="graphs-demo-reset"
        title="Reset the demo (puts every page back as it shipped)"
        onclick={onreset}
        class="shrink-0 rounded-lg border border-gray-300 px-2 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5"
    >Reset</button>
    {:else}
    <button
        data-testid="graphs-remove"
        title={graph.backend === 'server'
            ? 'Forget this graph (deletes the local browser cache; does not delete the remote synced graph)'
            : 'Forget this graph (does not delete files)'}
        onclick={onforget}
        class="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-white/10"
        aria-label="Forget graph"
    >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    </button>
    {/if}
    </div>
</li>
