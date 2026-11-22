<script lang="ts">
    /**
     * A file of a [[Plain Folder]] that is not text, in a tab. It is drawn by the viewer a graph
     * uses for the same kind of file (a PDF's reader, an EBook's, a picture, a recording), and a
     * file with no viewer is named with a way to save a copy.
     */
    import type { ViewProps } from '#lib/layout/index.js'
    import type { ResolvedAsset } from '#lib/storage/fs/asset-store.js'
    import { assetViewerFor, tryGetActiveContributionRegistry } from '#lib/surface/index.js'

    import { fileKindOf } from '../file-kind'
    import { plainSession } from '../plain-session.svelte'
    import { baseName } from '../plain-path'

    let { view }: ViewProps = $props()

    const session = $derived(plainSession.current)
    const path = $derived(view.target)
    const kind = $derived(fileKindOf(path))

    let file = $state.raw<ResolvedAsset | null>(null)
    let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading')
    let failure = $state('')

    const Viewer = $derived.by(() => {
        const contributions = tryGetActiveContributionRegistry()
        return contributions ? assetViewerFor(contributions, baseName(path))?.component : undefined
    })

    const sameFile = (a: ResolvedAsset | null, b: ResolvedAsset | null) => a !== null && b !== null && a.url === b.url && a.name === b.name && a.type === b.type

    // The file's bytes come from the folder: read them when the tab opens, and again when the
    // folder may have changed.
    $effect(() => {
        const current = session
        const at = path
        if (!current) return
        void current.listingEpoch
        let stale = false
        current.media.resolvePath(at).then(
            (resolved) => {
                if (stale) return
                // A pass that finds the file as it was answers with an equal object, and the one
                // held is kept. A new one would run the viewer's effects again, and a reader
                // closes its file and opens it on that, every few seconds.
                if (!sameFile(file, resolved)) file = resolved
                phase = resolved ? 'ready' : 'missing'
            },
            (error: unknown) => {
                if (stale) return
                failure = error instanceof Error ? error.message : String(error)
                phase = 'failed'
            },
        )
        return () => {
            stale = true
        }
    })
</script>

<div class="plain-file" data-testid="plain-file" data-path={path} data-kind={kind}>
    {#if phase === 'loading'}
        <p class="note" role="status">Reading {baseName(path)}…</p>
    {:else if phase === 'missing'}
        <p class="note" data-testid="plain-file-missing">No file is at {path}.</p>
    {:else if phase === 'failed'}
        <p class="note" role="alert">Could not read {baseName(path)}: {failure}</p>
    {:else if file && Viewer}
        <div class="viewer">
            <Viewer url={file.url} name={file.name} type={file.type} target={path} />
        </div>
    {:else if file}
        <p class="note">EtherPK cannot show {file.name} here.</p>
        <p class="actions">
            <a class="gk-button" href={file.url} download={file.name} data-testid="plain-file-download">Save a copy</a>
        </p>
    {/if}
</div>

<style>
    .plain-file {
        height: 100%;
        overflow: auto;
        padding: 1rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .note {
        margin: 0 0 0.75rem;
        color: var(--gk-text-muted);
    }
    /* A viewer fills the tab and scrolls within itself, as it does in a graph's tab. */
    .plain-file:has(> .viewer) {
        padding: 0;
        overflow: hidden;
    }
    .viewer {
        display: flex;
        flex-direction: column;
        height: 100%;
    }
    .actions {
        margin: 0.75rem 0 0;
    }
</style>
