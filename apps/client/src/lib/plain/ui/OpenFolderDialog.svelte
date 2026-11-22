<script lang="ts">
    /**
     * The question a chosen folder raises when it is not already a graph (ADR 0194): open it as a
     * [[Plain Folder]], create a graph in it, or import it into a new graph. An empty folder is asked
     * the first two only.
     *
     * One dialog and no wizard. The choice the folder itself suggests is selected, each choice says
     * what EtherPK will write, and nothing has been written when this opens.
     */
    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import type { FolderChoice, FolderVerdict } from '../classify-folder'
    import { folderFound, folderSentence } from '../folder-summary'

    let {
        name,
        verdict,
        busy = false,
        error = null,
        onchoose,
        onclose,
    }: {
        /** The folder's own name. */
        name: string
        verdict: Extract<FolderVerdict, { kind: 'ask' }>
        /** The choice is being carried out. */
        busy?: boolean
        error?: string | null
        onchoose: (choice: FolderChoice) => void
        onclose: () => void
    } = $props()

    // svelte-ignore state_referenced_locally (the dialog opens for one folder, with the choice it suggests selected)
    let choice = $state<FolderChoice>(verdict.preferred)

    const OPTIONS: Record<FolderChoice, { title: string; emptyTitle: string; text: string; emptyText: string }> = {
        plain: {
            title: 'Open as a Plain Folder',
            emptyTitle: 'A Plain Folder',
            text: 'Edit the files where they are. EtherPK adds nothing to this folder and changes only the files you edit.',
            emptyText: 'Markdown files in folders you arrange. EtherPK adds nothing until you create a file.',
        },
        graph: {
            title: 'Create a graph in this folder',
            emptyTitle: 'A new graph',
            text: 'Adds journals, pages, assets and etherpk folders and an AGENTS.md here. Your files stay where they are.',
            emptyText: 'Journal entries, pages, wikilinks and backlinks. EtherPK adds journals, pages, assets and etherpk folders.',
        },
        import: {
            title: 'Import into a new graph',
            emptyTitle: 'Import into a new graph',
            text: 'Copies the files into a new graph with wikilinks, backlinks and search. This folder stays as it is.',
            emptyText: '',
        },
    }

    const found = $derived(folderFound(verdict.probe))
    const submit = () => {
        if (!busy) onchoose(choice)
    }
</script>

<Dialog open title={`Open “${name}”`} testId="open-folder-dialog" {busy} busyReason="Opening the folder…" {onclose} onsubmit={submit}>
    {#snippet body()}
        <p class="text-sm text-(--gk-text-default)" data-testid="open-folder-sentence">{folderSentence(verdict.probe)}</p>
        <fieldset class="choices">
            <legend class="sr-only">What to open this folder as</legend>
            {#each verdict.choices as option (option)}
                <label class="choice">
                    <input type="radio" name="open-folder-choice" value={option} bind:group={choice} data-testid={`open-folder-${option}`} />
                    <span>
                        <span class="title">{verdict.empty ? OPTIONS[option].emptyTitle : OPTIONS[option].title}</span>
                        <span class="text">{verdict.empty ? OPTIONS[option].emptyText : OPTIONS[option].text}</span>
                    </span>
                </label>
            {/each}
        </fieldset>
        {#if found}
            <p class="gk-hint" data-testid="open-folder-found">{found}</p>
        {/if}
        {#if error}
            <p class="gk-error" role="alert" data-testid="open-folder-error">{error}</p>
        {/if}
    {/snippet}
    {#snippet footer()}
        <button type="button" class="gk-button" onclick={onclose}>Cancel</button>
        <button type="submit" class="gk-button gk-button--primary" data-testid="open-folder-confirm">Open</button>
    {/snippet}
</Dialog>

<style>
    .choices {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin: 0;
        padding: 0;
        border: 0;
    }
    .choice {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        font-size: 0.875rem;
        line-height: 1.25rem;
        cursor: pointer;
    }
    .choice input {
        flex: none;
        width: 1rem;
        height: 1rem;
        margin: 0.125rem 0 0;
        accent-color: var(--gk-primary-bg);
    }
    .title {
        display: block;
        font-weight: 500;
        color: var(--gk-text-strong);
    }
    .text {
        display: block;
        color: var(--gk-text-muted);
    }
</style>
