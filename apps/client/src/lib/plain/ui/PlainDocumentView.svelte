<script lang="ts">
    /**
     * A text file of a [[Plain Folder]] in a tab: the editor, under a notice when the file is not
     * simply open and editable (ADR 0196).
     *
     * The editor is the graph's own `DocumentView`, running its plain profile. What it cannot say
     * for itself, this View says above it: nothing is at the path, the file was removed by another
     * program, or it opened read-only because it is not UTF-8 or is over the editing limit. Each
     * notice names what happened and what the person can do next.
     */
    import { untrack } from 'svelte'

    import DocumentView from '#lib/document/view/DocumentView.svelte'
    import type { ViewProps } from '#lib/layout/index.js'

    import { type PlainFileState } from '../plain-folder-store'
    import { plainSession } from '../plain-session.svelte'
    import { baseName, directoryHolding } from '../plain-path'

    let { view, panelId, visibility }: ViewProps = $props()

    const session = $derived(plainSession.current)

    /** The file's path now: it follows the file when the tree moves it. */
    let path = $state(untrack(() => view.target))
    let fileState = $state.raw<PlainFileState | null>(null)
    let busy = $state(false)
    /** The directory holding a graph of its own that this file is in, when it is in one. */
    const graphDirectory = $derived(directoryHolding(session?.graphFolders ?? [], path))
    let failure = $state<string | null>(null)

    // The store tells every tab when a file's state changes; this one reads its own.
    $effect(() => {
        const store = session?.store
        if (!store) return
        const read = () => (fileState = store.stateOf(path))
        read()
        const offState = store.onStateChanged((changed) => {
            if (changed === path) read()
        })
        const offRename = store.onDocumentRenamed((from, to) => {
            if (from === path) {
                path = to
                read()
            }
        })
        return () => {
            offState()
            offRename()
        }
    })

    /** What the editor is mounted for: it reads whether it is read-only once, as it mounts. */
    const editorKey = $derived(`${fileState?.readOnly ?? 'editable'}:${graphDirectory ?? ''}`)

    function megabytes(bytes: number): string {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    async function run(action: () => Promise<void> | void): Promise<void> {
        if (busy) return
        busy = true
        failure = null
        try {
            await action()
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
        } finally {
            busy = false
        }
    }
</script>

<div class="plain-document" data-testid="plain-document" data-path={path}>
    {#if fileState?.missing}
        <div class="notice" role="status" data-testid="plain-file-missing">
            <p>No file is at <span class="path">{path}</span>.</p>
            <button type="button" class="gk-button gk-button--small" aria-disabled={busy} onclick={() => run(() => session?.store.restore(path))}>Create it</button>
        </div>
    {:else if fileState?.removedElsewhere}
        <div class="notice" role="status" data-testid="plain-file-removed">
            <p>
                {baseName(path)} was deleted outside EtherPK. {fileState.dirty ? 'Your unsaved changes are kept in this tab.' : 'Its text is kept in this tab.'}
            </p>
            <button type="button" class="gk-button gk-button--small" data-testid="plain-file-restore" aria-disabled={busy} onclick={() => run(() => session?.store.restore(path))}
                >Restore the file</button
            >
        </div>
    {:else if graphDirectory !== null}
        <div class="notice" role="status" data-testid="plain-file-in-graph">
            <p>This file belongs to the graph kept in <span class="path">{graphDirectory}</span>, so it is shown read-only here. Open the graph to edit it.</p>
            <button type="button" class="gk-button gk-button--small" data-testid="plain-file-open-graph" onclick={() => session?.openAsGraph(graphDirectory)}>Open as a graph</button>
        </div>
    {:else if fileState?.readOnly === 'not-utf8'}
        <div class="notice" role="status" data-testid="plain-file-read-only">
            <p>This file is not UTF-8 text, so it is shown read-only. Saving it here would change bytes you did not edit.</p>
        </div>
    {:else if fileState?.readOnly === 'too-large'}
        <div class="notice" role="status" data-testid="plain-file-too-large">
            <p>This file is {megabytes(fileState.size)}, over the 2 MB EtherPK edits comfortably, so it is not loaded.</p>
            <button type="button" class="gk-button gk-button--small" data-testid="plain-file-edit-anyway" onclick={() => session?.store.editAnyway(path)}>Open it anyway</button>
        </div>
    {:else if fileState && !fileState.loaded && fileState.error}
        <div class="notice" role="alert" data-testid="plain-file-unreadable">
            <p>Could not read {baseName(path)}: {fileState.error instanceof Error ? fileState.error.message : String(fileState.error)}</p>
            <button type="button" class="gk-button gk-button--small" aria-disabled={busy} onclick={() => run(() => session?.store.reconcile())}>Try again</button>
        </div>
    {/if}
    {#if failure}
        <p class="failure" role="alert">{failure}</p>
    {/if}
    <div class="editor">
        {#if fileState?.readOnly !== 'too-large'}
            {#key editorKey}
                <DocumentView {view} {panelId} {visibility} />
            {/key}
        {/if}
    </div>
</div>

<style>
    .plain-document {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    .editor {
        flex: 1;
        min-height: 0;
    }
    .notice {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.75rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-warning-surface);
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .notice p {
        flex: 1 1 16rem;
        margin: 0;
    }
    .path {
        font-family: ui-monospace, monospace;
    }
    .failure {
        margin: 0;
        padding: 0.5rem 0.75rem;
        color: var(--gk-text-danger);
        font-size: 0.875rem;
    }
</style>
