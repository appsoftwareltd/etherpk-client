<script lang="ts">
    /**
     * The [[Plain Folder]]s of this device on the Graphs page, in a section of their own (ADR 0194).
     *
     * They are listed apart from the graphs because they are not graphs: the section says so in a
     * sentence, so nobody expects wikilinks, backlinks or a journal from one. A card is drawn as a
     * Folder graph's is (graph-card.ts), with Open as its one primary action.
     */
    import ConfirmDialog from '@appsoftwareltd/etherpk-shared/confirm-dialog'

    import { GRAPH_CARD, NOT_SYNCED_NOTE } from '#lib/workspace/graph-card.js'

    import type { PlainFolderRecord } from '../plain-folder-registry'

    let {
        folders,
        message = null,
        onopen,
        onforget,
    }: {
        folders: readonly PlainFolderRecord[]
        /** The outcome of the last action on one folder, shown on its card. */
        message?: { id: string; text: string; tone: 'info' | 'error' } | null
        onopen: (folder: PlainFolderRecord) => void
        onforget: (folder: PlainFolderRecord) => void
    } = $props()

    let forgetting = $state.raw<PlainFolderRecord | null>(null)
    let confirmOpen = $state(false)

    function askForget(folder: PlainFolderRecord): void {
        forgetting = folder
        confirmOpen = true
    }
</script>

{#if folders.length > 0}
    <section data-testid="plain-folders" aria-labelledby="plain-folders-heading" class="space-y-3">
        <div>
            <h2 id="plain-folders-heading" class="flex items-center gap-2 text-lg font-semibold text-neutral-950 dark:text-white">
                Plain Folders
                <span class={NOT_SYNCED_NOTE}>(not synced)</span>
            </h2>
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Folders of markdown files on this device, edited where they are. They are not graphs: no wikilinks, backlinks or journal.
            </p>
        </div>
        <ul class="space-y-3" data-testid="plain-folders-list">
            {#each folders as folder (folder.id)}
                <li data-testid="plain-folder-card" data-folder-id={folder.id} class={GRAPH_CARD}>
                    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
                        <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
                            <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                                <span data-testid="plain-folder-name" class="truncate text-sm font-medium text-neutral-950 dark:text-white">{folder.name}</span>
                                <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600 dark:bg-white/10 dark:text-neutral-400">Plain Folder</span>
                            </span>
                        </div>
                        <div class="ml-auto flex items-center gap-2">
                            <button type="button" data-testid="plain-folder-open" aria-label={`Open ${folder.name}`} class="gk-button gk-button--primary shrink-0" onclick={() => onopen(folder)}>
                                Open
                            </button>
                            <button
                                type="button"
                                data-testid="plain-folder-forget"
                                class="gk-icon-button"
                                aria-label={`Forget ${folder.name} on this device`}
                                data-tooltip={`Forget ${folder.name} on this device`}
                                onclick={() => askForget(folder)}
                            >
                                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    {#if message?.id === folder.id}
                        <p
                            data-testid="plain-folder-status"
                            role={message.tone === 'error' ? 'alert' : 'status'}
                            class="px-4 py-2 text-sm {message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'}"
                        >
                            {message.text}
                        </p>
                    {/if}
                </li>
            {/each}
        </ul>
    </section>
{/if}

<ConfirmDialog
    bind:open={confirmOpen}
    title={`Forget “${forgetting?.name ?? ''}”?`}
    message="EtherPK forgets this folder on this device. The folder and every file in it stay exactly as they are."
    confirmLabel="Forget"
    onconfirm={() => {
        if (forgetting) onforget(forgetting)
        forgetting = null
    }}
    oncancel={() => (forgetting = null)}
/>
