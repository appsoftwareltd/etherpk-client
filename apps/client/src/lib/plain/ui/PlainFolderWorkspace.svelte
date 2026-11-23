<script lang="ts">
    /**
     * The workspace of a [[Plain Folder]]: the pane Layout and the editor over an ordinary folder
     * of files, with no graph behind them (ADR 0194).
     *
     * A composition of its own, not a mode of the graph workspace. Nothing a graph does on open
     * (creating its four directories, writing `AGENTS.md`, reading its settings and bookmark files)
     * is reachable from here, because none of that code is mounted. What the two share, they
     * share as the parts they are: the Layout controller and its presenters, `DocumentView` in its
     * plain profile, the toolbar, and the Commands that need only an editor or the Layout.
     */
    import { onMount, tick } from 'svelte'

    import { goto, pushState, replaceState } from '$app/navigation'
    import { page } from '$app/state'
    import ConfirmDialog from '@appsoftwareltd/etherpk-shared/confirm-dialog'
    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import { showNotice } from '#lib/activity/notices.js'
    import { registerBlockCommands } from '#lib/document/commands/block-commands.js'
    import { registerEditorCommands } from '#lib/document/commands/editor-commands.js'
    import { registerFindCommands } from '#lib/document/commands/find-commands.js'
    import { registerLinkCommands } from '#lib/document/commands/link-commands.js'
    import { registerPasteCommands } from '#lib/document/commands/paste-commands.js'
    import { revealDocumentLine } from '#lib/document/reveal.js'
    import { registerAugmentationRenderers } from '#lib/document/view/augmentations/renderers/register.js'
    import {
        LAYOUT_VERSION,
        type LayoutController,
        type LayoutModel,
        type LayoutRenderer,
        type SerializedLayout,
        type ViewRef,
        createEmptyModel,
        createLayoutController,
        createLocalLayoutStore,
        createViewRegistry,
        prefersMobileLayout,
        viewKey,
        watchMobileLayout,
    } from '#lib/layout/index.js'
    import { setActiveLayoutController } from '#lib/layout/active-controller.js'
    import MobilePresenter from '#lib/layout/renderers/MobilePresenter.svelte'
    import type { MobileRenderer } from '#lib/layout/renderers/mobile-renderer.svelte.js'
    import { registerTabCommands } from '#lib/layout/tab-commands.js'
    import { IMAGE_DISPLAY_SIZE_OFF } from '#lib/storage/fs/graph-settings.js'
    import { describeFilesystemSaveFailure } from '#lib/storage/fs/save-error-copy.js'
    import { createIdbGraphRegistry } from '#lib/storage/graph-registry-idb.js'
    import { getBookmarks, renameBookmarkConcept, sanitizeBookmarks, setBookmarks } from '#lib/document/bookmarks/bookmarks.js'
    import { registerBookmarkCommands } from '#lib/document/commands/bookmark-commands.js'
    import { registerSpellingCommands } from '#lib/document/commands/spelling-commands.js'
    import { browserFoldMemory, releaseActiveFoldMemory, setActiveFoldMemory } from '#lib/document/view/augmentations/fold-memory.js'
    import { followEbookRename, resetEbookBookmarks, sanitizeEbookBookmarks, setEbookBookmarks } from '#lib/document/ebook/ebook-bookmarks.js'
    import { ebookDeviceMemory } from '#lib/document/ebook/ebook-device-memory.js'
    import { pdfDeviceMemory } from '#lib/document/pdf/device-memory.js'
    import { followPdfRename, resetPdfBookmarks, sanitizePdfBookmarks, setPdfBookmarks } from '#lib/document/pdf/pdf-bookmarks.js'
    import type { PdfGraphService } from '#lib/document/pdf/pdf-service.js'
    import { registerAssetViewers } from '#lib/document/view/viewers/register.js'
    import { attachKeybindings, createCommandRegistry, createContributionRegistry, createEventBus } from '#lib/surface/index.js'
    import { createKeybindingTable } from '#lib/surface/keybindings.js'
    import ContextMenu from '#lib/surface/ui/ContextMenu.svelte'
    import KeyboardShortcutsDialog from '#lib/workspace/KeyboardShortcutsDialog.svelte'
    import WorkspaceToolbar from '#lib/workspace/WorkspaceToolbar.svelte'
    import { chosenGraphState } from '#lib/workspace/chosen-graph.js'
    import { openChosenFolder } from '#lib/workspace/open-chosen-folder.js'
    import { graphUrl } from '#lib/navigation/document-url.js'
    import { graphAddressOf } from '#lib/navigation/graph-address.js'
    import { APP_KEYBINDINGS, type ShortcutBinding } from '#lib/workspace/keyboard-shortcuts.js'
    import ActivityBar from '#lib/layout/renderers/ActivityBar.svelte'
    import { registerSidebarCommands } from '#lib/layout/sidebar-commands.js'
    import { personSettings } from '#lib/person-settings/person-settings.js'
    import { createSidebars } from '#lib/workspace/sidebars.svelte.js'
    import {
        type WorkspaceGeneration,
        clearWorkspaceServices,
        createWorkspaceHealth,
        publishWorkspaceServices,
        updateWorkspaceServices,
    } from '#lib/workspace/workspace-services.js'

    import { fileKindOf, isEditableKind } from '../file-kind'
    import type { FolderTreeAdapter } from '../folder-tree-adapter'
    import { parsePlainUrl, plainFileUrl, plainFolderUrl } from '../plain-address'
    import { type FolderIndex, createFolderIndex } from '../folder-index'
    import { type Move, type RewritePlan, applyRewrites, describeRewrite, planRewrites, rewriteQuestion } from '../link-rewrite'
    import { lineOfFragment } from '../outline'
    import { type AssetPlacement, createPlainAssetStore } from '../plain-assets'
    import { DEFAULT_PLAIN_SETTINGS, type PlainSettings, readPlainSettings, writePastedFiles } from '../plain-settings'
    import { suggestPaths } from '../path-complete-core'
    import { type PlainConflict, type PlainFolderStore, createPlainFolderStore } from '../plain-folder-store'
    import { addFavourite, movedFavourites, readFavourites, removeFavourite, sortFavourites } from '../plain-favourites'
    import { EBOOK_BOOKMARKS, LINE_BOOKMARKS, PDF_BOOKMARKS, listPersist, readList } from '../plain-lists'
    import { type PlainMedia, createPlainMedia } from '../plain-media'
    import { createPlainEbookStateHost, createPlainPdfStateHost } from '../plain-reader-state'
    import { openPlainSpelling } from '../plain-spelling'
    import { type PlainStateFolder, createPlainStateFolder } from '../plain-state-folder'
    import { deleteEntry, moveEntry } from '../tree-operations'
    import { baseName, directoryHolding, dirOf, joinPath, resolveLink } from '../plain-path'
    import type { LinkPlacement, PlainProfile } from '../plain-profile'
    import { type PlainSession, plainSession } from '../plain-session.svelte'
    import { createRemoteImageTrust } from '../remote-images'
    import { createSingleFileAdapter } from '../single-file-adapter'
    import { createWebTreeAdapter } from '../web-tree-adapter'
    import FileTreeView from './FileTreeView.svelte'
    import OutlineView from './OutlineView.svelte'
    import GoToFileDialog from './GoToFileDialog.svelte'
    import PlainDocumentView from './PlainDocumentView.svelte'
    import PlainFileView from './PlainFileView.svelte'
    import PlainSettingsDialog from './PlainSettingsDialog.svelte'
    import PlainStartView from './PlainStartView.svelte'
    import SearchInFolderDialog from './SearchInFolderDialog.svelte'

    let {
        id,
        name,
        handle,
        file,
        onopenfolder,
        autosaveMs,
    }: {
        /** The folder's id in this device's registry: what its Layout is kept under. */
        id: string
        /** The folder's own name, which is also its name in its address. */
        name: string
        /** The folder. Absent when one file was opened on its own. */
        handle?: FileSystemDirectoryHandle
        /**
         * One file opened on its own, from the device's file manager: the browser gave EtherPK the
         * file and not its folder. The workspace shows it with no address of its own, and offers
         * to open the folder.
         */
        file?: FileSystemFileHandle
        /** Asked for by the bar a file opened on its own is shown under. */
        onopenfolder?: () => void
        /** Dev and end-to-end tests only: how long after an edit a save starts. */
        autosaveMs?: number
    } = $props()

    // A workspace serves one folder for its whole life: the route mounts a new one for another.
    // svelte-ignore state_referenced_locally
    const folderId = id
    // svelte-ignore state_referenced_locally
    const folderName = name
    // svelte-ignore state_referenced_locally
    const onlyFile = file
    /** What this folder's Layout, and everything else kept per workspace, is filed under. */
    const workspaceId = `plain-folder:${folderId}`

    /** The View kinds of a Plain Folder. `document` is the editor's, as in a graph, so its Commands find it. */
    const TREE_VIEW: ViewRef = { kind: 'file-tree', target: 'root' }
    const START_VIEW: ViewRef = { kind: 'plain-start', target: 'start' }
    const OUTLINE_VIEW: ViewRef = { kind: 'plain-outline', target: 'outline' }

    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const registry = createViewRegistry(contributions)
    registry.register({ kind: 'document', component: PlainDocumentView, title: (view) => baseName(view.target), icon: 'file-text' })
    // `asset` is the kind a graph gives a file in a tab of its own, and the kind the readers name when they open or retitle one.
    registry.register({ kind: 'asset', component: PlainFileView, title: (view) => baseName(view.target) })
    registry.register({ kind: 'file-tree', component: FileTreeView, naturalRegion: 'left-sidebar', title: () => 'Files', icon: 'folder' })
    registry.register({ kind: 'plain-outline', component: OutlineView, naturalRegion: 'right-sidebar', title: () => 'Outline', icon: 'text-lines' })
    registry.register({ kind: 'plain-start', component: PlainStartView, title: () => folderName })
    /**
     * The graph's chords whose Commands this workspace has, and its own: Go to file where a graph
     * has Search. The Keyboard Shortcuts card lists exactly these, so it shows what works here.
     */
    const PLAIN_KEYBINDINGS: ShortcutBinding[] = [
        { key: 'Mod+K', command: 'plain.goToFile', label: 'Go to a file', group: 'Go to' },
        { key: 'Mod+P', command: 'plain.goToFile', label: 'Go to a file', group: 'Go to' },
        { key: 'Alt+F', command: 'plain.goToFile', label: 'Go to a file', group: 'Go to' },
        { key: 'Mod+Shift+F', command: 'plain.search', label: 'Search in the folder', group: 'Go to' },
    ]
    const keybindings = createKeybindingTable([...PLAIN_KEYBINDINGS, ...APP_KEYBINDINGS.filter((binding) => binding.command !== 'search.open')])
    const shownBindings = $derived(keybindings.bindings.filter((binding) => commands.has(binding.command)))

    let container = $state<HTMLDivElement>()
    let controller = $state<LayoutController>()
    let mobileRenderer = $state<MobileRenderer>()
    let useMobile = $state(false)
    let ready = $state(false)
    let openError = $state<string | null>(null)
    let shortcutsOpen = $state(false)
    let conflict = $state.raw<PlainConflict | null>(null)
    let conflictError = $state<string | null>(null)
    let resolving = $state(false)
    let activePath = $state<string | null>(null)
    let listingEpoch = $state(0)
    let goToFileOpen = $state(false)
    let searchOpen = $state(false)
    let settingsOpen = $state(false)
    /** The folder's own settings (plain-settings.ts): the defaults until its hidden folder has been read. */
    let settings = $state.raw<PlainSettings>(DEFAULT_PLAIN_SETTINGS)
    let stateFolder: PlainStateFolder | undefined

    let favourites = $state.raw<string[]>([])

    async function toggleFavourite(path: string): Promise<void> {
        if (!stateFolder) throw new Error('the folder is not open')
        if (favourites.includes(path)) {
            await removeFavourite(stateFolder, path)
            favourites = favourites.filter((held) => held !== path)
        } else {
            await addFavourite(stateFolder, path)
            favourites = sortFavourites([...favourites, path])
        }
    }

    /** A favourite follows its file through a move in the tree. */
    async function moveFavourites(from: string, to: string): Promise<void> {
        const folder = stateFolder
        const moved = movedFavourites(favourites, from, to)
        if (!folder || moved.length === 0) return
        const was = new Set(moved.map((entry) => entry.was))
        favourites = sortFavourites([...favourites.filter((path) => !was.has(path)), ...moved.map((entry) => entry.now)])
        for (const entry of moved) {
            await addFavourite(folder, entry.now)
            await removeFavourite(folder, entry.was)
        }
    }

    async function setPastedFiles(placement: AssetPlacement): Promise<void> {
        if (!stateFolder) throw new Error('the folder is not open')
        await writePastedFiles(stateFolder, placement)
        settings = { ...settings, pastedFiles: placement }
    }
    /** The links a move in the tree broke, while the person is asked whether to mend them. */
    let linkRewrite = $state.raw<RewritePlan[] | null>(null)
    let linkRewriteOpen = $state(false)
    /** Every file of the folder, read in the background and again when the folder may have changed. */
    let files = $state.raw<readonly string[]>([])
    let filesTruncated = $state(false)
    let filesRead = $state(false)
    /** The directories that hold a graph of their own, from the same walk. */
    let graphFolders = $state.raw<readonly string[]>([])
    let index: FolderIndex | undefined

    let renderer: LayoutRenderer | undefined
    let tree = $state.raw<FolderTreeAdapter>()
    let store: PlainFolderStore | undefined
    let media: PlainMedia | undefined
    let generation: WorkspaceGeneration | undefined
    const layoutStore = createLocalLayoutStore()
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    // The two Sidebars (ADR 0198): Files in the Primary, chosen from the Activity Bar, and Outline
    // in the Secondary, each where the person's Sidebar Arrangement keeps it (ADR 0199).
    const sidebars = createSidebars({
        settings: personSettings(),
        residents: () => [
            { kind: TREE_VIEW.kind, role: 'primary', fallback: () => TREE_VIEW },
            { kind: OUTLINE_VIEW.kind, role: 'secondary', fallback: () => OUTLINE_VIEW },
        ],
        controller: () => controller,
        renderer: () => renderer,
        title: (view) => registry.title(view),
        icon: (view) => registry.icon(view),
        settled: () => !disposed,
    })
    const activityBar = $derived(useMobile ? null : sidebars.bar())

    /** The View a file opens in: the editor for text, a viewer for everything else. */
    const viewFor = (path: string): ViewRef => ({ kind: isEditableKind(fileKindOf(path)) ? 'document' : 'asset', target: path })
    const isFileView = (view: ViewRef) => view.kind === 'document' || view.kind === 'asset'

    /** Open a file in a tab, or beside the one in front. The path is taken as the folder spells it. */
    async function openFile(path: string, placement: LinkPlacement = 'tab'): Promise<void> {
        if (!controller || !store) return
        const canonical = (await store.canonicalPath(path)) ?? path
        if (disposed || !controller) return
        const view = viewFor(canonical)
        if (placement !== 'tab' && openBeside(controller, view, placement)) return
        // The start View has done its job once a file is open.
        controller.openView(view, { region: 'main' })
        if (controller.isOpen(START_VIEW)) controller.closeView(START_VIEW)
        controller.focusView(view)
    }

    /** Open `view` to the right of, or below, the tab in front. False when there is no room to, so it opens as a tab. */
    function openBeside(layout: LayoutController, view: ViewRef, placement: 'right' | 'below'): boolean {
        const source = layout.activeView()
        if (!source || !layout.canOpenBeside(source.panelId)) return false
        if (placement === 'right') layout.openViewToTheRight(view, source.panelId)
        else layout.openViewBelow(view, source.panelId)
        return true
    }

    /** Follow a markdown link from the file at `from`. */
    function openLink(from: string, href: string, placement: LinkPlacement): void {
        const target = resolveLink(from, href)
        if (target.kind === 'external') {
            window.open(href, '_blank', 'noopener,noreferrer')
            return
        }
        if (target.kind === 'outside') {
            showNotice({ id: 'plain-link', tone: 'error', text: `That link leads outside ${folderName}, so EtherPK cannot open it.` })
            return
        }
        void (async () => {
            const there = await store?.canonicalPath(target.path)
            if (there == null) {
                showNotice({ id: 'plain-link', tone: 'error', text: `No file is at ${target.path}.` })
                return
            }
            await openFile(there, placement)
            // A link to a heading lands on it, by the anchor a repository host gives the heading.
            if (target.fragment !== null && isEditableKind(fileKindOf(there))) {
                await store?.whenReady(there)
                const line = lineOfFragment(store?.open(there).getText() ?? '', target.fragment)
                if (line !== null) revealDocumentLine(there, line)
            }
        })()
    }

    /** The tabs showing files at or under `path`, with where each is. */
    function tabsUnder(path: string): Array<{ view: ViewRef; paneId: string; front: boolean }> {
        const out: Array<{ view: ViewRef; paneId: string; front: boolean }> = []
        for (const region of Object.values(controller?.serialize().model.regions ?? {})) {
            for (const pane of region.panes) {
                for (const instance of pane.views) {
                    const at = instance.view.target
                    if (isFileView(instance.view) && (at === path || at.startsWith(`${path}/`))) out.push({ view: instance.view, paneId: pane.id, front: pane.activePanelId === instance.panelId })
                }
            }
        }
        return out
    }

    /**
     * The tree moved an entry: each tab there is re-keyed to the new path, in the same Pane and in
     * front if it was. The new one opens before the old one closes, so a Pane the tab had to itself
     * is never emptied from under it. The store has already moved the open file, so its text and
     * unsaved edits are the same object under the new path.
     */
    function entryMoved(from: string, to: string): void {
        void moveFavourites(from, to).catch((error: unknown) => console.warn('[plain-folder] a favourite could not follow its file', error))
        // A bookmarked line follows its file: the person marked the line, not the name.
        const moved = new Set(getBookmarks().map((bookmark) => bookmark.concept).filter((path) => path === from || path.startsWith(`${from}/`)))
        for (const path of moved) void renameBookmarkConcept(path, to + path.slice(from.length)).catch(() => {})
        if (!controller) return
        for (const tab of tabsUnder(from)) {
            controller.openView({ kind: tab.view.kind, target: to + tab.view.target.slice(from.length) }, { activate: tab.front, paneId: tab.paneId })
            controller.closeView(tab.view)
        }
    }

    /** The tree removed an entry: its tabs close, and an emptied main region shows the start View again. */
    function entryRemoved(path: string): void {
        if (!controller) return
        const tabs = tabsUnder(path)
        const remaining = controller.serialize().model.regions.main.panes.flatMap((pane) => pane.views).length - tabs.length
        if (remaining <= 0) controller.openView(START_VIEW, { region: 'main' })
        for (const tab of tabs) controller.closeView(tab.view)
    }

    /**
     * Open the graph kept in a directory of this folder as the graph it is, in the graph workspace.
     * It is registered as any chosen Graph Folder is, or found if this device already has it.
     */
    async function openAsGraph(path: string): Promise<void> {
        try {
            const handle = await tree?.directoryHandle?.(path)
            if (!handle) throw new Error('this browser cannot reach that directory by itself')
            const outcome = await openChosenFolder(handle, createIdbGraphRegistry())
            if (outcome.kind === 'refused') {
                showNotice({ id: 'plain-open-graph', tone: 'error', text: outcome.message })
                return
            }
            await goto(graphUrl(graphAddressOf(outcome.graph)), { state: chosenGraphState(outcome.graph) })
        } catch (error) {
            showNotice({ id: 'plain-open-graph', tone: 'error', text: `Could not open ${baseName(path)} as a graph: ${error instanceof Error ? error.message : String(error)}` })
        }
    }

    /**
     * After a move in the tree: find the links it broke, and ask before writing them. The folder is
     * read again first, so the plan sees the files where they now are.
     */
    async function offerLinkRewrite(move: Move): Promise<void> {
        if (!tree || !index) return
        try {
            await index.refresh()
            const plans = await planRewrites(tree, index.files(), move)
            if (plans === null) {
                showNotice({ id: 'plain-links', tone: 'info', text: 'This folder has too many markdown files for EtherPK to check their links after the move.' })
                return
            }
            if (plans.length === 0) return
            linkRewrite = plans
            linkRewriteOpen = true
        } catch (error) {
            console.warn('[plain-folder] the links could not be checked after a move', error)
        }
    }

    async function applyLinkRewrite(): Promise<void> {
        const plans = linkRewrite
        linkRewrite = null
        if (!plans || !tree || !store) return
        const outcome = await applyRewrites(tree, store, plans)
        showNotice({ id: 'plain-links', tone: outcome.skipped.length === 0 ? 'info' : 'error', text: describeRewrite(plans, outcome) })
    }

    const linkRewriteMessage = $derived(rewriteQuestion(linkRewrite ?? []))

    /**
     * What a PDF's or an EBook's reader asks of the folder: where its highlights are kept, and to
     * rename or delete the file it shows, which here is a move or a removal in the tree.
     */
    function readerFileService(folderTree: FolderTreeAdapter, folderStore: PlainFolderStore, kept: PlainStateFolder): PdfGraphService {
        return {
            state: createPlainPdfStateHost({ folder: kept, folderId: workspaceId, memory: pdfDeviceMemory() }),
            backend: 'folder',
            plain: true,
            async deleteAsset(target) {
                await deleteEntry(folderTree, folderStore, target)
                entryRemoved(target)
                void rescan()
                return { deleted: true }
            },
            async renameAsset(target, name) {
                const to = await moveEntry(folderTree, folderStore, target, joinPath(dirOf(target), name))
                entryMoved(target, to)
                void rescan()
                // The bookmarks that named the file by its old path follow it.
                await followPdfRename(target, to, baseName(to)).catch(() => {})
                await followEbookRename(target, to, baseName(to)).catch(() => {})
                if (to !== target) void offerLinkRewrite({ from: target, to })
                return { target: to, name: baseName(to) }
            },
            keptOnDevice: async () => true,
            setKeptOnDevice: async () => {},
        }
    }

    const profile: PlainProfile = {
        openLink,
        resolveMedia: (from, ref) => media?.resolve(from, ref) ?? Promise.resolve(null),
        // A file of a graph kept inside the folder is that graph's to change, so it is shown, not edited.
        readOnly: (path) => store?.stateOf(path)?.readOnly != null || directoryHolding(graphFolders, path) !== null,
        textOnly: (path) => fileKindOf(path) === 'text',
        suggestPaths: (from, query) => suggestPaths(from, files, query),
        assets: (from) => createPlainAssetStore(tree!, media!, () => from, () => settings.pastedFiles),
        remoteImages: createRemoteImageTrust(folderId, localStorage),
    }

    const session: PlainSession = {
        id: folderId,
        name: folderName,
        get tree() {
            return tree!
        },
        get store() {
            return store!
        },
        get media() {
            return media!
        },
        get activePath() {
            return activePath
        },
        get listingEpoch() {
            return listingEpoch
        },
        get graphFolders() {
            return graphFolders
        },
        openAsGraph,
        openFile,
        listingChanged: () => void rescan(),
        entryMoved,
        entryRemoved,
        linksMayHaveBroken: (from, to) => void offerLinkRewrite({ from, to }),
        get favourites() {
            return favourites
        },
        toggleFavourite,
    }

    /** The Layout a folder opens with the first time: the tree on the left, the start View in the middle. */
    function freshLayout(): SerializedLayout {
        const pane = (view: ViewRef) => ({ id: `pane-${viewKey(view)}`, views: [{ panelId: viewKey(view), view }], activePanelId: viewKey(view) })
        const model: LayoutModel = createEmptyModel()
        model.regions['left-sidebar'] = { panes: [pane(TREE_VIEW)], collapsed: useMobile }
        model.regions.main = { panes: [pane(START_VIEW)], collapsed: false }
        model.regions['right-sidebar'] = { panes: [pane(OUTLINE_VIEW)], collapsed: true }
        model.activePanelId = viewKey(START_VIEW)
        // Written for the Primary Sidebar on the left, and turned for a person who keeps it on the right.
        return sidebars.binding.orient({ version: LAYOUT_VERSION, model })
    }

    function scheduleSave(): void {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => saveLayout(), 300)
    }
    function saveLayout(): void {
        clearTimeout(saveTimer)
        if (controller) void layoutStore.save(workspaceId, controller.serialize())
    }

    /** The file in front of the main region, mirrored for the tree and the address bar. */
    function noteActive(): void {
        const front = controller?.frontPanelOf('main') ?? null
        const instances = controller?.serialize().model.regions.main.panes.flatMap((pane) => pane.views) ?? []
        const inFront = front === null ? undefined : instances.find((instance) => instance.panelId === front)?.view
        activePath = inFront && isFileView(inFront) ? inFront.target : null
        syncAddress()
    }

    /** The file an address asked for and the Layout has not shown yet: the address is not rewritten meanwhile. */
    let following: string | null = null
    /**
     * The address this workspace last put in the address bar, or found there. Kept here rather than
     * read back from the bar, which a shallow push changes a moment after it is asked to: read too
     * soon, the old address made every Layout change push the same file again.
     */
    let addressed = ''

    /** Keep the address on the file in front, so a reload, Back and a copied link return to it. */
    function syncAddress(): void {
        // A file opened on its own has no address: the browser gave it once, to this page.
        if (onlyFile) return
        if (!ready || following !== null) return
        const wanted = activePath === null ? plainFolderUrl(folderName) : plainFileUrl(folderName, activePath)
        if (addressed === wanted) return
        const from = parsePlainUrl(addressed)
        addressed = wanted
        // The first file opened from the bare folder address replaces it; after that each file is a step Back can undo.
        if (from?.path == null) replaceState(wanted + window.location.search, page.state)
        else pushState(wanted + window.location.search, page.state)
    }

    /** Open what the address names, when it is not already in front: Back, Forward or a pasted link. */
    function followAddress(): void {
        if (onlyFile) return
        addressed = window.location.pathname
        const path = parsePlainUrl(addressed)?.path ?? null
        if (path === null || path === activePath || path === following) return
        // Until that file is in front, the Layout's own changes must not write the old file's
        // address back over the one being followed.
        following = path
        void openFile(path).finally(() => {
            if (following === path) following = null
            noteActive()
        })
    }

    async function waitForSize(element: HTMLElement): Promise<void> {
        for (let i = 0; i < 20 && (element.clientHeight === 0 || element.clientWidth === 0); i++) {
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
        }
    }

    /** The phone's renderer, or null when the workspace closed or turned desktop while it loaded. */
    async function phoneRenderer(): Promise<LayoutRenderer | null> {
        const { createMobileRenderer } = await import('#lib/layout/renderers/mobile-renderer.svelte.js')
        if (disposed || !useMobile) return null
        mobileRenderer = createMobileRenderer(registry, { onActiveViewChange: () => noteActive() })
        return mobileRenderer
    }

    /** The desktop's renderer, once its container has a size. Null when the workspace closed or turned phone meanwhile. */
    async function desktopRenderer(): Promise<LayoutRenderer | null> {
        const { createDockviewRenderer } = await import('#lib/layout/renderers/dockview-adapter.js')
        if (disposed || useMobile || !container) return null
        mobileRenderer = undefined
        await waitForSize(container)
        if (disposed || useMobile || !container) return null
        return createDockviewRenderer({
            container,
            registry,
            onGeometryChange: () => {
                scheduleSave()
                sidebars.binding.noteLayoutChanged()
            },
            onActiveViewChange: (view) => {
                if (view) controller?.notePanelActivated(viewKey(view))
                noteActive()
            },
            onViewClosed: (panelId) => controller?.forgetClosedView(panelId),
            onCloseRequested: (panelId) => controller?.closePanel(panelId),
            onViewMoved: () => controller?.noteRendererChanged(),
        })
    }

    async function mountPresenter(model?: LayoutModel): Promise<void> {
        const initial = model ? { version: LAYOUT_VERSION, model } : ((await layoutStore.load(workspaceId)) ?? freshLayout())
        if (disposed) return
        const made = useMobile ? await phoneRenderer() : await desktopRenderer()
        if (!made) return
        renderer = made
        controller = createLayoutController({
            renderer,
            registry,
            defaultLayoutFactory: freshLayout,
            regionFor: (kind) => sidebars.binding.regionForKind(kind),
            onChange: () => {
                scheduleSave()
                sidebars.binding.noteLayoutChanged()
                noteActive()
            },
        })
        // Before restore(): it mounts the Views, and they read the Layout in their own mount.
        if (generation !== undefined) updateWorkspaceServices(generation, { layout: controller })
        // The bookmark sections and the readers open a tab through the controller in front.
        setActiveLayoutController(controller)
        controller.restore(initial)
        // The tree and the Outline are the Sidebars' Views, each where the person keeps it (ADR 0199).
        sidebars.attach(controller)
    }

    async function switchPresenter(mobile: boolean): Promise<void> {
        if (mobile === useMobile || disposed) return
        const snapshot = controller?.serialize().model
        sidebars.detach()
        renderer?.destroy?.()
        controller = undefined
        renderer = undefined
        mobileRenderer = undefined
        useMobile = mobile
        await tick()
        await mountPresenter(snapshot)
    }

    /** Compare the open files and the listing with the folder: on focus and on a light poll. */
    let rescanning = false
    async function rescan(): Promise<void> {
        if (rescanning || !store) return
        rescanning = true
        try {
            await store.reconcile()
        } catch (error) {
            console.warn('[plain-folder] a pass over the folder failed; the next one tries again', error)
        } finally {
            rescanning = false
            listingEpoch++
            void index?.refresh()
        }
    }

    async function resolveConflict(choice: 'keep-mine' | 'take-disk'): Promise<void> {
        if (!store || !conflict || resolving) return
        resolving = true
        conflictError = null
        const settling = conflict
        try {
            await store.resolveConflict(settling.path, choice)
            // The store may have shown a newer version in the meantime: only this one is settled.
            if (conflict === settling) conflict = null
        } catch (error) {
            const what = choice === 'keep-mine' ? 'save your version to the file' : 'read the version from the folder'
            conflictError = `Could not ${what}: ${error instanceof Error ? error.message : String(error)}. Try again.`
        } finally {
            resolving = false
        }
    }

    /** The folder, or the one file opened on its own, as a tree. */
    function openTree(): FolderTreeAdapter {
        if (onlyFile) return createSingleFileAdapter(onlyFile)
        if (handle) return createWebTreeAdapter(handle)
        throw new Error('no folder was given')
    }

    /**
     * What is in front when the workspace opens with no file named by its address or kept in its
     * Layout: the one file opened on its own, or a folder's README.
     */
    async function openFirstFile(folder: FolderTreeAdapter): Promise<void> {
        if (onlyFile) return openFile(onlyFile.name.normalize('NFC'))
        if (following !== null || activePath !== null) return
        if ((await folder.stat('README.md'))?.kind === 'file') await openFile('README.md')
    }

    onMount(() => {
        const detach: Array<() => void> = []
        useMobile = prefersMobileLayout()
        void (async () => {
            try {
                tree = openTree()
                // The folder is read once here, so a folder that cannot be read says so before anything mounts.
                await tree.list('')
                store = createPlainFolderStore(tree, {
                    autosaveMs,
                    onConflict: (raised) => {
                        conflict = raised
                        conflictError = null
                    },
                    onSaveError: (path, error) => {
                        console.warn(`[plain-folder] could not save "${path}"`, error)
                        showNotice({ id: `plain-save:${path}`, tone: 'error', text: describeFilesystemSaveFailure(error, baseName(path)) })
                    },
                })
                media = createPlainMedia(tree)
                index = createFolderIndex(tree)
                const kept = createPlainStateFolder(tree, {
                    // The one thing EtherPK adds to the folder, said once, when it is first added.
                    onFirstWrite: () =>
                        showNotice({
                            id: 'plain-state-folder',
                            tone: 'info',
                            text: `EtherPK created a hidden .etherpk folder in ${folderName}, where it keeps your highlights and bookmarks. Commit it to share them, or leave it out.`,
                        }),
                })
                // The pages and places bookmarked in the folder's PDFs and EBooks: the same lists a graph has.
                const lineBookmarks = setBookmarks(sanitizeBookmarks(await readList(kept, LINE_BOOKMARKS)), listPersist(kept, LINE_BOOKMARKS))
                detach.push(() => void lineBookmarks.close())
                stateFolder = kept
                settings = await readPlainSettings(kept)
                favourites = await readFavourites(kept)
                detach.push(await openPlainSpelling(kept, workspaceId))
                // The bullets folded in the folder's files, kept on this device as a graph's are.
                const folds = browserFoldMemory(workspaceId)
                setActiveFoldMemory(folds)
                detach.push(() => {
                    releaseActiveFoldMemory(folds)
                    folds.dispose()
                })
                setPdfBookmarks(sanitizePdfBookmarks(await readList(kept, PDF_BOOKMARKS)), listPersist(kept, PDF_BOOKMARKS))
                setEbookBookmarks(sanitizeEbookBookmarks(await readList(kept, EBOOK_BOOKMARKS)), listPersist(kept, EBOOK_BOOKMARKS))
                detach.push(resetPdfBookmarks, resetEbookBookmarks, registerAssetViewers(contributions))
                const readerFiles = readerFileService(tree, store, kept)
                detach.push(
                    index.onChange(() => {
                        files = index!.files()
                        graphFolders = index!.graphFolders()
                        filesTruncated = index!.truncated()
                        filesRead = true
                    }),
                )
                if (disposed) return

                generation = publishWorkspaceServices({
                    graphId: workspaceId,
                    health: createWorkspaceHealth(),
                    store,
                    // No size hint on a pasted picture: `|800` in the alt text is EtherPK's own, and
                    // other tools would show it as words.
                    settings: { defaultMaxImageDisplaySize: IMAGE_DISPLAY_SIZE_OFF },
                    commands,
                    contributions,
                    keybindings,
                    events: createEventBus(workspaceId),
                    plain: profile,
                    pdf: readerFiles,
                    ebook: { state: createPlainEbookStateHost({ folder: kept, folderId: workspaceId, memory: ebookDeviceMemory() }) },
                    retitleView: (panelId, title) => renderer?.setTitle?.(panelId, title),
                })
                plainSession.set(session)

                commands.register('layout.toggleSidebar', () => {
                    sidebars.toggle('left')
                })
                commands.register('layout.toggleBacklinks', () => {
                    sidebars.toggle('right')
                })
                commands.register('help.openShortcuts', () => {
                    shortcutsOpen = true
                })
                commands.register('plain.goToFile', () => {
                    goToFileOpen = true
                })
                commands.register('plain.search', () => {
                    searchOpen = true
                })
                commands.register('plain.settings', () => {
                    settingsOpen = true
                })
                // The phone strip offers Search wherever this Command exists; here it finds a file.
                commands.register('search.open', () => {
                    goToFileOpen = true
                })
                detach.push(
                    registerFindCommands(commands),
                    registerEditorCommands(commands, contributions, { plain: true }),
                    registerLinkCommands(commands, contributions, { onError: (text) => showNotice({ id: 'plain-link', tone: 'error', text }) }),
                    registerPasteCommands(commands, contributions),
                    registerBlockCommands(commands, contributions),
                    registerTabCommands(commands, contributions, { controller: () => controller }),
                    registerSidebarCommands(commands, contributions, { binding: sidebars.binding, controller: () => controller, title: (view) => registry.title(view) }),
                    registerSpellingCommands(commands, contributions),
                    registerBookmarkCommands(commands, contributions, {
                        openDocumentAtLine: (path, line) =>
                            void openFile(path).then(() => {
                                revealDocumentLine(path, line)
                            }),
                        revealSidebar: () => {
                            sidebars.reveal(TREE_VIEW.kind)
                        },
                        onError: (text) => showNotice({ id: 'plain-bookmarks', tone: 'error', text }),
                    }),
                    registerAugmentationRenderers(contributions),
                    attachKeybindings(commands, keybindings.bindings),
                    watchMobileLayout((mobile) => void switchPresenter(mobile)),
                )

                await tick()
                await mountPresenter()
                if (disposed) return
                ready = true
                // After the folder is on screen: the walk never holds up opening it.
                void index.refresh()
                // The address may name a file: open it. With none, the Layout's own file stays in
                // front, and a folder opened for the first time leads with its README.
                followAddress()
                noteActive()
                await openFirstFile(tree)
            } catch (error) {
                console.warn('[plain-folder] the folder could not be opened', error)
                openError = error instanceof Error ? error.message : String(error)
            }
        })()

        const onFocus = () => void rescan()
        // Back and Forward between two files of this folder change the address without a navigation.
        const onPopState = () => {
            if (ready) followAddress()
        }
        window.addEventListener('popstate', onPopState)
        const onPageHide = () => {
            saveLayout()
            void store?.flushAll()
        }
        window.addEventListener('focus', onFocus)
        window.addEventListener('pagehide', onPageHide)
        const poll = setInterval(() => void rescan(), 4000)

        return () => {
            disposed = true
            window.removeEventListener('focus', onFocus)
            window.removeEventListener('popstate', onPopState)
            window.removeEventListener('pagehide', onPageHide)
            clearInterval(poll)
            saveLayout()
            for (const off of detach) off()
            sidebars.dispose()
            renderer?.destroy?.()
            if (plainSession.current === session) plainSession.set(null)
            setActiveLayoutController(null)
            if (generation !== undefined) clearWorkspaceServices(generation)
            void store?.dispose()
            media?.dispose()
        }
    })
