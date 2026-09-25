<script lang="ts">
    /**
     * Dev harness for the Filesystem Backend (`/dev/filesystem`, 404 in production).
     *
     * Two surfaces:
     *  - **Adapter self-test** — runs the DirectoryAdapter round-trip over the
     *    Origin Private File System (no picker), scoped to its own subdir.
     *  - **Local folder** — the manual File System Access flow: pick a real
     *    directory, edit today's journal, create pages, reconcile external edits.
     *    The picked handle is remembered in IndexedDB so a refresh offers a
     *    one-click *reconnect* instead of re-picking (demonstrating the permission
     *    mitigation — the directory persists; only the grant needs re-confirming).
     */
    import { openDB } from 'idb'
    import { onMount } from 'svelte'

    import { DocumentView, setActiveAssetStore, setActiveDocumentStore } from '$lib/document'
    import { todayISO } from '$lib/document/calendar/month-grid-core'
    import {
        type DocumentConflict,
        type FilesystemDocumentStore,
        createAssetStore,
        createFilesystemDocumentStore,
        createWebFsDirectoryAdapter,
        ensurePermission,
        getOpfsRoot,
        isFsaSupported,
        pickGraphDirectory,
    } from '$lib/storage'
    import type { ViewRef } from '$lib/layout'

    // ── OPFS adapter self-test ────────────────────────────────────────────
    let opfsResult = $state('idle')
    let opfsBadge = $derived(
        opfsResult === 'PASS'
            ? 'ok'
            : opfsResult.startsWith('FAIL')
              ? 'bad'
              : opfsResult === 'running'
                ? 'run'
                : 'idle',
    )

    async function runOpfsSelfTest() {
        opfsResult = 'running'
        try {
            const root = await getOpfsRoot()
            await root.removeEntry('opfs-selftest', { recursive: true }).catch(() => {})
            const testRoot = await root.getDirectoryHandle('opfs-selftest', { create: true })
            const fs = createWebFsDirectoryAdapter(testRoot)
            await fs.ensureSkeleton()
            if ((await fs.list('pages')).length !== 0) throw new Error('skeleton not empty')
            const w1 = await fs.write('pages', 'A.md', 'one')
            if ((await fs.read('pages', 'A.md')).text !== 'one') throw new Error('round-trip mismatch')
            const w2 = await fs.write('pages', 'A.md', 'two')
            if (w2.lastModified < w1.lastModified) throw new Error('mtime went backwards')
            if ((await fs.read('pages', 'A.md')).text !== 'two') throw new Error('overwrite failed')
            await fs.remove('pages', 'A.md')
            let rejected = false
            try {
                await fs.read('pages', 'A.md')
            } catch {
                rejected = true
            }
            if (!rejected) throw new Error('read after remove did not reject')
            opfsResult = 'PASS'
        } catch (err) {
            opfsResult = `FAIL: ${(err as Error).message}`
        }
    }

    // ── Remember the last picked folder (the permission mitigation) ────────
    // The handle is structured-cloneable, so it survives a reload in IndexedDB;
    // on return we only need to re-grant permission (a gesture), never re-pick.
    async function devDb() {
        return openDB('etherpk-dev', 1, {
            upgrade: (db) => void db.createObjectStore('handles'),
        })
    }
    async function rememberHandle(handle: FileSystemDirectoryHandle) {
        await (await devDb()).put('handles', handle, 'last-folder')
    }
    async function recallHandle(): Promise<FileSystemDirectoryHandle | undefined> {
        return (await devDb()).get('handles', 'last-folder') as Promise<
            FileSystemDirectoryHandle | undefined
        >
    }

    // ── Manual Filesystem Backend flow ────────────────────────────────────
    const fsaSupported = isFsaSupported()
    let store: FilesystemDocumentStore | undefined = $state()
    let folderName = $state('')
    let todayTarget = $state('')
    let docs = $state<{ concept: string; kind: string }[]>([])
    let newPageTitle = $state('')
    let conflict = $state<DocumentConflict | null>(null)
    let status = $state('')
    let rememberedName = $state('') // a remembered folder awaiting one-click reconnect

    let view = $derived<ViewRef | null>(
        todayTarget ? { kind: 'document', target: todayTarget } : null,
    )
    let pageDocs = $derived(docs.filter((d) => d.kind === 'page'))
    let journalDocs = $derived(docs.filter((d) => d.kind === 'journal'))

    function refreshDocs() {
        docs = (store?.listDocuments() ?? []).map((e) => ({ concept: e.concept, kind: e.kind }))
    }

    /** Build the store over a granted handle and point at today's journal (creating nothing). */
    async function openWithHandle(handle: FileSystemDirectoryHandle) {
        const adapter = createWebFsDirectoryAdapter(handle)
        const s = createFilesystemDocumentStore(adapter, {
            onConflict: (c) => (conflict = c),
        })
        await s.scan()
        todayTarget = todayISO()
        store = s
        folderName = handle.name
        rememberedName = ''
        setActiveDocumentStore(s)
        setActiveAssetStore(createAssetStore(adapter))
        s.onDocumentsChanged(refreshDocs)
        refreshDocs()
        status = `Opened "${handle.name}". Today is ${todayTarget}.`
    }

    async function pickFolder() {
        try {
            const handle = await pickGraphDirectory()
            await createWebFsDirectoryAdapter(handle).ensureSkeleton()
            await rememberHandle(handle)
            await openWithHandle(handle)
        } catch (err) {
            status = `Pick cancelled or failed: ${(err as Error).message}`
        }
    }

    async function reconnect() {
        const handle = await recallHandle()
        if (!handle) return
        if (await ensurePermission(handle)) await openWithHandle(handle)
        else status = 'Permission was not granted.'
    }

    async function createPage() {
        if (!store || newPageTitle.trim() === '') return
        try {
            const concept = await store.createPage(newPageTitle.trim())
            newPageTitle = ''
            status = `Created page "${concept}".`
        } catch (err) {
            status = (err as Error).message
        }
    }

    async function reconcileNow() {
        await store?.reconcile()
        status = 'Reconciled with disk.'
    }

    async function resolve(choice: 'keep-mine' | 'take-disk') {
        if (!store || !conflict) return
        await store.resolveConflict(conflict.target, choice)
        conflict = null
    }

    /** Non-prompting permission check (safe without a user gesture, unlike request). */
    async function alreadyGranted(handle: FileSystemDirectoryHandle): Promise<boolean> {
        const h = handle as unknown as {
            // eslint-disable-next-line no-undef -- DOM lib type; no-undef does not see TS type space
            queryPermission?: (d: { mode: string }) => Promise<PermissionState>
        }
        return (await h.queryPermission?.({ mode: 'readwrite' })) === 'granted'
    }

    onMount(() => {
        // If a folder was remembered: auto-open when the grant survives (same
        // session), else offer a one-click reconnect. The folder is never re-picked.
        ;(async () => {
            if (!fsaSupported) return
            const handle = await recallHandle()
            if (!handle) return
            if (await alreadyGranted(handle)) await openWithHandle(handle)
            else rememberedName = handle.name
        })()
        return () => {
            setActiveDocumentStore(null)
            setActiveAssetStore(null)
        }
    })
