<script lang="ts">
    /**
     * The [[Plain Folder]]s of this device on the Graphs page, in a section of their own (ADR 0194).
     *
     * They are listed apart from the graphs because they are not graphs: the section says so in a
     * sentence, so nobody expects wikilinks, backlinks or a journal from one. A card is drawn as a
     * Folder graph's is (graph-card.ts), with Open as its one primary action. With no folder yet the
     * section says so and opens one (plain-folders-section.ts).
     */
    import ConfirmDialog from '@appsoftwareltd/etherpk-shared/confirm-dialog'

    import { CARD_ICONS, CARD_WORDS, GRAPH_CARD, NOT_SYNCED_NOTE } from '#lib/workspace/graph-card.js'

    import type { PlainFolderRecord } from '../plain-folder-registry'
    import { type PlainFoldersListing, plainFoldersSection } from '../plain-folders-section'

    let {
        folders,
        listing,
        canOpen,
        message = null,
        onopenfolder,
        onopen,
        onforget,
    }: {
        folders: readonly PlainFolderRecord[]
        listing: PlainFoldersListing
        /** The browser can open a folder. */
        canOpen: boolean
        /** The outcome of the last action on one folder, shown on its card. */
        message?: { id: string; text: string; tone: 'info' | 'error' } | null
        /** Choose a folder on this device, to open as a Plain Folder. */
        onopenfolder: () => void
        onopen: (folder: PlainFolderRecord) => void
        onforget: (folder: PlainFolderRecord) => void
    } = $props()

    const shown = $derived(plainFoldersSection({ count: folders.length, listing, canOpen }))

    let forgetting = $state.raw<PlainFolderRecord | null>(null)
    let confirmOpen = $state(false)

    function askForget(folder: PlainFolderRecord): void {
        forgetting = folder
        confirmOpen = true
    }
</script>

{#if shown !== 'hidden'}
    <section data-testid="plain-folders" aria-labelledby="plain-folders-heading" class="space-y-3">
        <div>
            <h2 id="plain-folders-heading" class="flex items-center gap-2 text-lg font-semibold text-neutral-950 dark:text-white">
                Plain Folders
                <span class={NOT_SYNCED_NOTE}>(not synced)</span>
            </h2>
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Folders of plain markdown and other file types on this device (Note: These are not EtherPK graphs and have no wikilinks, backlinks or journal)
            </p>
        </div>
        {#if shown === 'list'}
            <ul class="space-y-3" data-testid="plain-folders-list">
                {#each folders as folder (folder.id)}
                    <li data-testid="plain-folder-card" data-folder-id={folder.id} class={GRAPH_CARD}>
                        <div class="flex flex-wrap items-center gap-2 px-4 py-3">
                            <div class={CARD_WORDS}>
                                <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
                                    <span data-testid="plain-folder-name" class="truncate text-sm font-medium text-neutral-950 dark:text-white">{folder.name}</span>
                                    <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600 dark:bg-white/10 dark:text-neutral-400">Plain Folder</span>
                                </span>
                            </div>
                            <button type="button" data-testid="plain-folder-open" aria-label={`Open ${folder.name}`} class="gk-button gk-button--primary shrink-0" onclick={() => onopen(folder)}>
                                Open
                            </button>
                            <div class={CARD_ICONS}>
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
        {:else if shown === 'unreadable'}
            <p
                data-testid="plain-folders-unreadable"
                class="rounded-xl border border-red-200 px-4 py-6 text-center text-sm text-red-600 dark:border-red-500/30 dark:text-red-400"
            >
                Your Plain Folders could not be read from this browser's storage. Nothing has been deleted. Reload the page to try again.
            </p>
        {:else}
            <div data-testid="plain-folders-empty" class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-white/10 dark:bg-white/5">
                <p class="text-sm text-neutral-700 dark:text-neutral-300">No Plain Folders on this device yet. The ones you open are listed here.</p>
                <button type="button" data-testid="plain-folders-open-folder" class="gk-button mt-3" onclick={onopenfolder}>Open a Plain Folder</button>
            </div>
        {/if}
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
