<script lang="ts">
    /**
     * The file tree of a [[Plain Folder]]: its left Sidebar's resident (ADR 0194).
     *
     * A directory is listed when it is first opened (file-tree.ts), so a large repository opens at
     * once. The tree is one tab stop: the arrow keys move through the rows, as in any tree, Enter
     * opens a file, F2 renames and Delete deletes. Which directories are open is kept in this
     * browser for the folder.
     *
     * It is also where files are created, moved and removed (tree-operations.ts). A new name is
     * typed in the tree, where the entry will be. A delete asks first, with what goes: there is no bin.
     *
     * Rows are the tree's own, not push buttons (Style Guide, "Rows, tools and swatches"): they take
     * their colours from the tokens and keep text at 14px.
     */
    import { onMount, tick, untrack } from 'svelte'

    import ConfirmDialog from '@appsoftwareltd/etherpk-shared/confirm-dialog'

    import type { ViewRef } from '#lib/layout/index.js'
    import { sidebarButton } from '#lib/document/view/sidebar-button.js'
    import { openContextMenu } from '#lib/surface/context-menu-store.js'
    import { iconSvg } from '#lib/surface/icons.js'
    import { type ContextMenuTarget, registerContextMenuItem, tryGetActiveCommandRegistry, tryGetActiveContributionRegistry } from '#lib/surface/index.js'

    import { fileIconOf } from '../file-kind'
    import { type FileTreeState, type TreeMove, type TreeRow, ancestorsOf, treeKey, treeRows } from '../file-tree'
    import type { TreeEntry } from '../folder-tree-adapter'
    import BookmarksSection from '#lib/document/view/BookmarksSection.svelte'
    import EbookBookmarksSection from '#lib/document/view/EbookBookmarksSection.svelte'
    import PdfBookmarksSection from '#lib/document/view/PdfBookmarksSection.svelte'
    import { baseName, directoryHolding, dirOf, joinPath } from '../plain-path'
    import { type PlainSession, plainSession } from '../plain-session.svelte'
    import { createFile, createFolder, deleteEntry, deleteSentence, moveEntry } from '../tree-operations'

    // Every View is handed its ViewRef; the tree shows the whole folder and reads nothing from it.
    let { view: _view }: { view: ViewRef } = $props()

    type EntryTarget = Extract<ContextMenuTarget, { kind: 'plain-entry' }>

    const session = $derived(plainSession.current)

    let listed = $state.raw<ReadonlyMap<string, readonly TreeEntry[]>>(new Map())
    let open = $state.raw<ReadonlySet<string>>(new Set())
    /** The row the keyboard is on. */
    let focused = $state<string | null>(null)
    let failed = $state<string | null>(null)
    let treeElement = $state<HTMLElement>()

    /** A name being typed in the tree: for a new entry in `dir`, or for the entry at `path`. */
    type NewEntry = { mode: 'new-file' | 'new-folder'; dir: string }
    type MovedEntry = { mode: 'rename' | 'move'; path: string }
    type Naming = NewEntry | MovedEntry
    const isNewEntry = (doing: Naming): doing is NewEntry => 'dir' in doing
    let naming = $state.raw<Naming | null>(null)
    let draft = $state('')
    let namingError = $state<string | null>(null)
    let namingBusy = $state(false)
    let nameInput = $state<HTMLInputElement>()

    let deleting = $state.raw<{ path: string; kind: 'file' | 'directory'; sentence: string } | null>(null)
    let deleteOpen = $state(false)
    let treeError = $state<string | null>(null)

    const treeState = $derived<FileTreeState>({ listed, open })
    const rows = $derived(treeRows(treeState))
    const loadedRoot = $derived(listed.has(''))

    /** The rows as drawn: with a row for the name of a new entry, where it will be. */
    type Drawn = { key: string; naming: false; row: TreeRow } | { key: string; naming: true; depth: number; kind: 'file' | 'directory' }
    const drawn = $derived.by<Drawn[]>(() => {
        const out: Drawn[] = rows.map((row) => ({ key: row.path, naming: false, row }))
        if (naming === null || !isNewEntry(naming)) return out
        const { dir, mode } = naming
        const parent = rows.findIndex((row) => row.path === dir)
        out.splice(parent + 1, 0, {
            key: '\u0000new',
            naming: true,
            depth: parent < 0 ? 0 : rows[parent].depth + 1,
            kind: mode === 'new-file' ? 'file' : 'directory',
        })
        return out
    })

    const openKey = (name: string) => `etherpk-plain-tree:${name}`

    /** Read one directory's entries, replacing what was held. A directory that is gone is closed. */
    async function list(dir: string): Promise<void> {
        const current = session
        if (!current) return
        try {
            const entries = await current.tree.list(dir)
            if (plainSession.current !== current) return
            listed = new Map(listed).set(dir, entries)
            failed = null
        } catch (error) {
            if (plainSession.current !== current) return
            if (dir === '') failed = error instanceof Error ? error.message : String(error)
            else setOpen(dir, false)
        }
    }

    function setOpen(dir: string, value: boolean): void {
        const next = new Set(open)
        if (value) next.add(dir)
        else next.delete(dir)
        open = next
        if (!value) {
            const kept = new Map(listed)
            kept.delete(dir)
            listed = kept
        }
        if (session) {
            try {
                localStorage.setItem(openKey(session.name), JSON.stringify([...next]))
            } catch {
                // Private mode: the open directories last for this visit only.
            }
        }
    }

    async function openDirectory(dir: string): Promise<void> {
        setOpen(dir, true)
        await list(dir)
    }

    // The folder opened, or it may have changed on disk: read the root and every open directory.
    $effect(() => {
        const current = session
        if (!current) return
        void current.listingEpoch
        untrack(() => {
            if (!listed.has('')) {
                try {
                    const kept = JSON.parse(localStorage.getItem(openKey(current.name)) ?? '[]') as unknown
                    if (Array.isArray(kept)) open = new Set(kept.filter((dir): dir is string => typeof dir === 'string'))
                } catch {
                    // Unreadable: start with every directory closed.
                }
            }
            void list('')
            for (const dir of open) void list(dir)
        })
    })

    // The file in front shows in the tree: its directories open, and its row is the tab stop.
    $effect(() => {
        const path = session?.activePath ?? null
        if (path === null) return
        untrack(() => {
            for (const dir of ancestorsOf(path)) if (!open.has(dir)) void openDirectory(dir)
            focused = path
        })
    })

    async function focusRow(path: string): Promise<void> {
        focused = path
        await tick()
        treeElement?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.focus()
    }

    const favourites = $derived(session?.favourites ?? [])

    /** Whether `path` is, or is inside, a directory that holds a graph of its own. */
    const inGraph = (path: string) => directoryHolding(session?.graphFolders ?? [], path) !== null
    const targetOf = (row: TreeRow): EntryTarget => ({ kind: 'plain-entry', path: row.path, entry: row.kind, ...(inGraph(row.path) ? { inGraph: true } : {}) })

    const rowAt = (path: string | null) => (path === null ? undefined : rows.find((row) => row.path === path))

    /** The keys that act on the row in focus itself: rename, delete, its menu. False for any other key. */
    function rowKey(event: KeyboardEvent, at: TreeRow): boolean {
        const menu = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')
        if (menu) {
            const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
            openContextMenu(targetOf(at), box.left + 24, box.bottom)
            return true
        }
        // A graph's own files are that graph's to rename or remove.
        if (inGraph(at.path)) return false
        if (event.key === 'F2') void startNaming({ mode: 'rename', path: at.path })
        else if (event.key === 'Delete') void askDelete(at.path, at.kind)
        else return false
        return true
    }

    /** Carry out a move through the tree (file-tree.ts, `treeKey`). */
    function follow(move: Exclude<TreeMove, { kind: 'none' }>): void {
        if (move.kind === 'focus') void focusRow(move.path)
        else if (move.kind === 'open-directory') void openDirectory(move.path)
        else if (move.kind === 'close-directory') setOpen(move.path, false)
        else void session?.openFile(move.path)
    }

    function onkeydown(event: KeyboardEvent): void {
        if (event.altKey || event.ctrlKey || event.metaKey || naming) return
        const at = rowAt(focused)
        if (at && rowKey(event, at)) {
            event.preventDefault()
            return
        }
        if (event.shiftKey) return
        const move = treeKey(rows, focused, event.key)
        if (move.kind === 'none') return
        event.preventDefault()
        follow(move)
    }

    function press(row: TreeRow): void {
        focused = row.path
        if (naming) return
        if (row.kind === 'file') void session?.openFile(row.path)
        else if (row.open) setOpen(row.path, false)
        else void openDirectory(row.path)
    }

    function rowMenu(event: MouseEvent, row: TreeRow): void {
        event.preventDefault()
        event.stopPropagation()
        focused = row.path
        openContextMenu(targetOf(row), event.clientX, event.clientY)
    }

    /** The one row Tab lands on: the focused row while it is shown, else the first. */
    const tabStop = $derived(rows.some((row) => row.path === focused) ? focused : (rows[0]?.path ?? null))

    // --- naming: a new entry, a rename, a move -------------------------------------------------

    /** The directory a new entry goes in when asked for from the heading: beside the row in focus. */
    function nearbyDirectory(): string {
        const at = rowAt(focused)
        if (!at) return ''
        return at.kind === 'directory' ? at.path : dirOf(at.path)
    }

    /** What the name field starts with: a new file's extension, the name to change, or the path to move. */
    function firstDraft(next: Naming): string {
        if (isNewEntry(next)) return next.mode === 'new-file' ? '.md' : ''
        return next.mode === 'rename' ? baseName(next.path) : next.path
    }

    /** Where the caret starts: before a new file's extension, over a name without its extension, over a whole path. */
    function selectDraft(input: HTMLInputElement, mode: Naming['mode']): void {
        input.focus()
        if (mode === 'new-file') input.setSelectionRange(0, 0)
        else if (mode === 'rename') {
            const dot = draft.lastIndexOf('.')
            input.setSelectionRange(0, dot > 0 ? dot : draft.length)
        } else input.select()
    }

    /** Show every directory down to `dir` open, so a new name is typed where the entry will be. */
    async function reveal(dir: string): Promise<void> {
        if (dir === '') return
        for (const each of [...ancestorsOf(dir), dir]) if (!open.has(each)) await openDirectory(each)
    }

    async function startNaming(next: Naming): Promise<void> {
        namingError = null
        if (isNewEntry(next)) await reveal(next.dir)
        draft = firstDraft(next)
        naming = next
        await tick()
        if (nameInput) selectDraft(nameInput, next.mode)
    }

    function stopNaming(refocus: string | null): void {
        naming = null
        namingError = null
        if (refocus !== null) void focusRow(refocus)
    }

    /** Create the file or folder the name field names. A new file opens. */
    async function createNamed(current: PlainSession, doing: NewEntry): Promise<void> {
        const create = doing.mode === 'new-file' ? createFile : createFolder
        const path = await create(current.tree, doing.dir, draft)
        await list(doing.dir)
        if (doing.mode === 'new-folder') return stopNaming(path)
        stopNaming(null)
        await current.openFile(path)
    }

    /** Rename or move the entry to what the name field holds, and have everything that named it follow. */
    async function moveNamed(current: PlainSession, doing: MovedEntry): Promise<void> {
        const to = doing.mode === 'rename' ? joinPath(dirOf(doing.path), draft) : draft
        const path = await moveEntry(current.tree, current.store, doing.path, to)
        current.entryMoved(doing.path, path)
        if (path !== doing.path) current.linksMayHaveBroken(doing.path, path)
        // A moved directory keeps its open state under its new path.
        if (open.has(doing.path)) {
            setOpen(doing.path, false)
            setOpen(path, true)
        }
        for (const dir of ancestorsOf(path)) if (!open.has(dir)) setOpen(dir, true)
        current.listingChanged()
        await list(dirOf(path))
        stopNaming(path)
    }

    async function commitNaming(): Promise<void> {
        const current = session
        const doing = naming
        if (!current || !doing || namingBusy) return
        namingBusy = true
        namingError = null
        try {
            if (isNewEntry(doing)) await createNamed(current, doing)
            else await moveNamed(current, doing)
        } catch (error) {
            // The name stays as typed, with why it was refused under it.
            namingError = error instanceof Error ? error.message : String(error)
            await tick()
            nameInput?.focus()
        } finally {
            namingBusy = false
        }
    }

    function namingKey(event: KeyboardEvent): void {
        // The tree's own keys (the arrows, Delete, F2) are for its rows, not for a name being typed.
        event.stopPropagation()
        if (event.key === 'Enter') {
            event.preventDefault()
            void commitNaming()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            const doing = naming
            stopNaming(doing && !isNewEntry(doing) ? doing.path : focused)
        }
    }

    const NAMING_LABELS: Record<Naming['mode'], string> = {
        'new-file': 'Name of the new file',
        'new-folder': 'Name of the new folder',
        rename: 'New name',
        move: 'New path, from the top of the folder',
    }

    // --- delete ---------------------------------------------------------------------------------

    async function askDelete(path: string, kind: 'file' | 'directory'): Promise<void> {
        const current = session
        if (!current) return
        treeError = null
        try {
            deleting = { path, kind, sentence: await deleteSentence(current.tree, path, kind) }
            deleteOpen = true
        } catch (error) {
            treeError = `Could not read ${baseName(path)}: ${error instanceof Error ? error.message : String(error)}`
        }
    }

    async function confirmDelete(): Promise<void> {
        const current = session
        const going = deleting
        deleting = null
        if (!current || !going) return
        try {
            await deleteEntry(current.tree, current.store, going.path)
            current.entryRemoved(going.path)
            if (open.has(going.path)) setOpen(going.path, false)
            current.listingChanged()
        } catch (error) {
            treeError = `Could not delete ${baseName(going.path)}: ${error instanceof Error ? error.message : String(error)}`
        }
    }

    // --- Commands and the tree's Context Menu ---------------------------------------------------

    const isEntry = (target: ContextMenuTarget): target is EntryTarget => target.kind === 'plain-entry'
    /** Somewhere the tree may write: not in a directory that holds a graph of its own. */
    const isWritable = (target: ContextMenuTarget) => isEntry(target) && !target.inGraph
    const isRealEntry = (target: ContextMenuTarget) => isWritable(target) && isEntry(target) && target.entry !== 'root'
    const isGraph = (target: ContextMenuTarget) => isEntry(target) && target.inGraph === true
    /** The directory a target names: itself, the one a file sits in, or the folder for the tree's background. */
    const directoryOf = (target: EntryTarget) => (target.entry === 'directory' ? target.path : target.entry === 'file' ? dirOf(target.path) : '')

    onMount(() => {
        const commands = tryGetActiveCommandRegistry()
        const contributions = tryGetActiveContributionRegistry()
        if (!commands || !contributions) return
        const entryOf = (arg: unknown): EntryTarget | null => (arg && typeof arg === 'object' && isEntry(arg as ContextMenuTarget) ? (arg as EntryTarget) : null)
        /** A new entry goes where the menu was raised, or beside the row in focus for a bare Command. */
        const newIn = (arg: unknown) => {
            const target = entryOf(arg)
            return target ? directoryOf(target) : nearbyDirectory()
        }
        const onEntry = (run: (target: EntryTarget) => void) => (arg?: unknown) => {
            const target = entryOf(arg)
            if (target && target.entry !== 'root') run(target)
        }
        const detach = [
            commands.register('plain.tree.newFile', (arg?: unknown) => void startNaming({ mode: 'new-file', dir: newIn(arg) })),
            commands.register('plain.tree.newFolder', (arg?: unknown) => void startNaming({ mode: 'new-folder', dir: newIn(arg) })),
            commands.register(
                'plain.tree.rename',
                onEntry((target) => void startNaming({ mode: 'rename', path: target.path })),
            ),
            commands.register(
                'plain.tree.move',
                onEntry((target) => void startNaming({ mode: 'move', path: target.path })),
            ),
            commands.register(
                'plain.tree.delete',
                onEntry((target) => void askDelete(target.path, target.entry === 'directory' ? 'directory' : 'file')),
            ),
            commands.register('plain.tree.openAsGraph', (arg?: unknown) => {
                const target = entryOf(arg)
                const graph = target ? directoryHolding(session?.graphFolders ?? [], target.path) : null
                if (graph !== null) void session?.openAsGraph(graph)
            }),
            registerContextMenuItem(contributions, { id: 'plain.tree.openAsGraph', label: 'Open as a graph', icon: 'graph', command: 'plain.tree.openAsGraph', order: 5, when: isGraph }),
            commands.register('plain.tree.favourite', (arg?: unknown) => {
                const target = entryOf(arg)
                if (!target || !session) return
                session.toggleFavourite(target.path).catch((error: unknown) => {
                    treeError = `The Favourites could not be changed (${error instanceof Error ? error.message : String(error)}).`
                })
            }),
            registerContextMenuItem(contributions, {
                id: 'plain.tree.favourite',
                label: (target) => (isEntry(target) && favourites.includes(target.path) ? 'Remove from favourites' : 'Add to favourites'),
                icon: 'pin',
                command: 'plain.tree.favourite',
                order: 15,
                when: (target) => isEntry(target) && target.entry === 'file',
            }),
            // On the folder itself: its settings, which a phone has no toolbar button for.
            registerContextMenuItem(contributions, { id: 'plain.settings', label: 'Folder settings…', command: 'plain.settings', order: 90, when: (target) => isEntry(target) && target.entry === 'root' }),
            registerContextMenuItem(contributions, { id: 'plain.tree.newFile', label: 'New file', icon: 'new-file', command: 'plain.tree.newFile', order: 10, when: isWritable }),
            registerContextMenuItem(contributions, { id: 'plain.tree.newFolder', label: 'New folder', icon: 'new-folder', command: 'plain.tree.newFolder', order: 11, when: isWritable }),
            registerContextMenuItem(contributions, { id: 'plain.tree.rename', label: 'Rename', icon: 'rename', command: 'plain.tree.rename', order: 20, separatorBefore: true, when: isRealEntry }),
            registerContextMenuItem(contributions, { id: 'plain.tree.move', label: 'Move', icon: 'move', command: 'plain.tree.move', order: 21, when: isRealEntry }),
            registerContextMenuItem(contributions, {
                id: 'plain.tree.delete',
                label: 'Delete',
                icon: 'trash',
                command: 'plain.tree.delete',
                order: 30,
                separatorBefore: true,
                danger: true,
                when: isRealEntry,
            }),
        ]
        return () => detach.forEach((off) => off())
    })