</script>

<svelte:head><title>/dev/filesystem</title></svelte:head>

<div class="page">
    <header class="page-header">
        <h1>Filesystem Backend</h1>
        <p>Edit a real folder of markdown. Chromium-desktop only; see the subsystem doc.</p>
    </header>

    <div class="cards">
        <!-- Self-test card -->
        <section class="card">
            <h2>
                {@render beakerIcon()} Adapter self-test
            </h2>
            <p class="desc">
                Runs the <code>DirectoryAdapter</code> round-trip over OPFS (a real browser file
                system, no picker). Proves the adapter matches its in-memory contract.
            </p>
            <div class="row">
                <button class="btn btn--primary" data-testid="opfs-run" onclick={runOpfsSelfTest}>
                    {@render playIcon()} Run self-test
                </button>
                <span class="badge badge--{opfsBadge}" data-testid="opfs-result">{opfsResult}</span>
            </div>
        </section>

        <!-- Folder card -->
        <section class="card">
            <h2>{@render folderIcon()} Local folder</h2>

            {#if !fsaSupported}
                <p class="notice" data-testid="fsa-unsupported">
                    This browser has no directory picker. The Filesystem Backend needs the File
                    System Access API (Chromium-desktop only).
                </p>
            {:else if !store}
                <p class="desc">
                    Pick a folder for your graph. The choice is remembered across refreshes — only
                    the permission is re-confirmed (one click), never the folder.
                </p>
                <div class="row">
                    <button class="btn btn--primary" data-testid="fs-pick" onclick={pickFolder}>
                        {@render folderIcon()} Choose folder…
                    </button>
                    {#if rememberedName}
                        <button class="btn" data-testid="fs-reconnect" onclick={reconnect}>
                            {@render plugIcon()} Reconnect “{rememberedName}”
                        </button>
                    {/if}
                </div>
            {:else}
                <div class="folder-meta">
                    <span class="chip">{@render folderIcon()} {folderName}</span>
                    <span class="chip chip--muted">today · {todayTarget}</span>
                    <span class="chip chip--muted">{docs.length} docs</span>
                </div>
                <div class="toolbar">
                    <div class="field">
                        <input
                            data-testid="fs-new-page-title"
                            placeholder="New page title"
                            bind:value={newPageTitle}
                            onkeydown={(e) => e.key === 'Enter' && createPage()}
                        />
                        <button
                            class="btn btn--icon btn--primary"
                            title="Create page"
                            data-testid="fs-create-page"
                            onclick={createPage}
                            disabled={newPageTitle.trim() === ''}
                        >
                            {@render plusIcon()}
                        </button>
                    </div>
                    <button class="btn" data-testid="fs-reconcile" onclick={reconcileNow}>
                        {@render refreshIcon()} Reconcile
                    </button>
                </div>
                <ul class="doc-list" data-testid="fs-doc-list">
                    {#each journalDocs as doc (doc.concept)}
                        <li><span class="tag tag--j">journal</span> {doc.concept}</li>
                    {/each}
                    {#each pageDocs as doc (doc.concept)}
                        <li><span class="tag tag--p">page</span> {doc.concept}</li>
                    {/each}
                </ul>
            {/if}

            {#if status}<p class="status" data-testid="fs-status">{status}</p>{/if}
        </section>
    </div>

    <section class="editor" class:empty={!view}>
        {#if view}
            {#key view.target}
                <DocumentView {view} />
            {/key}
        {:else}
            <p class="placeholder">Open a folder to edit today's journal.</p>
        {/if}
    </section>
</div>

{#if conflict}
    <div class="conflict" data-testid="fs-conflict">
        {@render warnIcon()}
        <div class="conflict__body">
            <strong>“{conflict.target}” changed on disk</strong>
            <span>while you have unsaved edits. Keep yours, or take the disk version?</span>
        </div>
        <div class="conflict__actions">
            <button class="btn" data-testid="fs-keep-mine" onclick={() => resolve('keep-mine')}>
                Keep mine
            </button>
            <button class="btn btn--primary" data-testid="fs-take-disk" onclick={() => resolve('take-disk')}>
                Take disk
            </button>
        </div>
    </div>
{/if}

<!-- Inline icons (Heroicons-style, 1em) -->
{#snippet playIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.3 2.8A1 1 0 0 0 4.8 3.7v12.6a1 1 0 0 0 1.5.9l10-6.3a1 1 0 0 0 0-1.7l-10-6.4Z" /></svg>
{/snippet}
{#snippet folderIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M3.5 4A1.5 1.5 0 0 0 2 5.5v9A1.5 1.5 0 0 0 3.5 16h13a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 16.5 6H10L8.2 4.4A1.5 1.5 0 0 0 7.2 4H3.5Z" /></svg>
{/snippet}
{#snippet plusIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
{/snippet}
{#snippet refreshIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M15.3 5.6A6 6 0 0 0 4.3 8H6a.8.8 0 0 1 .6 1.3l-2.4 2.8a.8.8 0 0 1-1.2 0L.6 9.3A.8.8 0 0 1 1.2 8h1.5a7.5 7.5 0 0 1 14 .2.8.8 0 1 1-1.4.6 6 6 0 0 0 0-.2ZM18.8 10.7l-2.4-2.8a.8.8 0 0 0-1.2 0l-2.4 2.8a.8.8 0 0 0 .6 1.3H15a6 6 0 0 1-11 1.8.8.8 0 1 0-1.4.7 7.5 7.5 0 0 0 14-1.5h.6a.8.8 0 0 0 .6-1.3Z" /></svg>
{/snippet}
{#snippet beakerIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M8 2a1 1 0 0 0 0 2v4.6l-3.8 6.6A1.5 1.5 0 0 0 5.5 17.5h9a1.5 1.5 0 0 0 1.3-2.3L12 8.6V4a1 1 0 1 0 0-2H8Zm2 2h0v5a1 1 0 0 0 .13.5l1.2 2H6.67l1.2-2A1 1 0 0 0 8 9V4h2Z" /></svg>
{/snippet}
{#snippet plugIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M7 2a1 1 0 0 1 1 1v3h4V3a1 1 0 1 1 2 0v3h.5a1 1 0 0 1 1 1v2a5 5 0 0 1-4 4.9V17a1 1 0 1 1-2 0v-3.1A5 5 0 0 1 5.5 9V7a1 1 0 0 1 1-1H7V3a1 1 0 0 1 0-1Z" /></svg>
{/snippet}
{#snippet warnIcon()}
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M8.5 3.3a1.7 1.7 0 0 1 3 0l6.1 10.6A1.7 1.7 0 0 1 16.1 16.5H3.9a1.7 1.7 0 0 1-1.5-2.6L8.5 3.3ZM10 7a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" /></svg>
{/snippet}

<style>
    .page {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        padding: 1rem;
        overflow: auto;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        font:
            14px/1.5 system-ui,
            sans-serif;
    }
    .page-header h1 {
        margin: 0;
        font-size: 1.05rem;
    }
    .page-header p {
        margin: 0.15rem 0 0;
        font-size: 0.82rem;
        opacity: 0.65;
    }

    .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
        gap: 1rem;
    }
    .card {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
        padding: 1rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 10px;
        background: var(--gk-surface-0);
    }
    .card h2 {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin: 0;
        font-size: 0.92rem;
    }
    .desc {
        margin: 0;
        font-size: 0.8rem;
        line-height: 1.45;
        opacity: 0.7;
    }
    .desc code {
        font-size: 0.92em;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
    }

    /* Button system */
    .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.42rem 0.7rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 7px;
        background: var(--gk-surface-1);
        color: inherit;
        font: inherit;
        font-weight: 500;
        cursor: pointer;
        transition:
            background 0.12s ease,
            border-color 0.12s ease,
            transform 0.04s ease;
    }
    .btn:hover:not(:disabled) {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
    }
    .btn:active:not(:disabled) {
        transform: translateY(1px);
    }
    .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }
    .btn--primary {
        border-color: transparent;
        background: var(--gk-accent, #4f46e5);
        color: #fff;
    }
    .btn--primary:hover:not(:disabled) {
        background: var(--gk-accent-strong, #4338ca);
    }
    .btn--icon {
        padding: 0.42rem;
    }
    .btn :global(svg),
    h2 :global(svg) {
        width: 1rem;
        height: 1rem;
        flex: none;
    }

    /* Status badge */
    .badge {
        display: inline-flex;
        align-items: center;
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        font-size: 0.74rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }
    .badge--idle {
        background: var(--gk-surface-2, #e5e7eb);
        color: var(--gk-text-muted, #6b7280);
    }
    .badge--run {
        background: #dbeafe;
        color: #1e40af;
    }
    .badge--ok {
        background: #dcfce7;
        color: #166534;
    }
    .badge--bad {
        background: #fee2e2;
        color: #991b1b;
    }

    .folder-meta {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
    }
    .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.25rem 0.55rem;
        border-radius: 7px;
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
        font-size: 0.78rem;
        font-weight: 500;
    }
    .chip--muted {
        opacity: 0.7;
        font-weight: 400;
    }
    .chip :global(svg) {
        width: 0.85rem;
        height: 0.85rem;
    }

    .toolbar {
        display: flex;
        gap: 0.6rem;
        align-items: center;
        flex-wrap: wrap;
    }
    .field {
        display: flex;
        gap: 0.35rem;
        flex: 1;
        min-width: 12rem;
    }
    .field input {
        flex: 1;
        min-width: 0;
        padding: 0.42rem 0.6rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 7px;
        background: var(--gk-surface-1);
        color: inherit;
        font: inherit;
    }

    .doc-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.2rem;
        max-height: 9rem;
        overflow: auto;
        font-size: 0.82rem;
    }
    .doc-list li {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.15rem 0;
    }
    .tag {
        font-size: 0.66rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        padding: 0.08rem 0.35rem;
        border-radius: 4px;
    }
    .tag--j {
        background: #e0e7ff;
        color: #3730a3;
    }
    .tag--p {
        background: #d1fae5;
        color: #065f46;
    }

    .notice {
        margin: 0;
        padding: 0.6rem 0.7rem;
        border-radius: 7px;
        background: #fef3c7;
        color: #92400e;
        font-size: 0.82rem;
    }
    .status {
        margin: 0;
        font-size: 0.8rem;
        opacity: 0.75;
    }

    .editor {
        flex: 1;
        min-height: 16rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 10px;
        overflow: hidden;
        background: var(--gk-surface-0);
    }
    .editor.empty {
        display: grid;
        place-content: center;
    }
    .placeholder {
        opacity: 0.5;
        font-size: 0.85rem;
    }

    .conflict {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        display: flex;
        align-items: flex-start;
        gap: 0.6rem;
        max-width: 26rem;
        padding: 0.85rem 1rem;
        border-radius: 10px;
        background: var(--gk-surface-0, #fff);
        border: 1px solid var(--gk-border-soft);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        z-index: 50;
    }
    .conflict :global(svg) {
        width: 1.25rem;
        height: 1.25rem;
        color: #b45309;
        flex: none;
        margin-top: 0.1rem;
    }
    .conflict__body {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        font-size: 0.82rem;
    }
    .conflict__actions {
        display: flex;
        gap: 0.4rem;
        margin-left: auto;
        align-self: center;
    }
</style>