</script>

<svelte:head><title>{activePath === null ? folderName : `${baseName(activePath)} - ${folderName}`}</title></svelte:head>

<ContextMenu />

{#if openError}
    <div class="notice" role="alert" data-testid="plain-folder-error">
        <p>Could not open the folder “{folderName}”: {openError}</p>
        <a class="gk-button" href="/graphs">Back to graphs</a>
    </div>
{:else if !ready}
    <div class="notice" role="status" data-testid="plain-folder-loading">
        <p>Opening {folderName}…</p>
    </div>
{/if}

<div class={['workspace', { hidden: !ready && !container }]} data-testid="plain-folder-workspace" data-folder={folderName}>
    {#if onlyFile}
        <!-- One file, opened on its own: what is missing without its folder, and the way to get it. -->
        <div class="alone" role="note" data-testid="plain-file-alone">
            <p>
                {onlyFile.name} is open on its own. Its pictures, its links to other files, bookmarks and the file tree need the folder it is in.
            </p>
            <button type="button" class="gk-button gk-button--small" data-testid="plain-open-its-folder" onclick={() => onopenfolder?.()}>Open the folder</button>
        </div>
    {/if}
    {#if !useMobile}
        <WorkspaceToolbar
            ontoggleleft={() => void commands.execute('layout.toggleSidebar')}
            ontoggleright={() => void commands.execute('layout.toggleBacklinks')}
            onshortcuts={() => void commands.execute('help.openShortcuts')}
            onsettings={() => (settingsOpen = true)}
            settingsLabel="Folder settings"
            leftLabel={sidebars.toggleLabel('left')}
            rightLabel={sidebars.toggleLabel('right')}
        >
            {#snippet lead()}
                <span class="folder-name" data-testid="plain-folder-name">{folderName}</span>
                <span class="kind">{onlyFile ? 'File' : 'Plain Folder'}</span>
            {/snippet}
        </WorkspaceToolbar>
        <div class={['layout-row', { 'primary-right': activityBar?.side === 'right' }]}>
            {#if activityBar}
                <ActivityBar
                    items={activityBar.items}
                    showingPanelId={activityBar.showingPanelId}
                    side={activityBar.side}
                    onselect={sidebars.choose}
                    onreorder={sidebars.reorder}
                    onstep={sidebars.step}
                    menuTarget={sidebars.menuTarget}
                />
            {/if}
            <div bind:this={container} data-testid="workspace-layout" class="layout"></div>
        </div>
    {:else}
        <div class="layout" data-testid="workspace-mobile">
            {#if controller && mobileRenderer}
                <MobilePresenter {controller} renderer={mobileRenderer} {sidebars} />
            {/if}
        </div>
    {/if}
</div>

{#if goToFileOpen}
    <GoToFileDialog {files} truncated={filesTruncated} reading={!filesRead} onopen={(path, placement) => void openFile(path, placement)} onclose={() => (goToFileOpen = false)} />
{/if}

{#if searchOpen && tree}
    <SearchInFolderDialog
        {tree}
        {files}
        onopen={(path, line) =>
            void openFile(path).then(() => {
                revealDocumentLine(path, line)
            })}
        onclose={() => (searchOpen = false)}
    />
{/if}

<ConfirmDialog
    bind:open={linkRewriteOpen}
    title="Update links?"
    message={linkRewriteMessage}
    confirmLabel="Update links"
    cancelLabel="Leave them"
    onconfirm={() => void applyLinkRewrite()}
    oncancel={() => (linkRewrite = null)}
/>

{#if settingsOpen}
    <PlainSettingsDialog folderName={folderName} pastedFiles={settings.pastedFiles} onpastedfiles={setPastedFiles} onclose={() => (settingsOpen = false)} />
{/if}

{#if shortcutsOpen}
    <KeyboardShortcutsDialog bindings={shownBindings} onclose={() => (shortcutsOpen = false)} />
{/if}

<!-- Only a choice settles which version is kept, so the prompt cannot be dismissed. -->
{#if conflict}
    <Dialog open title="External change" testId="plain-conflict" closeOnBackdrop={false} onclose={() => {}}>
        {#snippet body()}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                “{conflict?.path}” changed in the folder while you have unsaved edits. Keep your version, or take the version from the folder?
            </p>
            {#if conflictError}
                <p class="text-sm text-red-600 dark:text-red-400" role="alert" data-testid="conflict-error">{conflictError}</p>
            {/if}
        {/snippet}
        {#snippet footer()}
            <button type="button" data-testid="conflict-keep-mine" class="gk-button" aria-disabled={resolving} onclick={() => resolveConflict('keep-mine')}>Keep mine</button>
            <button type="button" data-testid="conflict-take-disk" class="gk-button" aria-disabled={resolving} onclick={() => resolveConflict('take-disk')}>Take the folder’s</button>
        {/snippet}
    </Dialog>
{/if}

<style>
    .workspace {
        position: fixed;
        inset: var(--workspace-top, 3.5rem) 0 0 0;
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-1);
    }
    .workspace.hidden {
        visibility: hidden;
    }
    /* `clip`, not `hidden`: the shell is a viewport, never a scroller (see GraphWorkspace.svelte). */
    .layout {
        position: relative;
        overflow: clip;
        flex: 1;
        min-height: 0;
        min-width: 0;
    }
    /* The Activity Bar and the Layout, side by side, the bar on the Primary Sidebar's side (ADR 0198). */
    .layout-row {
        display: flex;
        flex: 1;
        min-height: 0;
    }
    .layout-row.primary-right {
        flex-direction: row-reverse;
    }
    /* What is open, beside the left toggle: the folder's name, and a badge as the Graphs page draws a kind. */
    .folder-name {
        overflow: hidden;
        color: var(--gk-text-strong);
        font-size: 0.875rem;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .alone {
        display: flex;
        flex: none;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.75rem;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid var(--gk-border);
        background: var(--gk-surface-2);
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .alone p {
        flex: 1 1 18rem;
        margin: 0;
    }
    .kind {
        flex: none;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
        background: var(--gk-surface-2);
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
        white-space: nowrap;
    }
    .notice {
        position: fixed;
        inset: var(--workspace-top, 3.5rem) 0 0 0;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 1rem 1.25rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .notice p {
        margin: 0;
    }
</style>