</script>

{#snippet nameField()}
    <div class="naming">
        <input
            class="gk-input gk-input--small"
            type="text"
            data-testid="file-tree-name"
            aria-label={naming ? NAMING_LABELS[naming.mode] : undefined}
            aria-invalid={namingError ? 'true' : undefined}
            aria-describedby={namingError ? 'file-tree-name-error' : undefined}
            autocomplete="off"
            spellcheck="false"
            bind:value={draft}
            bind:this={nameInput}
            onkeydown={namingKey}
            onclick={(event) => event.stopPropagation()}
            onblur={() => {
                // Leaving the field with nothing refused drops the name; a refused one stays to be put right.
                if (!namingBusy && !namingError) stopNaming(null)
            }}
        />
        {#if namingError}
            <p class="gk-error" id="file-tree-name-error" role="alert" data-testid="file-tree-name-error">{namingError}</p>
        {/if}
    </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions (a right-click on the tree's empty space offers what its heading offers: a new file or folder) -->
<div
    class="file-tree"
    data-testid="file-tree-view"
    oncontextmenu={(event) => {
        event.preventDefault()
        openContextMenu({ kind: 'plain-entry', path: '', entry: 'root' }, event.clientX, event.clientY)
    }}
>
    <!-- The sidebar's button grid, as a graph's sidebar has (Style Guide, "Graph Sidebar buttons"). -->
    <div class="buttons">
        <button type="button" class={sidebarButton} data-testid="sidebar-go-to-file" onclick={() => void tryGetActiveCommandRegistry()?.execute('plain.goToFile')}>
            <span class="button-icon" aria-hidden="true">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                {@html iconSvg('go-to-file')}
            </span>
            Go to file
        </button>
        <button type="button" class={sidebarButton} data-testid="sidebar-search-folder" onclick={() => void tryGetActiveCommandRegistry()?.execute('plain.search')}>
            <span class="button-icon" aria-hidden="true">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                {@html iconSvg('search')}
            </span>
            Search
        </button>
    </div>
    {#if favourites.length > 0}
        <div class="heading">
            <span class="label" id="favourites-label">Favourites</span>
        </div>
        <ul class="rows favourites" aria-labelledby="favourites-label" data-testid="plain-favourites">
            {#each favourites as path (path)}
                <li>
                    <button
                        type="button"
                        class="row favourite"
                        data-own-button-style="a row of the file tree"
                        data-testid="plain-favourite"
                        data-path={path}
                        data-tooltip={path}
                        aria-description={path}
                        aria-current={path === session?.activePath ? 'page' : undefined}
                        onclick={() => void session?.openFile(path)}
                        oncontextmenu={(event) => {
                            event.preventDefault()
                            // The tree's background has a menu of its own: this one is the file's.
                            event.stopPropagation()
                            openContextMenu({ kind: 'plain-entry', path, entry: 'file', ...(inGraph(path) ? { inGraph: true } : {}) }, event.clientX, event.clientY)
                        }}
                    >
                        <span class="icon" aria-hidden="true">
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                            {@html iconSvg(fileIconOf(path))}
                        </span>
                        <span class="name">{baseName(path)}</span>
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
    <div class="heading">
        <span class="label" id="file-tree-label">Files</span>
        <span class="tools">
            <button type="button" class="gk-icon-button size-7" aria-label="New file" data-tooltip="New file" data-testid="file-tree-new-file" onclick={() => void startNaming({ mode: 'new-file', dir: nearbyDirectory() })}>
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                {@html iconSvg('new-file')}
            </button>
            <button type="button" class="gk-icon-button size-7" aria-label="New folder" data-tooltip="New folder" data-testid="file-tree-new-folder" onclick={() => void startNaming({ mode: 'new-folder', dir: nearbyDirectory() })}>
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                {@html iconSvg('new-folder')}
            </button>
            <button type="button" class="gk-icon-button size-7" aria-label="Read the folder again" data-tooltip="Read the folder again" data-testid="file-tree-reload" onclick={() => session?.listingChanged()}>
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                {@html iconSvg('refresh')}
            </button>
        </span>
    </div>
    {#if treeError}
        <p class="note gk-error" role="alert" data-testid="file-tree-failure">{treeError}</p>
    {/if}
    {#if failed}
        <p class="note" role="alert" data-testid="file-tree-error">Could not read this folder: {failed}</p>
    {:else if !loadedRoot}
        <p class="note" role="status">Reading the folder…</p>
    {:else}
        {#if drawn.length === 0}
            <p class="note" data-testid="file-tree-empty">This folder is empty. Add a file with the button above, or put one in the folder.</p>
        {/if}
        <ul class="rows" role="tree" aria-labelledby="file-tree-label" bind:this={treeElement}>
            {#each drawn as entry (entry.key)}
                {#if entry.naming}
                    <li role="none" class="new-entry" style:--depth={entry.depth}>
                        <span class="icon" aria-hidden="true">
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                            {@html iconSvg(entry.kind === 'directory' ? 'folder' : 'file-text')}
                        </span>
                        {@render nameField()}
                    </li>
                {:else}
                    {@const row = entry.row}
                    <li
                        role="treeitem"
                        class="row"
                        data-own-button-style="a row of the file tree"
                        data-testid="file-tree-row"
                        data-path={row.path}
                        data-kind={row.kind}
                        aria-level={row.depth + 1}
                        aria-expanded={row.kind === 'directory' ? row.open : undefined}
                        aria-selected={row.path === session?.activePath}
                        aria-busy={row.loading || undefined}
                        tabindex={row.path === tabStop ? 0 : -1}
                        style:--depth={row.depth}
                        onclick={() => press(row)}
                        oncontextmenu={(event) => rowMenu(event, row)}
                        {onkeydown}
                        onfocus={() => (focused = row.path)}
                    >
                        <span class="twist" class:turned={row.open} aria-hidden="true">
                            {#if row.kind === 'directory'}
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                                {@html iconSvg('tree-closed')}
                            {/if}
                        </span>
                        <span class="icon" aria-hidden="true">
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                            {@html iconSvg(row.kind === 'directory' ? (row.open ? 'folder-open' : 'folder') : fileIconOf(row.path))}
                        </span>
                        {#if naming !== null && !isNewEntry(naming) && naming.path === row.path}
                            {@render nameField()}
                        {:else}
                            <span class="name">{row.name}</span>
                            {#if row.kind === 'directory' && session?.graphFolders.includes(row.path)}
                                <span class="chip" title="This folder holds an EtherPK graph. Right-click it to open the graph.">graph</span>
                            {/if}
                        {/if}
                    </li>
                {/if}
            {/each}
        </ul>
    {/if}
    <!-- The lines, pages and places bookmarked in the folder's files: the sections a graph's Sidebar has. -->
    <div class="sections">
        <BookmarksSection />
        <PdfBookmarksSection />
        <EbookBookmarksSection />
    </div>
</div>

<ConfirmDialog
    bind:open={deleteOpen}
    title={deleting?.kind === 'directory' ? 'Delete this folder?' : 'Delete this file?'}
    message={deleting?.sentence ?? ''}
    confirmLabel="Delete"
    destructive
    onconfirm={() => void confirmDelete()}
    oncancel={() => (deleting = null)}
/>

<style>
    /* No background of its own: a pane's view is drawn on the pane's surface, which is its tab's. */
    .file-tree {
        height: 100%;
        overflow: auto;
        padding: 0.5rem 0.5rem 1rem;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .buttons {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.5rem;
        margin-bottom: 0.75rem;
    }
    .button-icon {
        display: inline-flex;
        flex: none;
        margin-right: 0.375rem;
        color: var(--gk-text-subtle);
    }
    .heading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        height: 1.75rem;
        padding: 0 0 0 0.375rem;
        margin-bottom: 0.25rem;
    }
    .label {
        flex: 1;
        color: var(--gk-text-muted);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .tools {
        display: flex;
        gap: 0.25rem;
    }
    .note {
        padding: 0.25rem 0.375rem;
        color: var(--gk-text-muted);
    }
    .sections {
        margin-top: 1rem;
    }
    .rows.favourites {
        margin-bottom: 0.75rem;
    }
    /* A favourite is a button drawn as a tree row, at the tree's first level. */
    .row.favourite {
        width: 100%;
        padding: 0 0.375rem 0 1.75rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .row.favourite[aria-current='page'] {
        background: var(--gk-surface-2);
        color: var(--gk-text-strong);
    }
    .rows {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .row,
    .new-entry {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        min-height: 1.75rem;
        border-radius: 0.25rem;
        white-space: nowrap;
    }
    .row {
        padding: 0 0.375rem 0 calc(0.375rem + var(--depth) * 1rem);
        cursor: pointer;
        user-select: none;
    }
    /* A new entry's row has no twist, so its icon starts where a sibling's would: a twist and a gap in. */
    .new-entry {
        align-items: flex-start;
        padding: 0.125rem 0.375rem 0.125rem calc(0.375rem + var(--depth) * 1rem + 1.375rem);
    }
    .new-entry > .icon {
        margin-top: 0.4375rem;
    }
    .row:hover {
        background: var(--gk-menu-hover);
    }
    .row[aria-selected='true'] {
        background: var(--gk-surface-2);
        color: var(--gk-text-strong);
    }
    .row:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    .twist,
    .icon {
        display: inline-flex;
        flex: none;
        width: 1rem;
        height: 1rem;
        color: var(--gk-text-muted);
    }
    .twist {
        transition: transform 120ms ease-out;
    }
    .twist.turned {
        transform: rotate(90deg);
    }
    .name {
        overflow: hidden;
        text-overflow: ellipsis;
    }
    /* A tag on a row: an inline chip, 4px corners (Style Guide, "Shape and spacing"). */
    .chip {
        flex: none;
        margin-left: auto;
        padding: 0 0.375rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.25rem;
        color: var(--gk-text-muted);
    }
    .naming {
        flex: 1;
        min-width: 0;
        white-space: normal;
    }
    /* A finger needs 44px to land on a row. */
    @media (pointer: coarse) {
        .row {
            min-height: 2.75rem;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .twist {
            transition: none;
        }
    }
</style>
