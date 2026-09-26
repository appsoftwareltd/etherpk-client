<script lang="ts">
    /**
     * The knowledge-graph workspace: the mount of the real Layout over a real
     * backend. It builds a FilesystemDocumentStore for the graph, registers the
     * real document Views, opens today's journal, and wires external-change
     * reconciliation + the dirty-buffer conflict prompt. Mounted by the
     * `(workspace)` route group's +layout (keyed by graph id there), so both
     * `/g/[graphId]` and `/g/[graphId]/d/[...concept]` share one instance and
     * Visit URL rewrites never remount it (ADR 0023).
     *
     * The graph is opened once; the presenter is chosen by viewport. Below the
     * LAYOUT_BREAKPOINT the single-active-View mobile presenter renders; at/above
     * it, dockview. Crossing the breakpoint live swaps presenters over the same
     * shared Layout state (serialize → rebuild → restore). The swap is data-safe
     * (the backend owns document text); it does reset per-editor undo/cursor/scroll
     * — a known, accepted limitation.
     */
    import { onMount, tick, untrack } from "svelte";

    import { dev } from "$app/environment";
    import {
        afterNavigate,
        goto,
        pushState,
        replaceState,
    } from "$app/navigation";
    import { page } from "$app/state";
    import {
        capturePosition,
        clearPendingRestores,
        createHistoryEngine,
        createReadingPositions,
        createVisitSnapshots,
        focusEditor,
        focusEditorIfEmpty,
        restorePosition,
        type HistoryEngine,
        type ReadingPositionStore,
    } from "$lib/navigation";
    import {
        LAYOUT_VERSION,
        type LayoutController,
        type LayoutModel,
        type LayoutRenderer,
        type LayoutStore,
        type ViewRef,
        createLayoutController,
        createLocalLayoutStore,
        createViewRegistry,
        defaultLayout,
        prefersMobileLayout,
        parseViewKey,
        sameView,
        viewKey,
        watchMobileLayout,
    } from "$lib/layout";
    import MobilePresenter from "$lib/layout/renderers/MobilePresenter.svelte";
    import {
        refreshTabIndicators,
        type TabMark,
    } from "$lib/layout/renderers/tab-renderer";
    // Type only: the adapter itself is `import()`ed in the browser (see mountPresenter).
    import type { DockviewRenderer } from "$lib/layout/renderers/dockview-adapter";
    import { QUICK_NOTES_VIEW, TASKS_VIEW } from "$lib/layout/serialization";
    import { revealResident, toggleResidentSidebar, type Resident } from "./residents";
    import { forgetWorkspaceCompanions } from "./workspace-reset";

    import type { MobileRenderer } from "$lib/layout/renderers/mobile-renderer.svelte";
    import {
        BacklinksView,
        DocumentView,
        IndexTransportOpenError,
        type IndexTransport,
        type RemoteGraphIndex,
        createRemoteGraphIndex,
        createSharedIndexTransport,
        getActiveDocument,
        getActiveEditorView,
        refreshEditorContext,
        inlineTransport,
        INDEX_NOT_PERSISTED_MESSAGE,
        INDEX_POOL_HELD_MESSAGE,
        acknowledgeIndexNotice,
        indexNoticeAcknowledged,
        clearAugmentationRenderCaches,
        registerAugmentationRenderers,
        registerEditorCommands,
        registerLinkCommands,
        setActiveDocument,
    } from "$lib/document";
    import { todayISO } from "$lib/document/calendar/month-grid-core";
    import { openConcept } from "$lib/document/open-concept";
    import AllDocumentsView from "$lib/document/view/AllDocumentsView.svelte";
    import GraphSidebarView from "$lib/document/view/GraphSidebarView.svelte";
    import RenameDocumentDialog from "$lib/document/view/RenameDocumentDialog.svelte";
    import SearchModal from "$lib/document/view/SearchModal.svelte";
    import TasksView from "$lib/document/view/TasksView.svelte";
    import QuickNotesView from "$lib/document/view/QuickNotesView.svelte";
    import {
        createTaskFilterStore,
        type TaskFilterStore,
    } from "$lib/document/task-filter-store";
    import {
        createBacklinksPreferencesStore,
        type BacklinksPreferencesStore,
    } from "$lib/document/backlinks-preferences";
    import {
        createSearchController,
        type SearchController,
    } from "$lib/document/search";
    import { registerDocumentCommands } from "$lib/document/commands/document-commands";
    import {
        copyFailureMessage,
        writeClipboardText,
    } from "$lib/document/commands/clipboard-text";
    import {
        QUICK_NOTES_OPEN,
        registerQuickNotesCommands,
    } from "$lib/document/commands/quick-notes-commands";
    import {
        addQuickNote,
        adoptQuickNotes,
        offerQuickNoteDraft,
        requestQuickNoteFocus,
        resetQuickNotes,
        setQuickNotes,
    } from "$lib/document/quick-notes";
    import { peekPendingShare, takePendingShare } from "$lib/document/share-target";
    import {
        registerSpellingCommands,
        SPELLING_OPEN_SETTINGS,
    } from "$lib/document/commands/spelling-commands";
    import { setActiveSpellService } from "$lib/document/spelling/active-spell-service";
    import {
        adoptGraphDictionary,
        setGraphDictionary,
        subscribeGraphDictionary,
        unionDictionary,
    } from "$lib/document/spelling/graph-dictionary";
    import {
        dictionaryBaseUrl,
        getBrowserSpellService,
    } from "$lib/document/spelling/spell-service-host";
    import { bindSpellingNotices } from "$lib/document/spelling/spelling-notices";
    import { dictionaryHostLabel } from "$lib/document/spelling/ui/spelling-tab";
    import { isSpellCheckEnabled, subscribeSpellCheck } from "$lib/document/spell-check-preference";
    import { readDictionary, writeDictionary } from "$lib/storage/fs/dictionary-file";
    import {
        readQuickNotes,
        writeQuickNotes,
    } from "$lib/storage/fs/quick-notes-file";
    import {
        deleteGraphTheme,
        readGraphThemes,
        writeGraphTheme,
    } from "$lib/storage/fs/theme-files";
    import {
        adoptGraphThemes,
        getGraphTheme,
        getGraphThemes,
        resetGraphThemes,
        saveGraphTheme,
        removeGraphTheme,
        setGraphThemes,
        subscribeGraphThemes,
    } from "$lib/document/publish/theme/theme-store";
    import ThemeView, { THEME_TITLE_PREFIX } from "$lib/document/view/ThemeView.svelte";
    import { BACKLINKS_TITLE_PREFIX } from "$lib/document/view/BacklinksView.svelte";
    import PublishDocumentDialog from "$lib/document/ui/PublishDocumentDialog.svelte";
    import { bundledThemeList } from "@appsoftwareltd/etherpk-themes";
    import {
        copyThemeForGraph,
        createPublicationPage,
        freeThemeId,
        runPublish,
        setDocumentPublishing,
        summarisePublishing,
        updatePublicationPage,
        type NewPublicationInput,
    } from "$lib/workspace/publish-service";
    import { readLastPublication, readSettingsTab, writeLastPublication, writeSettingsTab, type SettingsTab } from "$lib/workspace/device-memory";
    import { SETTINGS_PARAM, settingsTabFromUrl, withSettingsTab, withoutSettingsTab } from "$lib/workspace/settings-url";
    import { folderPublishReader, readPublishSource } from "$lib/document/publish/source";
    import { readMembership } from "$lib/document/publish/publication";
    import { createThemeLoader } from "$lib/document/publish/theme/sources";
    import { createBrowserPublishEnvironment } from "$lib/document/publish/host/browser-environment";
    import { writeSiteToDirectory } from "$lib/document/publish/host/site-writer";
    import { downloadZip, zipSite } from "$lib/document/publish/host/zip";
    import type { Publication, PublishSource } from "$lib/document/publish/types";
    import type { PublishTabProps, PublishTarget, PublishOutcome } from "$lib/sync/ui/publish-tab";
    import {
        forgetPublicationFolder,
        readPublicationFolder,
        writePublicationFolder,
    } from "$lib/storage/publication-folder-idb";
    import { containsCipherFence } from "$lib/document/protection/fence-info";
    import { registerProtectionCommands } from "$lib/document/commands/protection-commands";
    import { ProtectionSession } from "$lib/document/protection/protection-session.svelte";
    import { DocumentNotFoundError } from "$lib/document/types";
    import {
        createProtectedDocumentStore,
        type ProtectedDocumentStore,
    } from "$lib/document/protection/protected-store";
    import {
        filesystemProtectionStore,
        inMemoryProtectionStore,
        localProtectionStore,
        vaultProtectionStore,
        type ProtectionRecordStore,
    } from "$lib/document/protection/protection-store";
    import {
        documentBody,
        type DocumentProtectionKind,
        documentProtection,
        protectDocumentText,
        unprotectDocumentText,
    } from "$lib/document/protection/cipher-fence";
    import { protectionTick } from "$lib/document/view/augmentations/protected-fence";
    import { isJournalConcept } from "$lib/document/journal-concept";
    import {
        bumpProtectionGeneration,
        setActiveProtectionStatus,
        type ProtectionStatus,
    } from "$lib/document/protection/active-protection";
    import { protectedDocumentPanels } from "$lib/document/protection/lock-now";
    import {
        readLockSettings,
        writeLockSettings,
    } from "$lib/document/protection/protection-settings";
    import {
        boundPasskey,
        enrolPasskey,
        passkeysAvailable,
        unlockWithPasskey,
    } from "$lib/document/protection/passkey-protection";
    import SetProtectionPassphraseDialog from "$lib/document/protection/ui/SetProtectionPassphraseDialog.svelte";
    import UnlockProtectionDialog from "$lib/document/protection/ui/UnlockProtectionDialog.svelte";
    import { registerTabCommands } from "$lib/layout/tab-commands";
    import {
        type AssetDeleteChoice,
        type AssetDeletePrompt,
        registerAssetCommands,
    } from "$lib/document/commands/asset-commands";
    import type { ProtectedAssetUsage } from "$lib/document/asset-delete";
    import {
        filesystemStoredTexts,
        protectedUsageReader,
        serverStoredTexts,
    } from "$lib/workspace/protected-asset-usage";
    import { protectedTextReader } from "$lib/document/protection/protected-text-reader";
    import { registerAssetViewers } from "$lib/document/view/viewers/register";
    import { canCopyImageAsset, canOpenAsset } from "$lib/document/asset-affordances";
    import { copyImageToClipboard } from "$lib/document/view/clipboard-image";
    import AssetView from "$lib/document/view/AssetView.svelte";
    import DeleteAssetDialog from "$lib/document/ui/DeleteAssetDialog.svelte";
    import {
        adoptFavourites,
        resetFavourites,
        setFavourites,
        renameFavourite,
    } from "$lib/document/favourites";
    import { createRecents, type RecentsStore } from "$lib/navigation/recents";
    import {
        type RenameLinkStrategy,
        type RenamePlan,
    } from "$lib/storage/rename";
    import ContextMenu from "$lib/surface/ui/ContextMenu.svelte";
    import {
        type CommandRegistry,
        type EventBus,
        attachKeybindings,
        createCommandRegistry,
        createContributionRegistry,
        createEventBus,
    } from "$lib/surface";
    import { describeFilesystemSaveFailure } from "$lib/storage/fs/save-error-copy";
    import {
        type AssetStore,
        type DocumentConflict,
        type FilesystemDocumentStore,
        attachReconciliation,
        createAssetStore,
        createFilesystemDocumentStore,
        createIdbGraphRegistry,
        createIdbGraphStoragePort,
        createWebFsDirectoryAdapter,
        ensureAgentInstructions,
        registerSyncedGraphOnDevice,
        readGraphSettings,
        sanitizeGraphSettings,
        withCachedToolbarColor,
        writeGraphSettings,
        type GraphSettings,
        ensurePermission,
        forgetMirrorFolder,
        getOpfsRoot,
        hasPermission,
        isOnDisk,
        pickGraphDirectory,
        readMirrorFolder,
        setLastGraphId,
        STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH,
        STORAGE_RECOVERY_HEADLINE,
        STORAGE_RECOVERY_INTRO,
        acknowledgeStorageRecoveries,
        storageRecoveryItems,
        subscribeStorageRecoveries,
        type StorageRecovery,
        writeMirrorFolder,
    } from "$lib/storage";
    import {
        type GraphAssetTools,
        filesystemAssetTools,
    } from "$lib/storage/fs/asset-orphans";
    import { displayAssetName } from "$lib/storage/fs/asset-store";
    import { opfsGraphFolderName } from "$lib/storage/fs/opfs-graph-folder";
    import {
        listCompleteServerAssetIds,
        listServerAssets,
        type ListedAsset,
        serverAssetTools,
    } from "$lib/storage/server/asset-orphans";
    import {
        createServerDocumentStore,
        type ServerDocumentStore,
    } from "$lib/storage/server/server-document-store";
    import { createServerAssetStore } from "$lib/storage/server/server-asset-store";
    import {
        MIRROR_PHASE_LABELS,
        createLocalMirror,
        type LocalMirror,
        type MirrorProgress,
        type MirrorStatus,
    } from "$lib/storage/server/local-mirror";
    import {
        createMirrorSource,
        type MirrorSourceDeps,
    } from "$lib/storage/server/mirror-source";
    import {
        checkMirrorTakeover,
        type MirrorTakeover,
    } from "$lib/storage/server/mirror-takeover";
    import {
        readKnownGraphFolders,
        readOnlyFolder,
    } from "$lib/storage/folder-ownership";
    import {
        runGraphExport,
        type ExportReport,
    } from "$lib/storage/server/export/graph-export";
    import {
        createSaveFileSink,
        createScratchFileSink,
        pickExportFile,
        saveFilePickerAvailable,
        type DeliverableSink,
    } from "$lib/storage/server/export/export-sink";
    import {
        EXPORT_SCRATCH_SWEEP_INTERVAL_MS,
        exportLockName,
        leftoverExportFor,
        opfsScratchStore,
        scratchFileName,
        sweepExportScratch,
        type ScratchFile,
    } from "$lib/storage/server/export/export-scratch";
    import type { ExportTabProps } from "$lib/sync/ui/mirror-tab";
    import { describeDeviceStorage } from "$lib/storage/storage-persistence";
    import { formatBytes } from "$lib/format-bytes";
    import { portableFileStem } from "$lib/document/wikilink";
    import {
        claimLockWhenFree,
        crossTabLocksAvailable,
        tryClaimLock,
    } from "$lib/cross-tab-lock";
    import { isRunning, runActivity } from "$lib/activity/store";
    import { dismissNotice, retractNotice, showNotice } from "$lib/activity/notices";
    import type { ActivityOutcome } from "$lib/activity/store";
    import type { ActivityProgress } from "$lib/activity/types";
    import type { MirrorIndicator } from "./mirror-indicator";

    /** One tab per graph owns the mirror folder; the rest queue behind this. */
    const MIRROR_LOCK_PREFIX = "etherpk-mirror-folder:";
    /**
     * Below this, a full pass is over before a toast would finish appearing, and showing one
     * would put a notice on screen for work nobody was waiting on.
     */
    const MIRROR_TOAST_MIN_ITEMS = 25;
    /** The mirror's phases, in the order a pass runs them - the Activity's declared steps. */
    const MIRROR_ACTIVITY_PHASES: readonly MirrorProgress["phase"][] = [
        "scanning",
        "reading",
        "writing",
        "assets",
    ];
    import RecoveryCodeDialog from "$lib/sync/ui/RecoveryCodeDialog.svelte";
    import UnlockDialog from "$lib/sync/ui/UnlockDialog.svelte";
    import GraphSettingsDialog from "$lib/sync/ui/GraphSettingsDialog.svelte";
    import type { AgentsTabProps } from "$lib/sync/ui/agents-tab";
    import ConfirmDialog from "@appsoftwareltd/etherpk-shared/confirm-dialog";
    import WorkspaceOpenState from "./WorkspaceOpenState.svelte";
    import WorkspaceToolbar from "./WorkspaceToolbar.svelte";
    import KeyboardShortcutsDialog from "./KeyboardShortcutsDialog.svelte";
    import { APP_KEYBINDINGS } from "./keyboard-shortcuts";
    import {
        createDocumentMutationController,
        deleteDocumentMessage,
        deleteRefusedAsIncludeMessage,
        renameDocumentSummary,
    } from "./document-mutations";
    import {
        createFrontmatterController,
        type DocumentIdentity,
    } from "./frontmatter-controller";
    import { withFrontmatterIdentity } from "$lib/document/frontmatter/identity";
    import { referencedInBody } from "$lib/document/index-db";
    import { proposeFrontmatter } from "$lib/document/frontmatter/proposal";
    import { frontmatterSpan } from "$lib/storage/fs/frontmatter-span";
    import { conceptKey, fileStem } from "$lib/storage/fs/identity";
    import type { Subdir } from "$lib/storage/fs/directory-adapter";
    import {
        joinGraphPath,
        readGraphFolderPath,
        writeGraphFolderPath,
    } from "$lib/storage/fs/folder-path";
    import GraphFolderPathDialog from "$lib/storage/ui/GraphFolderPathDialog.svelte";
    import { isScopedBy, rewriteWikilinkScope } from "$lib/document/wikilink/rename";
    import { createLinkRenameController } from "./link-rename-controller";
    import {
        createGraphSync,
        openGraphCache,
        browserTransport,
        createConfiguredSyncApi,
        createGraphNamePublisher,
        describeSyncFailure,
        ensureGraphKeys,
        readActiveSyncAccount,
        readSyncConfig,
        resolveSyncConnection,
        resolveSyncedGraphConnection,
        getVaultWrapKey,
        vaultProtectionAccess,
        setVaultWrapKey,
        VaultLockedError,
        fixedSyncToken,
        presenceIdentity,
        SYNC_CONFIG_STORAGE_KEY,
        type GraphCache,
        type GraphSync,
        type SyncAccessLoss,
        type SyncActivity,
        type SyncApi,
        type SyncTokenSource,
        type WriteRefusal,
    } from "$lib/sync";
    import {
        AccountEnded,
        onAccountSignal,
        type AccountEndReason,
    } from "$lib/sync/account-signal";
    import {
        describeAccessLoss,
        workspaceAccessLoss,
        type WorkspaceAccessLoss,
    } from "$lib/sync/access-loss";
    import { readUnsentChanges, saveUnsentChangesFile } from "$lib/sync/unsent-changes";
    import {
        createIndicatorSettle,
        describeSyncActivity,
        type SyncChipAction,
        type SyncIndicator,
    } from "$lib/sync/sync-indicator";
    import { describeWriteRefusal, type WriteRefusalCopy } from "$lib/sync/write-refusal";
    import { syncPlanNotice, type SyncPlanNotice } from "$lib/sync/sync-plan-notice";
    import SyncStateChip from "$lib/sync/ui/SyncStateChip.svelte";
    import {
        createGraphKeyring,
        fromBase64Url,
        type ProtectionRecord,
    } from "$lib/crypto";
    import {
        diagnoseMissingGraph,
        type MissingGraphDiagnosis,
    } from "./graph-availability";
    import {
        GraphSessionCancelledError,
        createGraphSession,
        type GraphOpenAttempt,
    } from "./graph-session";
    import {
        clearWorkspaceServices,
        createWorkspaceHealth,
        currentWorkspaceServices,
        publishWorkspaceServices,
        updateWorkspaceServices,
        type WorkspaceGeneration,
    } from "./workspace-services";
    import {
        clearGraphAccent,
        graphAccentFor,
        setGraphAccent,
    } from "./graph-accent.svelte";
    import { sidebarTabTitle } from "./sidebar-tab-title";

    /** Dev/e2e Server Backend gate (Phase 3): injected relay + raw graph key. */
    interface ServerGate {
        relay: string;
        token: string;
        gkey: string;
        root: string;
        /** Optional asset-API base URL - lets e2e drive the real encrypted-asset flow. */
        http?: string;
    }

    let {
        graphId,
        opfs,
        autosaveMs,
        server,
    }: {
        graphId: string;
        opfs: boolean;
        autosaveMs?: number;
        server?: ServerGate;
    } = $props();

    let session: ReturnType<typeof createGraphSession>;
    const health = createWorkspaceHealth();
    let openAttempt: GraphOpenAttempt | undefined;
    let workspaceGeneration: WorkspaceGeneration | undefined;

    type Phase =
        | "loading"
        | "needs-permission"
        | "needs-unlock"
        | "ready"
        | "missing"
        | "error"
        | "access-lost";
    let phase = $state<Phase>("loading");
    /**
     * Why this synced graph stopped syncing for good, once it has: the membership ended, the
     * account signed out or disconnected (here or in another tab), or the Sync Server refused this
     * device's credential. The workspace is replaced by a notice saying so; nothing more can be
     * typed into a graph that can no longer be saved.
     */
    let accessLoss = $state<WorkspaceAccessLoss | null>(null);
    const accessLostNotice = $derived(accessLoss ? describeAccessLoss(accessLoss) : null);
    let downloadingUnsent = $state(false);
    let unsentDownloadError = $state<string | null>(null);
    /**
     * A [[Share Target]] share is waiting for THIS graph (ADR 0087): read as the open starts,
     * so an open that stalls or fails can say the text is safe and where to take it. Cleared
     * the moment the note lands.
     */
    let shareWaiting = $state(false);
    /** The share was added while the open was still running; the loading notice says so. */
    let shareLanded = $state(false);
    /** Reveal the Quick Notes resident as the presenter mounts: the share landed before one existed. */
    let revealQuickNotesOnMount = false;
    /** Set with the `missing` phase: which of the registry-miss cases this is. */
    let missing = $state<MissingGraphDiagnosis | null>(null);
    let settingUp = $state(false);
    let setupError = $state<string | null>(null);
    /**
     * A save to the Local Cache failed. Persistent, unlike `message`: until it is retried or
     * the page reloads, every further keystroke is at risk, and a transient toast is how a
     * stream of such failures once read as one brief flash (2026-09-01).
     */
    let saveFailure = $state<string | null>(null);
    let retryingSave = $state(false);
    /**
     * Whether the failure notice may offer "Reload the page": safe on the Server path, whose
     * outbox is durable, but a reload on the Filesystem path discards the buffer the failed
     * write still holds, so that path sets it false and offers Retry alone.
     */
    let saveFailureReloadable = $state(true);
    /**
     * Filesystem Backend documents whose last write failed. Retry flushes exactly
     * these; a write that fails again re-adds its document through onSaveError, so the set is
     * the outcome signal. Read only inside handlers, so it needs no reactivity.
     */
    const fsSaveFailures = new Set<string>();

    // What the open is doing right now. `loading` used to render NOTHING, so opening a large
    // graph was a blank screen for several seconds with no sign of progress.
    type LoadingStep = "opening" | "loading" | "indexing";
    let loadingStep = $state<LoadingStep>("opening");
    let indexed = $state<{ done: number; total: number } | null>(null);

    let indexTransport: IndexTransport | undefined;
    /**
     * [[Search]] is app-global chrome with GRAPH-SCOPED delivery (ADR 0014): the controller is
     * created per graph, over that graph's index, and torn down with it. There is no
     * cross-graph search - one [[Derived Index]] per graph, one set of keys per graph.
     */
    let searchController = $state<SearchController | null>(null);
    let showIndexNotice = $state(false);
    /** Null until an index exists; then whether it survives a reload (shown in settings). */
    let indexPersisted = $state<boolean | null>(null);
    /** Why the current transport is temporary, when the worker can identify the cause. */
    let indexPersistenceBlocked = $state<"held" | "unsupported" | undefined>();
    /** The notice text: the held-elsewhere variant is actionable, so it wins when known. */
    let indexNoticeMessage = $state(INDEX_NOT_PERSISTED_MESSAGE);
    function noteIndexNotPersisted(blocked?: "held" | "unsupported") {
        indexNoticeMessage =
            blocked === "held"
                ? INDEX_POOL_HELD_MESSAGE
                : INDEX_NOT_PERSISTED_MESSAGE;
        // The held variant is actionable and transient, so it is not silenced by the
        // once-per-device acknowledgement of the capability notice.
        if (blocked === "held" || !indexNoticeAcknowledged())
            showIndexNotice = true;
    }
    function applyIndexPersistence(status: {
        persisted: boolean;
        blocked?: "held" | "unsupported";
    }) {
        indexPersisted = status.persisted;
        indexPersistenceBlocked = status.blocked;
        if (status.persisted) {
            // A held pool is temporary. Once ownership moves to this worker, remove the
            // warning without requiring a reload or another user dismissal.
            showIndexNotice = false;
            indexNoticeMessage = INDEX_NOT_PERSISTED_MESSAGE;
            return;
        }
        noteIndexNotPersisted(status.blocked);
    }
    /**
     * Discard and re-derive the [[Derived Index]] on request (Graph Settings → Storage, and the
     * `index.rebuild` Command). `indexed` is cleared first: it still holds the initial build's
     * final count, which would otherwise read as a rebuild already at "N of N" until the worker's
     * first progress message replaced it.
     */
    async function rebuildIndex(): Promise<void> {
        if (!graphIndex) throw new Error("No graph is open.");
        indexed = null;
        await graphIndex.rebuild();
        // A rebuild is the cure for whatever the background refresh had reported (a corrupt
        // file, most likely); leaving that notice standing after the cure would read as failure.
        health.clear("index-refresh-failed");
    }
    /**
     * The workspace's one-line status. In the `error` phase it explains why the graph would
     * not open; once ready it reports what a completed action did — the rename summary
     * (ADR 0038 §5: a cascade or a merge is never silent), the delete, a resurrection
     * (ADR 0039 §4), a settings-save failure. Once the graph is open these go through
     * `notify` to the app's notice rail (`$lib/activity/notices`), beside the Activity
     * Toasts; `message` itself is what the open-state notice shows when the open fails.
     */
    let message = $state("");
    /** The workspace's one status line in the rail: a new notice replaces the last. */
    const STATUS_NOTICE = "workspace-status";
    /**
     * Set when this tab has restored the graph's registry record or passkey wrap from the
     * device's safety copy (storage/safety-copy.ts), which is what the registry lookup in
     * `resolveRoot` and the passkey check at open do on their own when the browser has dropped
     * IndexedDB. Persistent until dismissed, like the save failure: the documents are about to
     * download again and the person should know it was the browser, not the sync server.
     */
    let storageRecovery = $state.raw<readonly StorageRecovery[]>([]);
    /** The banner's bullets; a passkey names this graph, the only one whose name is known here. */
    const storageRecoveryLines = $derived(
        storageRecoveryItems(storageRecovery, (id) => (id === graphId ? graphDisplayName || undefined : undefined)),
    );

    /**
     * Show the status, replacing whatever was showing. A "Could not …" stays until closed;
     * anything else goes by itself after the rail's shared delay.
     */
    function notify(text: string) {
        showNotice({
            id: STATUS_NOTICE,
            text,
            tone: text.startsWith("Could not") ? "error" : "info",
        });
    }
    /** Take a status down early, if it is still the one showing. */
    function retract(text: string) {
        retractNotice(STATUS_NOTICE, text);
    }

    /** Recompute the chip from the session's activity; passing states wait (sync-indicator.ts). */
    function refreshSyncIndicator(): void {
        if (!syncActivity) {
            syncIndicator = null;
            return;
        }
        syncIndicatorSettle ??= createIndicatorSettle((indicator) => (syncIndicator = indicator));
        syncIndicatorSettle.update(describeSyncActivity(syncActivity, browserOnline, refusalCopy?.reason));
    }

    /** Follow a new graph session's activity: the chip, and the refusal card when writes are refused. */
    function watchSyncActivity(sg: GraphSync): void {
        syncActivity = sg.activity();
        refusalCopy = null;
        refusalNoticeDismissed = false;
        refreshSyncIndicator();
        sg.onActivity((activity) => {
            if (sg !== serverGraph) return;
            const before = syncActivity?.refusal ?? null;
            syncActivity = activity;
            if (activity.refusal && (!before || before.quotaCode !== activity.refusal.quotaCode)) {
                void explainRefusal(sg, activity.refusal);
            } else if (!activity.refusal && before) {
                writesAcceptedAgain();
            }
            refreshSyncIndicator();
        });
    }

    /**
     * Word a write refusal for this person. Said at once with what is known (a managed or a
     * self-hosted server), then refined once the account says whether this person owns the graph
     * and what their plan is: an owner can restart Sync+ or fix a payment, a Player can only wait
     * for the owner.
     */
    async function explainRefusal(sg: GraphSync, refusal: WriteRefusal): Promise<void> {
        const managed = serverAtOpen?.managed ?? false;
        refusalNoticeDismissed = false;
        refusalCopy = describeWriteRefusal({ refusal, owner: null, plan: null, managed });
        const api = serverApi;
        if (!api) return;
        const [account, graphs] = await Promise.all([
            api.me().catch(() => null),
            api.listGraphs().catch(() => null),
        ]);
        if (sg !== serverGraph || syncActivity?.refusal?.quotaCode !== refusal.quotaCode) return;
        const plan: SyncPlanNotice = account ? syncPlanNotice(account) : null;
        const record = graphs?.find((graph) => graph.id === graphId);
        refusalCopy = describeWriteRefusal({
            refusal,
            owner: record ? record.role === "owner" : null,
            plan,
            managed,
        });
        refreshSyncIndicator();
    }

    /** The server accepted a write after refusing: say so once, and take the refusal card down. */
    function writesAcceptedAgain(): void {
        refusalCopy = null;
        refusalNoticeDismissed = false;
        showNotice({
            id: WRITES_RESUMED_NOTICE,
            tone: "info",
            text: "The sync server is accepting changes again. What was kept on this device is syncing now.",
        });
    }

    /** The Billing page on EtherPK, when this Client is configured for Managed Sync. */
    const billingUrl = $derived((page.data.corporateBillingUrl as string | null | undefined) ?? null);

    /** What the chip's panel and the refusal card offer; the same list in both places. */
    const syncChipActions = $derived.by((): SyncChipAction[] => {
        const actions: SyncChipAction[] = [];
        if (!syncActivity) return actions;
        if (syncActivity.refusal && refusalCopy?.billing && billingUrl) {
            actions.push({ id: "sync-state-billing", label: refusalCopy.billing.label, href: billingUrl });
        }
        if (syncActivity.refusal) {
            actions.push({ id: "sync-state-retry", label: "Try again now", run: () => serverGraph?.retryRefused() });
        }
        const unsent = syncIndicator?.unsent ?? 0;
        if (unsent > 0 && syncIndicator?.state !== "sending" && syncIndicator?.state !== "synced") {
            actions.push({
                id: "sync-state-download",
                label: downloadingUnsent ? "Preparing download…" : "Download unsent changes",
                disabled: downloadingUnsent,
                run: () => void downloadUnsentFromChip(),
            });
        }
        return actions;
    });

    /** The access-lost download, from the chip: a failure is reported in the rail, not in a notice the workspace hides. */
    async function downloadUnsentFromChip(): Promise<void> {
        await downloadUnsentChanges();
        if (unsentDownloadError) notify(`Could not download the unsent changes. ${unsentDownloadError}`);
    }

    /**
     * The workspace's three STANDING notices - a save that failed, the search index held or
     * unstorable, records restored from the safety copy - live in the same rail as the status
     * line and the Activity Toasts (ADR 0035), each keyed so a change re-posts it in place.
     * Effects, because each is a projection of workspace state that changes from several
     * places (a failed write, a retry, a worker status, a subscription), and the notice store
     * is outside Svelte's reactivity. Every card stays until closed; closing one is the
     * acknowledgement, and the effect only re-posts once the state behind it changes again.
     */
    const SAVE_FAILURE_NOTICE = "workspace-save-failure";
    /** Writes refused by the Sync Server on a quota, and their end. */
    const WRITE_REFUSED_NOTICE = "workspace-write-refused";
    const WRITES_RESUMED_NOTICE = "workspace-writes-resumed";
    $effect(() => {
        if (phase !== "ready" || !refusalCopy || refusalNoticeDismissed) {
            dismissNotice(WRITE_REFUSED_NOTICE);
            return;
        }
        showNotice({
            id: WRITE_REFUSED_NOTICE,
            tone: "error",
            title: "Changes are not reaching the sync server",
            text: `${refusalCopy.reason} ${refusalCopy.next}`,
            actions: syncChipActions.map((action) => ({
                id: `${action.id}-notice`,
                label: action.label,
                primary: action.href !== undefined,
                disabled: action.disabled,
                run: () => {
                    if (action.href) window.open(action.href, "_blank", "noopener");
                    else action.run?.();
                },
            })),
            ondismiss: () => (refusalNoticeDismissed = true),
        });
    });
    const INDEX_NOTICE = "index-not-persisted";
    const STORAGE_RECOVERY_NOTICE = "workspace-storage-recovered";
    $effect(() => {
        if (phase !== "ready" || !saveFailure) {
            dismissNotice(SAVE_FAILURE_NOTICE);
            return;
        }
        showNotice({
            id: SAVE_FAILURE_NOTICE,
            tone: "error",
            text: saveFailure,
            actions: [
                {
                    id: "workspace-save-retry",
                    label: retryingSave ? "Retrying…" : "Retry saving",
                    primary: true,
                    disabled: retryingSave,
                    run: retrySave,
                },
                ...(saveFailureReloadable
                    ? [
                          {
                              id: "workspace-save-reload",
                              label: "Reload the page",
                              run: () => location.reload(),
                          },
                      ]
                    : []),
            ],
            ondismiss: () => (saveFailure = null),
        });
    });
    $effect(() => {
        if (phase !== "ready" || !showIndexNotice) {
            dismissNotice(INDEX_NOTICE);
            return;
        }
        // Read here, not in `ondismiss`: the close must record the variant that was showing.
        const held = indexPersistenceBlocked === "held";
        showNotice({
            id: INDEX_NOTICE,
            tone: "info",
            dismissal: "manual",
            text: indexNoticeMessage,
            ondismiss: () => {
                // A held pool is a transient ownership state, not a permanent browser
                // capability. Dismissing it must not silence a later genuine capability
                // warning on this device.
                if (!held) acknowledgeIndexNotice();
                showIndexNotice = false;
            },
        });
    });
    $effect(() => {
        if (phase !== "ready" || storageRecoveryLines.length === 0) {
            dismissNotice(STORAGE_RECOVERY_NOTICE);
            return;
        }
        showNotice({
            id: STORAGE_RECOVERY_NOTICE,
            tone: "info",
            dismissal: "manual",
            title: STORAGE_RECOVERY_HEADLINE,
            text: STORAGE_RECOVERY_INTRO,
            items: [...storageRecoveryLines],
            footnote: STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH,
            ondismiss: acknowledgeStorageRecoveries,
        });
    });
    /**
     * Run `work` with a status shown only if it takes longer than a beat - a check that
     * finishes at once must not flash a banner - and taken down the moment it finishes.
     */
    async function withProgressNotice<T>(text: string, work: () => Promise<T>): Promise<T> {
        const timer = setTimeout(() => notify(text), 250);
        try {
            return await work();
        } finally {
            clearTimeout(timer);
            retract(text);
        }
    }
    // Recovery Code shown once when a fresh account's vault is created; mirror takeover confirm.
    let pendingRecoveryCode = $state<string | null>(null);
    /**
     * The answer to a folder chosen for the mirror that needs the user first: what mirroring
     * there would delete and replace, or why it is refused. `handle` is carried for a
     * confirmation, so confirming starts the mirror on exactly the folder that was checked.
     */
    let mirrorTakeover = $state<
        | ((MirrorTakeover & { kind: "confirm" }) & {
              handle: FileSystemDirectoryHandle;
              folder: string;
          })
        | (MirrorTakeover & { kind: "refuse" })
        | null
    >(null);

    let container = $state<HTMLDivElement>();
    let controller = $state<LayoutController>();
    let mobileRenderer = $state<MobileRenderer>();
    let useMobile = $state(false);
    let renderer: LayoutRenderer | undefined;
    // Either backend — ServerDocumentStore is structurally a superset of the FS store
    // (same seam methods, plus getYText). The shared openGraph tail consumes only the
    // common surface, so downstream (index, bus, layout) is backend-agnostic.
    let store: FilesystemDocumentStore | ServerDocumentStore | undefined;
    /**
     * The protection projection over `store` (ADR 0059). Published as the workspace's document
     * store so every editor surface sees a Protected Document's plaintext while unlocked; the
     * **raw** `store` is what goes to the index, which must only ever see ciphertext.
     */
    let protectedStore: ProtectedDocumentStore | undefined;
    let protection = $state<ProtectionSession | undefined>(undefined);
    /**
     * Set-passphrase dialog state. `then` is the action that triggered it, resumed once a key
     * exists — without it the first Protect on an unprotected graph only sets the passphrase and
     * protects nothing, which reads as the command being broken. `concept` is what the dialog
     * says the action applies to, or null when it was a block rather than a whole document.
     */
    let settingProtectionPassphrase = $state<{
        concept: string | null;
        then: (() => void) | null;
    } | null>(null);
    let unlockingProtection = $state<{
        hasPasskey: boolean;
        then: (() => void) | null;
    } | null>(null);
    /** A concept Protect was asked of before it had a document - a [[Draft]] nothing has been typed into. */
    let protectingDraft = $state<string | null>(null);
    /**
     * A protect asked of a document that is public or a publication's include: never both, so
     * the dialog says what protecting withdraws and asks first (the tab has one mark slot for
     * the padlock and the globe because of exactly this rule).
     */
    let protectingPublic = $state<{ concept: string; isPublic: boolean; uses: string[] } | null>(null);
    let protectionPasskeyBound = $state(false);
    let serverGraph: ReturnType<typeof createGraphSync> | undefined;
    /** The synced graph's Local Cache and root document, for the unsent-changes count and download. */
    let serverCache: GraphCache | undefined;
    let serverRootDocId: string | undefined;
    /**
     * The device's Sync connection when this graph opened from the registry, as stored. Another
     * tab clearing or replacing it means this tab's connection is gone; null on the dev
     * gate's graphs, which have no device connection to lose.
     */
    let syncConfigAtOpen: string | null = null;
    let serverAtOpen: { managed: boolean; server: string } | null = null;
    /** The account API behind a registry graph, to word a write refusal; null under the dev gate. */
    let serverApi: SyncApi | null = null;
    /**
     * The synced graph's sync state for the chip: the session's activity, the browser's online
     * flag, and why the server refuses writes, worded for this person. `syncActivity` is null for
     * a folder graph, which shows no chip.
     */
    let syncActivity = $state.raw<SyncActivity | null>(null);
    let browserOnline = $state(true);
    let refusalCopy = $state.raw<WriteRefusalCopy | null>(null);
    /** The person closed the refusal card; the chip still says it, and a new refusal re-posts it. */
    let refusalNoticeDismissed = $state(false);
    let syncIndicator = $state.raw<SyncIndicator | null>(null);
    let syncIndicatorSettle: ReturnType<typeof createIndicatorSettle> | null = null;
    let isServerStore = $state(false);
    // Orphaned-asset scan/cleanup for the Graph Settings dialog, built per backend at open.
    let assetTools = $state<GraphAssetTools | null>(null);
    /** Enumerates the graph's assets for the [[Local Mirror]]; server graphs with storage only. */
    let listMirrorAssetIds: (() => Promise<string[]>) | null = null;
    // Storage Footprint fetch (ADR 0033) - real server path only; null elsewhere.
    let fetchGraphStorage:
        | (() => Promise<{ docBytes: number; assetBytes: number }>)
        | null = null;
    // Filesystem backend: the adapter + current settings back the settings dialog's save.
    let fsAdapter: ReturnType<typeof createWebFsDirectoryAdapter> | undefined;
    let currentFsSettings: GraphSettings = {};
    /**
     * The graph's toolbar colour (Graph Settings, ADR 0071), or empty for the theme's own
     * surface. Read from the graph-accent singleton rather than off the settings object: the
     * other settings are consumed by the editor through a service accessor, but this one paints
     * the shell, so the shell must re-render when it changes - on save here, or from a peer -
     * and the application header's Graphs menu, outside this root, paints the open graph's row
     * with it (graph-accent.svelte.ts). Applied as a CSS custom property on the workspace root,
     * which both presenters' top bars read as their background: the desktop toolbar and the
     * mobile strip, neither of which knows about Graph Settings. The buttons on either bar paint
     * their own theme surface over it.
     */
    const toolbarStyle = $derived.by(() => {
        const color = graphAccentFor(graphId);
        return color ? `--gk-toolbar-accent: ${color};` : "";
    });
    /**
     * Title the Graph Sidebar's dockview tab from the current name. The tab is titled once, when
     * its panel is created, and two things make that stale: a restored Layout carries the title
     * it was saved with (dockview's `fromJSON` keeps it, so a graph opened under an older build
     * or before its name was known says "Graph" forever), and a synced graph's name arrives
     * later with the root doc's meta, as a rename does. So this runs after every mount, once
     * the Layout is restored, and again whenever the name changes. The phone presenter reads
     * the registry title live and has no `setTitleForKind`, so it is a no-op there.
     */
    function retitleSidebar() {
        // The title is read BEFORE the renderer is consulted: the effect below only depends on
        // what it actually read, and with no renderer yet the optional chain would skip the
        // name, leaving an effect that never re-runs when the name changes.
        const title = sidebarTabTitle(graphDisplayName, graphId);
        renderer?.setTitleForKind?.("document-tree", title);
    }
    $effect(() => {
        retitleSidebar();
    });
    /**
     * The graph folder's leaf name (its directory handle's), the one part of its path the
     * browser knows. Set only for a folder on disk: undefined on a Server graph and on a graph
     * in browser-private storage (an OPFS dev-gate graph, the demo graph), which has no path a
     * tool outside the browser could use, so "Copy full file path" is not offered there.
     */
    let fsFolderName = $state<string | undefined>(undefined);
    /**
     * "Copy full file path" asked on a device that has not been told where the graph folder is
     * (folder-path.ts): the concept whose path is wanted once the folder path is entered.
     */
    let folderPathPrompt = $state<{ concept: string } | null>(null);
    let mirror: LocalMirror | undefined;
    /** What the running mirror reports, shown on Settings → Mirror; null when there is none. */
    let mirrorStatus = $state<MirrorStatus | null>(null);
    /** The folder a running mirror writes to, so a permission it lost can be asked for again. */
    let mirrorHandleInUse: FileSystemDirectoryHandle | undefined;
    /** A folder this device remembers but has not been granted access to in this session. */
    let mirrorNeedsPermission = $state<{
        handle: FileSystemDirectoryHandle;
        folder: string;
    } | null>(null);
    /**
     * Cross-tab ownership of this graph's folder (ADR 0042's mechanism, a different job). Two
     * tabs of one graph would otherwise both mirror it: the same bytes written twice, every
     * missing attachment downloaded twice, and two sweeps racing over one folder. The lock also
     * hands the folder over by itself when the owning tab closes.
     */
    let releaseMirrorLock: (() => void) | undefined;
    let cancelMirrorClaim: (() => void) | undefined;
    /** True while another tab of this browser holds the folder. */
    let mirrorHeldElsewhere = $state(false);
    // ── Export (ADR 0092): the tab's other half ──────────────────────────────────────────
    /** What the archive would hold, counted from the server's asset list when the tab opens. */
    let exportEstimate = $state<ExportTabProps["estimate"]>(null);
    let exportRunning = $state(false);
    /**
     * An archive that finished with something left out, held by its sink - the picker's swap
     * file, or the scratch file not yet offered - until Keep or Discard (ADR 0092, decision 6).
     */
    let pendingExport = $state.raw<{
        report: ExportReport;
        sink: DeliverableSink;
        fileName: string;
        release: () => void;
    } | null>(null);
    /** This graph's scratch file left from an earlier export and not in use, for the tab to name. */
    let exportLeftover = $state.raw<ScratchFile | null>(null);
    /** The server's asset list with sizes, for the export's estimate; null off the real server path. */
    let listExportAssets: (() => Promise<ListedAsset[]>) | null = null;
    /**
     * The graph's protection record store, and the record as last read (ADR 0093): what the
     * mirror and the export write as `etherpk/protection.json`. `null` is "the graph has none",
     * `undefined` is "not known right now", which the mirror leaves alone rather than deleting.
     */
    let protectionRecordStore: ProtectionRecordStore | undefined;
    let protectionRecord: ProtectionRecord | null | undefined;
    const protectionRecordListeners = new Set<() => void>();
    /** The Activity reporting a long full pass, and how to finish it (ADR 0035). */
    let mirrorActivity:
        | {
              report: (progress: ActivityProgress) => void;
              finish: (outcome?: ActivityOutcome) => void;
          }
        | undefined;
    // Graph Name + shared settings (root-doc meta map, ADR 0031) — server graphs only.
    let graphDisplayName = $state("");
    let graphSettingsDialog = $state<{
        name: string;
        settings: GraphSettings;
        storage: { docBytes: number; assetBytes: number } | null;
        /**
         * The tab the entry names, kept in step by the effect on settingsTab while the modal
         * is open. Carried here rather than read straight off settingsTab in the template,
         * because on the way out (Back) that is null for a flush before the modal unmounts,
         * and a prop of "general" then would swap the tab's content for nothing.
         */
        tab: SettingsTab;
        /** A publication whose last report the Publish tab opens on (a finished publish's toast). */
        publishReport?: string;
    } | null>(null);
    /**
     * The tab the current history entry names for [[Settings]], or null while it is closed
     * (ADR 0023, 2026-09-20). Read off the entry's state rather than the URL: SvelteKit's shallow
     * pushState/replaceState never update `page.url`, so the address is written for reload,
     * deep links and people, and the state is what the modal follows. A real navigation
     * carrying `?settings=` gets its state from the URL once, in adoptSettingsFromUrl.
     */
    const settingsTab = $derived(page.state.etherpkSettings?.tab ?? null);
    /** A toast's "show report" carried from openGraphSettings to the open that follows the history write. */
    let pendingPublishReport: string | undefined;
    /** Which showGraphSettings run is current, so an older one cannot land after Back closed the modal. */
    let settingsShowToken = 0;
    /** The Keyboard Shortcuts card; a reference, so nothing to carry in but "open". */
    let shortcutsDialogOpen = $state(false);
    /** The Reset workspace confirmation is showing. */
    let resetDialogOpen = $state(false);
    let detachMeta: (() => void) | undefined;
    let metaSeedTimer: ReturnType<typeof setTimeout> | undefined;
    let assetStore: AssetStore | undefined;
    let graphIndex: RemoteGraphIndex | undefined;
    /** Temporary foreground claim bridging graph open to the real DocumentView retain. */
    let releasePreloadedDocument: (() => void) | undefined;
    let preloadedDocumentReady: Promise<void> | undefined;
    let layoutStore: LayoutStore | undefined;
    let bus: EventBus | undefined;
    let detachDocsBridge: (() => void) | undefined;
    let detachDocRemoved: (() => void) | undefined;
    let detachDocRenamed: (() => void) | undefined;
    let detachActiveForProtection: (() => void) | undefined;
    let detachActiveForBacklinks: (() => void) | undefined;
    let commandRegistry: CommandRegistry | undefined;
    let detachKeybindings: (() => void) | undefined;
    let detachEditorCommands: (() => void) | undefined;
    let detachLinkCommands: (() => void) | undefined;
    let detachDocumentCommands: (() => void) | undefined;
    let detachQuickNotesCommands: (() => void) | undefined;
    let detachSpellingCommands: (() => void) | undefined;
    let detachProtectionCommands: (() => void) | undefined;
    let detachAssetCommands: (() => void) | undefined;
    let detachTabCommands: (() => void) | undefined;
    let detachAssetViewers: (() => void) | undefined;
    /**
     * The open [[Asset]] delete dialog and the promise the Command is waiting on. One at a
     * time: the Command awaits the user's answer, so a second delete cannot start until the
     * first is resolved.
     */
    let deletingAsset = $state<{
        prompt: AssetDeletePrompt;
        decide: (choice: AssetDeleteChoice) => void;
    } | null>(null);
    let detachRenderers: (() => void) | undefined;
    /** Per-device Recents for this graph (ADR 0036 §3); null until the graph opens. */
    let recents: RecentsStore | null = null;

    const documentMutations = createDocumentMutationController({
        store: () => store,
        index: () => graphIndex,
        layout: () => controller,
        recents: () => recents,
        renameFavourite,
    });

    // ── Protection (ADR 0057-0059) ──────────────────────────────────────────────────────────
    // The workspace owns the dialogs and the store writes; the commands only decide when to
    // offer an action, and the session owns the key and the lock lifecycle.

    /**
     * Shown when the graph's protection record could not be read in time — on a Server Backend
     * that is a vault fetch, and the answer decides whether this graph has a key at all. Acting
     * without it would offer to set a passphrase for a graph that already has one.
     */
    const PROTECTION_UNREACHABLE =
        "Could not check this graph’s protection. Check your connection and try again.";

    /**
     * A failed read keeps "try again"; a record that is there but unusable (damaged, or written
     * by a newer build) names itself and says what to do instead.
     */
    function protectionProblemMessage(): string {
        const problem = protection?.recordProblem;
        if (problem?.kind === "invalid") return `Could not check this graph’s protection: ${problem.message}.`;
        return PROTECTION_UNREACHABLE;
    }

    /**
     * Tell the editors that what they should draw for a protected fence has changed — a lock
     * transition, or a decryption landing. Neither is a document change, so nothing would redraw
     * on its own.
     *
     * Bumps the shared generation as well as dispatching, because the dispatch only reaches the
     * ACTIVE view: a second document pane would otherwise keep showing a locked card after the
     * graph was unlocked. The generation is what every other mounted editor watches.
     */
    function notifyProtectionChanged(): void {
        bumpProtectionGeneration();
        repaintTabPadlocks();
        // Graph-wide, for the surfaces that cannot watch the generation: the sidebar's lock
        // control, and a collab-bound editor that has to remount to show a projection.
        bus?.emit("protection:changed", {});
        const view = getActiveEditorView();
        if (view) view.dispatch({ effects: protectionTick.of() });
        // A lock transition is not a selection or doc change, so the Command Bar's mirror of
        // `bodyWritable` would otherwise keep the buttons live after the key had gone.
        refreshEditorContext(view);
    }

    /**
     * A document's protection changed. Two things must happen and only one of them is a redraw.
     *
     * The View must **remount**, not repaint: whether a document is collab-bound is decided once,
     * at mount, from whether the store hands over a `Y.Text` — and protection is exactly what
     * decides that (a Protected Document is withheld one, so it binds to the projection instead).
     * A document protected while its tab was already open would otherwise stay bound to the CRDT,
     * and unlocking it would update a buffer nothing was listening to.
     */
    function announceProtectionChanged(concept: string | null): void {
        notifyProtectionChanged();
        if (concept)
            bus?.emit("document:protection-changed", { documentId: concept });
    }

    /**
     * A [[Lock Now]]: the user's deliberate lock, as distinct from the app locking on its own.
     *
     * The three places the user can press it - the Sidebar control, a document's padlock and the
     * Command - all come through here, and nothing else does: the session's own `lockNow()` is
     * also what `pagehide` and a graph switch call, and those must never reach the Layout.
     *
     * Lock FIRST, then close. The lock's commit-before-discard is what guarantees nothing typed
     * is lost, and closing a locked tab is an already-supported path; closing first would run
     * every View's leave-tidy under a key that is about to go. Which tabs go is the padlock's own
     * predicate, so what closes is what the user can see will close.
     */
    function lockNow(): void {
        protection?.lockNow();
        if (!controller || !readLockSettings().closeOnLockNow) return;
        const ids = protectedDocumentPanels(
            controller.serialize().model,
            (target) => protectionKindOf(target) === "document",
        );
        for (const id of ids) controller.closePanel(id);
    }

    /**
     * A Protected Document's plaintext for the asset safety checks: the orphan scan and the
     * in-document delete search document text for an asset, and a protected document's text is
     * ciphertext. Read through the session at call time, so a scan run after unlocking reads
     * what one run before could not; null while locked or when the key is another member's.
     */
    async function readProtectedText(text: string): Promise<string | null> {
        const session = protection;
        return session ? protectedTextReader(session.service)(text) : null;
    }

    /**
     * Bring every pending edit to stored text before a check that reads it: an open protected
     * document's projection encrypts on a debounce (up to a minute while typing), and a
     * Filesystem Backend writes each buffer on an autosave debounce, so an image pasted moments
     * ago is otherwise in no stored text and would read as unused.
     */
    async function settlePendingWrites(): Promise<void> {
        await protectedStore?.commitAll();
        await (
            store as { flushAll?: () => Promise<void> } | undefined
        )?.flushAll?.();
    }

    /**
     * References to an asset inside this graph's Protected Documents, which the Derived Index
     * never holds (protected-asset-usage.ts). Stored text is read without opening anything: the
     * relay-checked batch read on a synced graph, the files on a folder graph.
     */
    async function protectedUsageOf(needles: readonly string[]): Promise<ProtectedAssetUsage> {
        const current = store;
        const readStored =
            current && isServerStore
                ? serverStoredTexts(current as ServerDocumentStore)
                : current && fsAdapter
                  ? filesystemStoredTexts(current, fsAdapter)
                  : null;
        // No store to read from: every flagged document is unread, so the bytes stay.
        const unreadable = async (concepts: readonly string[]) =>
            new Map<string, string | null>(concepts.map((c) => [c, null]));
        return protectedUsageReader({
            concepts: () => graphIndex?.allConcepts() ?? [],
            readStored: readStored ?? unreadable,
            readProtected: readProtectedText,
            settle: settlePendingWrites,
        })(needles);
    }

    /**
     * The padlock's predicate, made to hold for a tab whose editor is NOT mounted.
     *
     * `protectionKindFor` answers only for documents an editor currently holds open — right for
     * the tab renderer, which repaints constantly and must not `open()` anything. But the mobile
     * presenter mounts one View at a time, so every protected tab but the active one has no
     * wrapper in that cache, answered undefined, and survived a Lock Now (reported 2026-09-14).
     *
     * The fallback is the [[Derived Index]]'s flag (`ConceptCandidate.protected`), the same
     * answer the Favourites padlock wears: synchronous, and held for every document on both
     * backends. Reading the stored text instead was tried and does not work for the case that
     * matters — a tab restored from the Layout and never activated since the reload has no text
     * loaded yet, because `open()` only STARTS the read, so `getText()` is empty and reads as
     * unprotected. The flag trails a protect by one ingest; a document protected seconds ago is
     * still the active one, and the cache answers for that.
     */
    function protectionKindOf(target: string): DocumentProtectionKind {
        const cached = protectedStore?.protectionKindFor(target);
        if (cached !== undefined) return cached;
        const key = conceptKey(target);
        const flagged = graphIndex?.allConcepts().some((c) => c.key === key && c.protected);
        return flagged ? "document" : "none";
    }

    /**
     * A View became the main region's active one: the signal [[Recents]] and the active-document
     * accessor both ride, whichever presenter reported it. The dockview renderer hands over the
     * View; the mobile one hands over a panel id, and until this was shared the mobile path only
     * ran the focus policy, so a phone never recorded a Recent (reported 2026-09-14).
     */
    function noteMainViewActivated(view: ViewRef): void {
        if (view.kind !== "document") return;
        setActiveDocument(view.target);
        // Becoming the main region's active View is exactly what makes a document Recent — the
        // same signal Navigation History rides.
        recents?.touch(view.target);
    }

    /**
     * The View behind a mobile activation. Asked of the controller, whose model already names it
     * (a copy's panel id is synthetic, so parsing it would name the wrong document); parsed only
     * while the controller does not exist yet — the eager activation during first restore.
     */
    function viewForActivatedPanel(panelId: string): ViewRef {
        const active = controller?.activeView();
        return active?.panelId === panelId ? active.view : parseViewKey(panelId);
    }

    /** What the protected-fence augmentation reads to decide what each fence should show. */
    function buildProtectionStatus(
        session: ProtectionSession,
    ): ProtectionStatus {
        return {
            reasonAt: (docText, from) =>
                session.service
                    .describeFences(docText)
                    .find((d) => d.fence.from === from)?.reason ?? "locked",
            isReadable: () => session.isReadable,
            requestUnlock: () => void openUnlockProtection(null),
            lockNow,
        };
    }

    /**
     * Bumped whenever a tab mark could have changed — a lock transition, a document opening, or
     * the index learning which documents a publication includes.
     *
     * The desktop tabs are imperative DOM and repaint through `refreshTabIndicators`; the mobile
     * strip is a Svelte snippet and needs a reactive dependency instead. One counter drives both.
     */
    let padlockTick = $state(0);

    /** Redraw every tab mark, on both presenters. */
    function repaintTabPadlocks(): void {
        padlockTick++;
        // Locking is not a dockview event, so the padlocks would otherwise keep saying unlocked
        // after the key had gone.
        refreshTabIndicators();
    }

    /**
     * The publications whose page names a document under `includes:` (ADR 0082), from the
     * [[Derived Index]]'s candidate flag - synchronous, and answered for every document on both
     * backends without opening one. Empty for anything the index does not know yet.
     */
    function includeUsesOf(target: string): string[] {
        return graphIndex?.candidate(target)?.includeOf ?? [];
    }

    /**
     * The mark on one panel's tab: the padlock of a [[Protected Document]], else the globe of a
     * document a publication includes, else nothing. Protection wins the one slot, but the two
     * do not meet in practice: a protected document is never published, and protecting a public
     * one withdraws it first ({@link startProtect}).
     */
    function tabMarkFor(panelId: string): TabMark | null {
        const protection = protectionStateForPanel(panelId);
        if (protection) return { state: protection, title: protection === "locked" ? "Protected — locked" : "Protected — unlocked" };
        const view = parseViewKey(panelId);
        if (view.kind !== "document") return null;
        const uses = includeUsesOf(view.target);
        if (uses.length === 0) return null;
        return { state: "include", title: `Used in a publication: ${uses.join(", ")}. Its text is on the website.` };
    }

    /**
     * The padlock state for one panel's tab: closed when a [[Protected Document]] is locked, open
     * when it is readable, and nothing at all for anything else.
     *
     * A page is protected whole or not at all (ADR 0060), and the padlock says which.
     *
     * Answered **only from documents already open**. A tab renderer runs for every panel on every
     * repaint, and `store.open()` is not a free read on a Server Backend — it retains a sync engine
     * and materialises the document. Opening one here to decide whether to draw a padlock is the
     * same mistake that once made warm tabs re-derive the whole graph. A panel whose document has
     * not opened yet simply has no padlock until {@link repaintTabPadlocks} next runs.
     */
    function protectionStateForPanel(panelId: string): "locked" | "unlocked" | null {
        // Read first, and unconditionally: this is what makes the MOBILE padlock reactive, and it
        // has to be a dependency even on the paths that bail out early — otherwise a tab that was
        // unprotected when it rendered would never learn that it since became protected.
        void padlockTick;
        const view = parseViewKey(panelId);
        if (view.kind !== "document") return null;
        if (protectedStore?.protectionKindFor(view.target) !== "document")
            return null;
        // Masked reads as locked here: the padlock answers "is anything readable on screen".
        return protection?.isReadable ? "unlocked" : "locked";
    }

    /**
     * Whether a concept has a document yet. A [[Draft]] - the create row in Quick Find, a
     * wikilink to a [[Pageless Concept]] - opens an editor over nothing, and the store first
     * hears of it at the first keystroke. Asked through `open`, which is what a protect does
     * next anyway, rather than through the index, which can lag a page just created.
     */
    function documentExists(concept: string): boolean {
        if (!store) return false;
        try {
            store.open(concept);
            return true;
        } catch (error) {
            if (error instanceof DocumentNotFoundError) return false;
            throw error;
        }
    }

    /** Whether a concept's stored document holds any protected content. */
    function isConceptProtected(concept: string): boolean {
        if (!store) return false;
        try {
            // The target IS the concept name (open-concept.ts), and the RAW store is read here
            // deliberately: the projection would hand back plaintext, which never holds a fence.
            return (
                documentProtection(store.open(concept).getText()).kind !==
                "none"
            );
        } catch {
            return false;
        }
    }

    /**
     * Write a document's pending save now. A protect or unprotect is reported as done the moment
     * the buffer changes, and a Filesystem Backend would otherwise leave the file in its previous
     * state until the autosave timer fired — plaintext on disk under a document the UI shows as
     * protected. A Server Backend writes to the durable outbox at once and has nothing to flush.
     */
    async function flushProtectionWrite(concept: string): Promise<void> {
        await (
            store as
                | { flushDocument?: (target: string) => Promise<void> }
                | undefined
        )?.flushDocument?.(concept);
    }

    /**
     * Wait for the record read that is off the graph-open critical path, so `isConfigured` can be
     * trusted - acting sooner read a configured graph as unconfigured. When that read failed (the
     * vault was locked, the server unreachable) read it once more now: the message the user was
     * shown says "try again", and the button they just pressed is the retry. False means stop -
     * the user has been told why.
     */
    async function protectionRecordReady(): Promise<boolean> {
        if (!protection) return false;
        if (!(await protection.ready())) {
            notify(PROTECTION_UNREACHABLE);
            return false;
        }
        if (protection.isUnreadable && !(await protection.refresh())) {
            notify(protectionProblemMessage());
            return false;
        }
        return true;
    }

    /** Open the unlock dialog, optionally resuming an action once the key is in memory. */
    async function openUnlockProtection(
        then: (() => void) | null,
    ): Promise<void> {
        if (!protection || !(await protectionRecordReady())) return;
        if (!protection.isConfigured) return;
        protectionPasskeyBound =
            (await boundPasskey(graphId, protection.fingerprint)) !== null;
        unlockingProtection = { hasPasskey: protectionPasskeyBound, then };
    }

    /**
     * Protect a document. A graph with no Protection Key gets the set-passphrase dialog first -
     * that is the one moment the "there is no recovery" warning is shown, so it is never skipped.
     */
    async function startProtect(concept: string, options: { withdrawn?: boolean } = {}): Promise<void> {
        // A page is created the moment something is typed into it (ADR 0050); until then there
        // is no document and nothing to encrypt. Said in a dialog, and before the passphrase is
        // asked for: the store's "No document for X" in a toast read as a fault, and the way out
        // - type something first - is not something a toast has room to explain.
        if (!documentExists(concept)) {
            protectingDraft = concept;
            return;
        }
        // A protected document is never published (ADR 0082's consent rule cuts the other way
        // too): a public one, or one a publication names as a snippet, is withdrawn first, and
        // only with the user's say-so - a padlock that silently took a page off a website would
        // be found by the site's readers, not by its author.
        if (!options.withdrawn && store) {
            await store.whenReady?.(concept);
            const membership = readMembership(store.open(concept).getText());
            const uses = includeUsesOf(concept);
            if (membership.isPublic || uses.length > 0) {
                protectingPublic = { concept, isPublic: membership.isPublic, uses };
                return;
            }
        }
        if (!protection || !(await protectionRecordReady())) return;
        if (!protection.isConfigured) {
            settingProtectionPassphrase = {
                concept,
                then: () => void protectDocument(concept),
            };
            return;
        }
        if (!protection.isUnlocked) {
            await openUnlockProtection(() => void protectDocument(concept));
            return;
        }
        await protectDocument(concept);
    }

    /** What the withdraw-and-protect dialog says: which of the two facts hold, and what is undone. */
    function protectingPublicMessage(pending: { concept: string; isPublic: boolean; uses: string[] }): string {
        const facts: string[] = [];
        if (pending.isPublic) facts.push("is public");
        if (pending.uses.length > 0) facts.push(`fills an include of ${pending.uses.length === 1 ? "the publication" : "the publications"} ${pending.uses.join(", ")}`);
        return `“${pending.concept}” ${facts.join(" and ")}. A protected document is never published, so protecting it takes it off every site at the next publish: its public and publications keys are removed${pending.uses.length > 0 ? ", and the include it fills goes empty until another page is named" : ""}.`;
    }

    async function protectDocument(concept: string): Promise<void> {
        if (!store || !protection) return;
        maybeShown();
        try {
            const doc = store.open(concept);
            const current = doc.getText();
            if (documentProtection(current).kind !== "none") return;
            const body = documentBody(current);
            const armoured = await protection.service.encrypt(body);
            // Through the projection when the document is open in an editor: the fence goes to
            // the store and the body the user is looking at is projected over it in one
            // synchronous step, so the editor never receives the fence. Writing the raw store
            // first and re-projecting afterwards flashed the locked card - the file flush, the
            // cache compaction and a decrypt later - over a page whose plaintext was on screen
            // the whole time; there is no protection in that flicker, the stored bytes are
            // ciphertext either way. A document nobody has open gets the raw write.
            if (!protectedStore?.protect(concept, armoured, body)) {
                doc.applyChange(
                    {
                        from: 0,
                        to: current.length,
                        insert: protectDocumentText(current, armoured),
                    },
                    "external",
                );
            }
            // Remount NOW, before any await: on a Server Backend the editor is bound to the
            // CRDT and has just been handed the fence by it; the remount onto the projection
            // has to replace that before the browser paints, which it does while this stays in
            // one task. Persistence follows - it changes nothing on screen.
            announceProtectionChanged(concept);
            await flushProtectionWrite(concept);
            // The plaintext just replaced must not stay readable at rest in the Local Cache row
            // (a Server Backend; the Filesystem file was simply overwritten).
            await (
                store as { compactDocument?: (target: string) => Promise<void> }
            ).compactDocument?.(concept);
            notify(`${concept} is protected. It is no longer searchable.`);
        } catch (e) {
            notify(`Could not protect ${concept}: ${(e as Error).message}`);
        }
    }

    /** Remove protection: decrypt back to ordinary readable markdown. Needs the key. */
    /**
     * A masked graph comes back when the user is demonstrably in front of it: opening or acting
     * on a protected document while the page is visible and focused. Never otherwise - a
     * document opened by a background preload while the tab is hidden must stay masked.
     */
    function maybeShown(): void {
        if (!protection?.isConfigured || protection.status !== "masked") return;
        if (document.visibilityState === "visible" && document.hasFocus())
            protection.shown();
    }

    async function startUnprotect(concept: string): Promise<void> {
        if (!store || !protection) return;
        // The user is here and acting: a masked graph comes back before the read below, or
        // locks if its grace has run out, in which case the prompt is the right answer.
        maybeShown();
        if (!protection.isUnlocked) {
            await openUnlockProtection(() => void startUnprotect(concept));
            return;
        }
        try {
            const doc = store.open(concept);
            const current = doc.getText();
            const plaintext = await protection.service.readDocument(current);
            const next = unprotectDocumentText(current, plaintext);
            doc.applyChange(
                { from: 0, to: current.length, insert: next },
                "external",
            );
            await flushProtectionWrite(concept);
            // Drop the projection, or its next save re-encrypts the old body over the plaintext
            // just written and the page is silently protected again — with no tab padlock, since
            // that reads the stored text. Seen in test.
            await protectedStore?.reproject(concept);
            announceProtectionChanged(concept);
            notify(
                `${concept} is no longer protected. It will be searchable again shortly.`,
            );
        } catch (e) {
            notify(
                `Could not remove protection from ${concept}: ${(e as Error).message}`,
            );
        }
    }

    /** Bind a passkey on this device to the graph's Protection Key. Needs the key in memory. */
    async function bindProtectionPasskey(): Promise<void> {
        const key = protection?.service.heldKey();
        if (!key) throw new Error("unlock this graph before binding a passkey");
        await enrolPasskey(graphId, key);
        protectionPasskeyBound = true;
    }

    /** Rename dialog state — the dialog itself is a presentation surface over the store. */
    let renaming = $state<{
        concept: string;
        plan: RenamePlan | null;
        /** No document yet - a [[Draft]] - so the dialog offers no alias arm (ADR 0064). */
        pageless: boolean;
        busy: boolean;
        error: string | null;
        /** A name typed into the document's frontmatter (ADR 0061); the dialog opens on it. */
        initialName?: string;
        /** Where a pre-filled name came from: the block, or a link edited in place (ADR 0065). */
        source?: "frontmatter" | "wikilink";
        /**
         * The document whose edited link proposed this rename (ADR 0065). Its group in the
         * index still counts the old name until the index catches up with the keystrokes that
         * just happened, so the preview's reference count corrects for it from the live text.
         */
        editingTarget?: string;
        /** Settles the frontmatter proposal that opened the dialog: the new concept, or null. */
        resolve?: (result: string | null) => void;
    } | null>(null);

    /** Delete confirmation state. */
    let deleting = $state<{
        concept: string;
        references: number | null;
        busy: boolean;
    } | null>(null);
    /** A delete refused because a publication includes the document: which publications, for the dialog. */
    let deletingIncluded = $state<{ concept: string; publications: string[] } | null>(null);

    /**
     * An edit brought back a document that had gone (ADR 0039 §4). Said out loud: a document
     * silently reappearing explains nothing to whoever deleted it, and they would just delete
     * it again.
     */
    function noteResurrection(concept: string) {
        notify(`"${concept}" had been deleted; your edit restored it.`);
    }

    /** Open the rename dialog. The plan is recomputed as the typed name changes. */
    function startRename(concept: string) {
        renaming = {
            concept,
            plan: null,
            pageless: !documentExists(concept),
            busy: false,
            error: null,
        };
        void refreshRenamePlan(concept, concept);
    }

    /**
     * The rename dialog as a question: opened on a name the user typed into the document's
     * frontmatter (ADR 0061), resolving to the new concept, or null when cancelled - at which
     * point the controller puts the old name back into the block.
     */
    async function promptRename(
        concept: string,
        initialName: string,
        source: "frontmatter" | "wikilink" = "frontmatter",
        editingTarget?: string,
    ): Promise<string | null> {
        // A link's question opens at once and its plan fills in after: the wait is the index's
        // and the user has already been told about it; a refusal shows in the dialog, where
        // "Just this link" is the way out. A block's question is different - Cancel puts the
        // registry's name back - so a name the store refuses outright (a Protected Document's,
        // which nothing may merge into, ADR 0062) never opens that dialog: the refusal is said,
        // and null hands the block back to the controller.
        const plan = source === "wikilink" ? null : await planFor(concept, initialName, editingTarget);
        if (plan?.refusal) {
            notify(`Could not rename: ${plan.refusal}`);
            return null;
        }
        if (source === "wikilink") void refreshRenamePlan(concept, initialName, editingTarget);
        return new Promise((resolve) => {
            // A dialog already open (Rename… chosen by hand, or an earlier proposal) is replaced;
            // its question is answered "no" so the controller waiting on it moves on.
            renaming?.resolve?.(null);
            // A frontmatter proposal only ever comes from a document, so never pageless; a
            // link's concept may have no page (ADR 0064).
            renaming = {
                concept,
                plan,
                pageless: source === "wikilink" && !documentExists(concept),
                busy: false,
                error: null,
                initialName,
                source,
                editingTarget,
                resolve,
            };
        });
    }

    function cancelRename() {
        renaming?.resolve?.(null);
        renaming = null;
    }

    // ── Frontmatter as a proposal (ADR 0061) ──────────────────────────────────────────────────
    // The editor says when an episode in the block ended; the controller works out what the
    // block proposes against the registry and runs it, one dialog at a time; the stores apply.

    /** The registry as a lookup by concept key, rebuilt lazily after any registry change. */
    let identityIndex: Map<string, DocumentIdentity> | null = null;

    function identityOf(target: string): DocumentIdentity | null {
        if (!store) return null;
        if (!identityIndex) {
            identityIndex = new Map();
            for (const entry of store.listDocuments()) {
                identityIndex.set(entry.key, {
                    kind: entry.kind,
                    concept: entry.concept,
                    aliases: entry.aliases,
                    ...(isServerStore
                        ? {}
                        : { fileStem: fileStem(entry.fileName) }),
                });
            }
        }
        return identityIndex.get(conceptKey(target)) ?? null;
    }

    /** The document as its editors hold it - the projection for a Protected Document. */
    function editorDocumentFor(target: string) {
        try {
            return (protectedStore ?? store)?.open(target) ?? null;
        } catch {
            return null;
        }
    }

    const frontmatterController = createFrontmatterController({
        backend: () => (isServerStore ? "server" : "filesystem"),
        textOf: (target) => editorDocumentFor(target)?.getText() ?? null,
        identityOf,
        applyAliases: async (target, aliases) => {
            await store?.setAliases(target, aliases);
        },
        // Through the document every editor is showing, as an external change, so each of them
        // sees it; only the block is replaced, the body being verbatim in the rewritten text.
        writeBack: (target, patch) => {
            const doc = editorDocumentFor(target);
            if (!doc) return;
            const text = doc.getText();
            const next = withFrontmatterIdentity(text, patch);
            if (next === text) return;
            const before = frontmatterSpan(text)?.end ?? 0;
            const after = frontmatterSpan(next)?.end ?? 0;
            doc.applyChange(
                { from: 0, to: before, insert: next.slice(0, after) },
                "external",
            );
        },
        promptRename,
    });

    // ── An edited wikilink as a proposal (ADR 0065) ──────────────────────────────────────────
    // The editor says a link in a document named X and now names Y; the rename is proposed
    // only while X still exists elsewhere - a page with that exact name, a page whose NAME
    // is scoped by it ("Fishing for [[X]]" - the index holds body links only, so this is asked
    // of the registry), another instance in this document's live text (the index lags the
    // keystrokes that just happened), or an instance in any other document per the index. A
    // link written through an ALIAS proposes nothing: renaming an alias is not what the rename
    // dialog does.
    // The index answers from a worker, and may be busy ingesting the very edit that raised the
    // question, so the answer can take a moment: a status says what is being waited for, and
    // the dialog then opens at once, its impact figures filling in after (the wait is not
    // blocking, and nothing the user does in the meantime is lost).
    const linkRenameController = createLinkRenameController({
        existsElsewhere: (target, before) =>
            withProgressNotice(`Checking whether "${before}" is used elsewhere…`, async () => {
                if (identityOf(before)) return true;
                if (documentExists(before)) return false; // resolves, but not by that name: an alias
                if (store?.listDocuments().some((entry) => isScopedBy(entry.concept, before))) return true;
                const text = editorDocumentFor(target)?.getText() ?? "";
                if (rewriteWikilinkScope(text, before, before).count > 0) return true;
                const groups = (await graphIndex?.backlinks(before)) ?? [];
                return groups.some(
                    (group) => conceptKey(group.sourceConcept) !== conceptKey(target),
                );
            }),
        promptRename: (target, before, after) =>
            promptRename(before, after, "wikilink", target),
        conceptMoved: (before, after) =>
            documentMutations.followConceptMove(before, after),
    });

    /**
     * Recompute the impact for a candidate name (ADR 0038 §1): how many scoped concepts come
     * with it, how many merge, how many documents reference it. Preview and effect come from
     * the same plan, so they cannot drift.
     */
    async function refreshRenamePlan(concept: string, candidate: string, editingTarget?: string) {
        const plan = await planFor(concept, candidate, editingTarget ?? renaming?.editingTarget);
        if (renaming?.concept === concept) renaming = { ...renaming, plan };
    }

    /** The plan for a candidate name, or null when it could not be computed. */
    async function planFor(
        concept: string,
        candidate: string,
        editingTarget?: string,
    ): Promise<RenamePlan | null> {
        try {
            const plan = await documentMutations.planRename(concept, candidate);
            if (!plan || !editingTarget) return plan;
            // The index lags the edit that proposed this rename: while it still lists the
            // editing document under the old name, and that document's live text no longer
            // says it, the count is one too many (ADR 0065). Only a BODY listing is lag: a
            // document scoped by the concept is listed for its title (ADR 0083), which the
            // count never included, so that row is not the one too many.
            const text = editorDocumentFor(editingTarget)?.getText() ?? "";
            if (rewriteWikilinkScope(text, concept, concept).count > 0) return plan;
            const groups = (await graphIndex?.backlinks(concept)) ?? [];
            const stale = groups.some(
                (group) =>
                    referencedInBody(group) &&
                    conceptKey(group.sourceConcept) === conceptKey(editingTarget),
            );
            return stale
                ? { ...plan, referencingDocuments: Math.max(0, plan.referencingDocuments - 1) }
                : plan;
        } catch {
            // A failed plan must not block the dialog; it just shows no impact figures.
            return null;
        }
    }

    /**
     * Hand a resolved [[Asset]] to the browser as a download. An anchor with `download` rather
     * than a navigation, so the object URL is saved under the asset's own name instead of
     * replacing the app.
     */
    function downloadResolvedAsset(url: string, fileName: string) {
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /** Open the delete confirmation, reporting what points at the document (ADR 0039 §3). */
    async function startDelete(concept: string) {
        // A document a publication names under `includes:` is refused, not confirmed: the site
        // would lose its footer or scripts and the publication page would name a page that is
        // gone. The include reference has to go first, and the dialog says where it is.
        const uses = includeUsesOf(concept);
        if (uses.length > 0) {
            deletingIncluded = { concept, publications: uses };
            return;
        }
        // Straight from the index - no need to plan a rename just to count links. The index
        // answers from a worker now, so the count arrives a beat after the dialog.
        deleting = { concept, references: 0, busy: false };
        const references =
            (await documentMutations.referenceCount(concept)) ?? 0;
        if (deleting?.concept === concept)
            deleting = { ...deleting, references };
    }

    async function confirmDelete() {
        const current = deleting;
        if (!current || !store) return;
        deleting = { ...current, busy: true };
        try {
            await documentMutations.delete(current.concept);
            deleting = null;
            notify(`Deleted "${current.concept}".`);
        } catch (err) {
            deleting = null;
            notify(`Could not delete: ${(err as Error).message}`);
        }
    }

    async function confirmRename(next: string, strategy: RenameLinkStrategy) {
        const current = renaming;
        if (!current || !store) return;
        renaming = { ...current, busy: true, error: null };
        try {
            const result = await documentMutations.rename(
                current.concept,
                current.plan,
                next,
                strategy,
            );
            renaming = null;
            current.resolve?.(result.concept);
            notify(renameDocumentSummary(result));
        } catch (err) {
            renaming = {
                ...current,
                busy: false,
                error: (err as Error).message,
            };
        }
    }

    // Today's [[Journal Concept]] is `todayISO()` at the moment of use, never a mount-time
    // constant: a workspace left open overnight must reach the new day (the Alt+J command and
    // the sidebar's button both read the clock when invoked). Computed, never created —
    // reaching a day writes nothing until something is typed into it (ADR 0056).
    let detachReconcile: (() => void) | undefined;
    let stopWatch: (() => void) | undefined;
    let conflict = $state<DocumentConflict | null>(null);
    let navEngine: HistoryEngine | undefined;
    let readingPositions: ReadingPositionStore | undefined;
    let taskFilter: TaskFilterStore | undefined;
    let backlinksPreferences: BacklinksPreferencesStore | undefined;
    // True while a presenter (re)build is assembling the layout, so transitional
    // focus events are not recorded as Visits (mirrors suppressSave).
    let suppressNav = true;
    // The deep-link + seed step runs on the FIRST mount only; a presenter swap
    // carries live state and keeps its current Visit.
    let seeded = false;

    // Debounced layout persistence. Fed by the controller's onChange (open/close/
    // focus/collapse) and the dockview renderer's onGeometryChange (drag/resize),
    // so every user layout change is saved per graph. Suppressed during restore /
    // the presenter swap so transitional events don't overwrite good state.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressSave = false;

    function saveLayout() {
        if (controller && layoutStore)
            void layoutStore.save(graphId, controller.serialize());
    }

    function scheduleSave() {
        if (suppressSave) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveLayout, 300);
    }

    // A browser-level unload (tab close, reload, address-bar navigation) never
    // runs Svelte teardown, so a debounced layout save / Reading Position write
    // pending at that moment would be silently lost. pagehide is the last
    // reliable moment to flush both.
    function flushPersistence() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveLayout();
        }
        readingPositions?.flush();
        taskFilter?.flush();
        backlinksPreferences?.flush();
    }

    /**
     * The four residents (CONTEXT.md → Sidebar) as the Commands reach them. Backlinks is keyed by
     * the document it opened on, so its fallback is today, the seed the default Layout uses; the
     * other three are singletons.
     */
    const RESIDENTS: Record<"graph" | "quickNotes" | "backlinks" | "tasks", Resident> = {
        graph: { kind: "document-tree", side: "left", fallback: () => ({ kind: "document-tree", target: "root" }) },
        quickNotes: { kind: QUICK_NOTES_VIEW.kind, side: "left", fallback: () => QUICK_NOTES_VIEW },
        backlinks: { kind: "backlinks", side: "right", fallback: () => ({ kind: "backlinks", target: todayISO() }) },
        tasks: { kind: TASKS_VIEW.kind, side: "right", fallback: () => TASKS_VIEW },
    };

    /**
     * Reset workspace, confirmed: the Layout a brand-new graph opens with, over a fresh
     * presenter, plus the per-device state that hangs off the old arrangement
     * (workspace-reset.ts). The same teardown-and-remount the desktop/phone switch uses, so
     * every open editor is torn down the way it is there - nothing typed is lost, because
     * editors write through to the store as they go. The URL goes back to the graph root
     * (replaced, not pushed: Back must not return to an address whose tab is now closed), and
     * the fresh Layout's own today-journal becomes the active document as on a first open.
     */
    async function resetWorkspace() {
        resetDialogOpen = false;
        const attempt = openAttempt;
        if (!attempt || phase !== "ready") return;
        try {
            await session.transitionPresenter(async () => {
                attempt.checkpoint();
                forgetWorkspaceCompanions(graphId);
                readingPositions = createReadingPositions(graphId);
                taskFilter = createTaskFilterStore(graphId);
                backlinksPreferences = createBacklinksPreferencesStore(graphId);
                if (workspaceGeneration !== undefined) {
                    updateWorkspaceServices(workspaceGeneration, {
                        readingPositions,
                        taskFilter,
                        backlinksPreferences,
                    });
                }
                renderer?.destroy?.();
                controller = undefined;
                renderer = undefined;
                mobileRenderer = undefined;
                replaceState(`/g/${graphId}${withoutSettingsTab(page.url.search)}`, {});
                await attempt.wait(tick());
                await mountPresenter(attempt, freshLayout().model);
                notify("Workspace reset");
            });
        } catch (error) {
            if (!(error instanceof GraphSessionCancelledError)) throw error;
        }
    }

    /**
     * The Layout a graph opens with on THIS presenter, for a first open and for Reset workspace
     * alike. A desktop shows both Sidebars from the start; a phone shows one drawer at a time and
     * the left one first, so its right Sidebar starts collapsed.
     */
    function freshLayout() {
        return defaultLayout({
            journalTarget: todayISO(),
            rightSidebarCollapsed: useMobile,
        });
    }

    /** The toolbar's toggles run the same Commands as the chords, so a closed resident comes back from either. */
    function toggleSidebar(side: "left" | "right") {
        void commandRegistry?.execute(
            side === "left" ? "layout.toggleSidebar" : "layout.toggleBacklinks",
        );
    }

    // One generic Contribution registry hosts both the View kind (via the ViewRegistry
    // facade) and the Command Menu's menu-item kind (ADR 0017) — genuinely one registry,
    // two kinds. Set active in openGraph so editor augmentations can reach it.
    const contributions = createContributionRegistry();
    const registry = createViewRegistry(contributions);
    registry.register({ kind: "document", component: DocumentView });
    // The kind stays `document-tree` even though the View is now the Graph Sidebar: the kind
    // is the key in every persisted Layout, and renaming it would strand the left sidebar of
    // every graph anyone has already opened.
    registry.register({
        kind: "document-tree",
        component: GraphSidebarView,
        naturalRegion: "left-sidebar",
        // The graph's name, so the sidebar says which graph is open where the eye already
        // rests; "Graph" until the name is known. The phone strip reads this live; the desktop
        // tab is titled once at creation and retitled by the effect beside `toolbarStyle`.
        title: () => sidebarTabTitle(graphDisplayName, graphId),
        icon: "graph",
    });
    // The Quick Notes View is the left Sidebar's SECOND resident, beside the graph sidebar as
    // Tasks is beside Backlinks: one singleton tab, present from the first open (ADR 0078).
    registry.register({
        kind: "quick-notes",
        component: QuickNotesView,
        naturalRegion: "left-sidebar",
        title: () => "Quick notes",
    });
    // All Documents lives in the MAIN region, not the sidebar: at real scale (2838 documents
    // on the graph this was built against) a browse-everything list needs the room, which is
    // why the sidebar stopped being one.
    registry.register({
        kind: "all-documents",
        component: AllDocumentsView,
        naturalRegion: "main",
        title: () => "All documents",
    });
    // An [[Asset]] in its own tab. The target is the asset's identity, so one Asset is one
    // tab; the title strips the id segment and the View retitles once the real name resolves.
    registry.register({
        kind: "asset",
        component: AssetView,
        naturalRegion: "main",
        title: (view) => displayAssetName(view.target),
    });
    // A [[Theme]] kept in the graph, in the Theme editor (ADR 0082). The target is the theme
    // id; the View retitles to the theme's name once it has read it.
    registry.register({
        kind: "theme",
        component: ThemeView,
        naturalRegion: "main",
        title: (view) => `${THEME_TITLE_PREFIX}${getGraphTheme(view.target)?.name ?? view.target}`,
        titlePrefix: THEME_TITLE_PREFIX,
    });
    registry.register({
        kind: "backlinks",
        component: BacklinksView,
        naturalRegion: "right-sidebar",
        // Fallback title before any document is active (and on presenters without
        // dynamic retitling). The View retitles its own tab to "Backlinks: <document>"
        // through `retitleView`, because what it shows is not always the active document:
        // pinned, it stays on the pinned one, and only the View knows that.
        title: () => "Backlinks",
        titlePrefix: BACKLINKS_TITLE_PREFIX,
    });
    // The Tasks View joins the right Sidebar as a SECOND tab beside Backlinks
    // rather than replacing it: a Pane holds many Views as tabs, and "replace" would be a
    // special case the Layout model does not have. One singleton View whose Name Filter is
    // mutable state — not one View per concept — so the toolbar button always has a single
    // thing to open, and changing the filter never means closing a tab.
    registry.register({
        kind: "tasks",
        component: TasksView,
        naturalRegion: "right-sidebar",
        title: () => "Tasks",
    });

    // Browser Back/Forward over shallow entries: the popped entry's Visit arrives
    // via page.state. (Our own pushUrl also lands here; apply() is id-idempotent.)
    $effect(() => {
        const visit = page.state.etherpkVisit;
        if (visit && phase === "ready" && !suppressNav) navEngine?.apply(visit);
    });

    // Settings follows the history entry the same way (ADR 0023, 2026-09-20): a tab named in
    // its state opens the modal there, its absence closes it, so the cog, Back, Forward, a
    // pasted link and a reload are one path. Gated on ready, so a deep link's tab waits for the
    // Layout to be restored. A tab change while open is the dialog's own doing (it moved the
    // entry through onchangetab), so an open modal is left to follow the prop.
    $effect(() => {
        const tab = settingsTab;
        if (phase !== "ready") return;
        untrack(() => {
            if (tab === null) {
                graphSettingsDialog = null;
                return;
            }
            // Open already: the entry moved (the dialog's own tab pick, the Publish chord, a
            // popstate onto an entry naming another tab), and the modal follows it.
            if (graphSettingsDialog) graphSettingsDialog.tab = tab;
            else void showGraphSettings();
        });
    });

    // Real navigations INTO this mounted workspace carrying a Document URL:
    // a pasted link while the graph is open, or post-reload Back/Forward
    // (shallow state does not survive a reload — degraded to Reading Position
    // by design). Same-graph only: cross-graph navigation remounts via the
    // {#key} in the route layout.
    afterNavigate((navigation) => {
        if (navigation.type !== "popstate" && navigation.type !== "goto")
            return;
        // A shallow pop carries its Visit (or its Settings tab) in page.state — the $effects
        // above own that path; running visitFromUrl too would double-apply (redundant
        // openView + a Reading-Position restore racing the snapshot restore).
        if (page.state.etherpkVisit || page.state.etherpkSettings) return;
        if (phase !== "ready") return;
        // Any addressable kind: a Document URL, an [[Asset]]'s own tab URL, a [[Theme]]'s.
        const view = viewFromParams();
        if (view) navEngine?.visitFromUrl(view);
        adoptSettingsFromUrl();
    });

    /** The graph's directory root: a picked FSA handle, or (dev test) an OPFS subdir. */
    async function resolveRoot(
        attempt: GraphOpenAttempt,
    ): Promise<FileSystemDirectoryHandle | null> {
        if (dev && opfs) {
            const opfsRoot = await attempt.wait(getOpfsRoot());
            return attempt.wait(
                opfsRoot.getDirectoryHandle(opfsGraphFolderName(graphId), {
                    create: true,
                }),
            );
        }
        const record = await attempt.wait(
            createIdbGraphRegistry().getGraph(graphId),
        );
        if (!record) {
            // Three different situations reach here (graph-availability.ts): no record, a
            // record under another account scope, or a membership the server has withdrawn.
            // Work out which, so the notice can offer the one-write repair when the server
            // still lists this account as a member instead of a flat "not in this browser".
            const api = createConfiguredSyncApi();
            const diagnosis = await attempt.wait(
                diagnoseMissingGraph(graphId, {
                    allRecords: () => createIdbGraphStoragePort().getAll(),
                    activeScope: readActiveSyncAccount,
                    listServerGraphs: api
                        ? async () => (await api.graphsOverview()).graphs
                        : null,
                }),
            );
            if (diagnosis.kind === "other-account") {
                // Principal ids are for whoever is debugging, not for the notice.
                console.warn(
                    "[workspace] graph registered under another sync account on this browser",
                    {
                        graphId,
                        ...diagnosis,
                    },
                );
            }
            missing = diagnosis;
            phase = "missing";
            return null;
        }
        const granted = await attempt.wait(ensurePermission(record.handle));
        if (!granted) {
            phase = "needs-permission";
            return null;
        }
        return record.handle as FileSystemDirectoryHandle;
    }

    async function waitForSize(el: HTMLElement, attempt: GraphOpenAttempt) {
        for (
            let i = 0;
            i < 20 && (el.clientHeight === 0 || el.clientWidth === 0);
            i++
        ) {
            await attempt.wait(
                new Promise((r) => requestAnimationFrame(() => r(null))),
            );
        }
    }

    /** Open the graph: store, index, reconciliation. Runs once. */
    /** Build a Server Backend store over the E2EE sync engine (dev/e2e gate, Phase 3). */
    interface ResolvedServerParams {
        relay: string;
        /** Asked per request/reconnect: a workspace stays open far longer than a token lives. */
        token: SyncTokenSource;
        keyring: ReturnType<typeof createGraphKeyring>;
        root: string;
        /** HTTP base URL for asset presign calls; under the dev gate only when `http` is passed. */
        httpBaseUrl?: string;
        /**
         * Feeds the Sync Server's name envelope (ADR 0031, amended 2026-09-17) so a
         * device that never opened this graph can label it. Absent under the dev gate, which
         * has no account API to publish through.
         */
        publishName?: (name: string) => void;
    }

    /** Dev/e2e gate: relay/token/graph-key are injected in the URL (no real auth). */
    function paramsFromGate(gate: ServerGate): ResolvedServerParams {
        void createGraphKeyring; // keep the keyring shape in sync with the canonical constructor
        return {
            relay: gate.relay,
            // The gate has no API to mint from - the token is whatever e2e injected.
            token: fixedSyncToken(gate.token),
            keyring: {
                graphId,
                epochs: [{ epochId: 1, key: fromBase64Url(gate.gkey) }],
            },
            root: gate.root,
            httpBaseUrl: gate.http || undefined,
        };
    }

    /**
     * Real path (ADR 0026): a Server-backed graph in the registry. The device's sync config
     * (server URL + PAT) mints a short-lived sync token and unlocks the Graph Keyring from the
     * vault; the root doc id is stored on the graph record. `getWrapKey` prompts the user only
     * when the vault must be unlocked (device-approval / Recovery Code — Phase 4 UI).
     */
    async function paramsFromRegistry(
        record: { rootDocId: string },
        attempt: GraphOpenAttempt,
    ): Promise<ResolvedServerParams> {
        const connection = resolveSyncedGraphConnection(graphId);
        if (!connection)
            throw new Error(
                "This device is not configured for sync. Connect Managed Sync or add a custom server in Sync settings.",
            );
        const config = readSyncConfig();
        syncConfigAtOpen = JSON.stringify(config);
        serverAtOpen = {
            managed: config?.mode === "managed",
            server: connection.serverBaseUrl,
        };
        const { api, token } = connection;
        serverApi = api;
        const result = await attempt.wait(
            ensureGraphKeys(api, graphId, async () => {
                const cached = getVaultWrapKey();
                if (!cached) throw new VaultLockedError();
                return cached;
            }),
        );
        // Cache the wrap key for the session (fresh account, or a first successful unlock).
        setVaultWrapKey(result.deviceKey);
        // Opening a registry graph on a vault-less account is an edge case; commit immediately
        // (the primary prevention path is the create-graph flow on /graphs).
        await attempt.wait(result.commit());
        if (result.recoveryCodeJustGenerated)
            pendingRecoveryCode = result.recoveryCodeJustGenerated;
        return {
            relay: connection.relayUrl,
            token,
            keyring: result.keyring,
            root: record.rootDocId,
            httpBaseUrl: connection.serverBaseUrl,
            publishName: createGraphNamePublisher({
                api,
                keyring: result.keyring,
                graphId,
            }).publish,
        };
    }

    /**
     * The Settings → Agents tab. A synced graph (ADR 0072): its id and the Sync Server the device
     * is connected to, for the Headless Client's login and serve commands - the same origin the
     * account menu's "Access tokens" link uses; null when the device has no sync configuration
     * (the dev gate's server graphs), since there is no server for an agent to sign in to. A local
     * graph (ADR 0070): where its folder and AGENTS.md are.
     */
    function agentsTabProps(): AgentsTabProps | null {
        if (isServerStore) {
            const config = readSyncConfig();
            const connection = config ? resolveSyncConnection(config) : null;
            if (!connection) return null;
            return { kind: "synced", graphId, serverBaseUrl: connection.serverBaseUrl };
        }
        return {
            kind: "local",
            folderName: fsFolderName ?? null,
            folderPath: readGraphFolderPath(graphId) || null,
        };
    }

    /**
     * Graph Name + shared Graph Settings live in the root doc's `meta` map (ADR 0031).
     * The local registry record is only a CACHE of the synced name — it lets the keyless
     * /graphs picker label the graph — refreshed here on open and on every remote change.
     * A graph from before names synced has no meta name yet; seed it from the cached name
     * once the root doc has caught up (or after a short grace when offline), so a fresh
     * device never clobbers a real name with its stale copy.
     */
    async function wireGraphMeta(attempt: GraphOpenAttempt): Promise<void> {
        const sg = serverGraph!;
        const registryStore = createIdbGraphRegistry();
        let record = await attempt.wait(registryStore.getGraph(graphId));
        graphDisplayName = record?.name ?? "";
        const apply = () => {
            const meta = sg.getMeta();
            const settings = sanitizeGraphSettings(meta.settings ?? {});
            if (workspaceGeneration !== undefined) {
                updateWorkspaceServices(workspaceGeneration, { settings });
            }
            setGraphAccent(graphId, settings.toolbarColor);
            // Favourites are shared graph content (ADR 0036), so a peer's change arrives
            // here like any other meta change and simply replaces the list.
            adoptFavourites(settings.favourites ?? []);
            if (meta.name) graphDisplayName = meta.name;
            if (record) {
                // The record caches the name and the toolbar colour for surfaces that list
                // graphs without opening them (the picker, the header's Graphs menu): one
                // write for both, and none when neither moved.
                let next = record;
                if (meta.name && next.name !== meta.name) next = { ...next, name: meta.name };
                next = withCachedToolbarColor(next, settings.toolbarColor) ?? next;
                if (next !== record) {
                    record = next;
                    void registryStore.insertGraph(next);
                }
            }
        };
        apply();
        // Writing back merges into the CURRENT meta settings rather than the snapshot, so a
        // favourite added here cannot clobber a setting a peer changed meanwhile.
        setFavourites(
            sanitizeGraphSettings(sg.getMeta().settings ?? {}).favourites ?? [],
            async (next) => {
                const current = sanitizeGraphSettings(
                    sg.getMeta().settings ?? {},
                );
                sg.setMetaSettings({
                    ...current,
                    favourites: [...next],
                } as Record<string, unknown>);
            },
        );
        // Quick Notes were wired at cache-ready in openGraph, ahead of scan(), so a waiting
        // share could land before the relay wait; see there.
        // Themes: the root doc's own Y.Map of themes (ADR 0082), one file per entry, adopted
        // whole on any change so the Theme editor sees a peer's edit.
        const themesApi = sg.themes();
        setGraphThemes(themesApi.list(), {
            put: async (theme) => themesApi.put(theme),
            putFile: async (id, path, text) => themesApi.putFile(id, path, text),
            removeFile: async (id, path) => themesApi.removeFile(id, path),
            remove: async (id) => themesApi.remove(id),
        });
        attempt.own(themesApi.observe(() => adoptGraphThemes(themesApi.list())));
        detachMeta = sg.onMetaChange(apply);
        // The name cached when this open began: `record` itself moves on as meta changes land,
        // and a seed only happens while meta still has no name, so the snapshot is the right one.
        const cachedName = record?.name;
        if (!cachedName) return;
        // Seed only after the root doc's first catchup has applied (or a grace period,
        // offline) — never sooner: our own journal-bootstrap write fires doc updates
        // before catchup, and seeding then races the server's real name (LWW could keep
        // the stale placeholder for everyone).
        let seeded = false;
        const trySeed = () => {
            if (seeded || !attempt.isCurrent()) return;
            seeded = true;
            if (metaSeedTimer) clearTimeout(metaSeedTimer);
            if (!sg.getMeta().name) {
                sg.setMetaName(cachedName);
                void sg.flushAll(); // don't leave the seed in the debounce window
            }
        };
        void sg.rootCaughtUp().then(trySeed);
        metaSeedTimer = setTimeout(trySeed, 3000);
    }

    async function buildServerStore(
        params: ResolvedServerParams,
        attempt: GraphOpenAttempt,
    ): Promise<ServerDocumentStore> {
        const cache = await attempt.wait(openGraphCache(graphId));
        attempt.own(() => cache.dispose());
        serverCache = cache;
        serverRootDocId = params.root;
        serverGraph = createGraphSync({
            graphId,
            rootDocId: params.root,
            keyring: params.keyring,
            relayUrl: params.relay,
            token: params.token,
            cache,
            connect: browserTransport,
            publishName: params.publishName,
            // A document that reads as protected - after this device protected it, or after the
            // protect arrived from another - has its cache row collected, so the body it was
            // protected to hide does not stay in the unencrypted row on any device.
            collectRowWhen: (doc) =>
                documentProtection(doc.getText("content").toString()).kind ===
                "document",
            onError: (error) => {
                // The raw error goes to the console for whoever is debugging. The notice gets
                // the mapped sentence (sync-error-copy.ts): a browser DOMException verbatim
                // named neither the cause nor the next step, and read as a server fault.
                console.warn("[sync] could not persist pending changes", error);
                const copy = describeSyncFailure(
                    error,
                    "save your latest changes",
                );
                health.report({ code: "sync-degraded", message: copy });
                saveFailure = copy;
                saveFailureReloadable = true;
            },
            // Colour + name for this device's caret in every collaborator's editor.
            presence: presenceIdentity(),
            onAccessLost: (loss) => void accessEnded(loss),
        });
        watchSyncActivity(serverGraph);
        return createServerDocumentStore(serverGraph, {
            onResurrected: noteResurrection,
        });
    }

    /** Is this a Server-backed graph? The dev gate, or a registry record with backend 'server'. */
    async function resolveServerParams(
        attempt: GraphOpenAttempt,
    ): Promise<ResolvedServerParams | null> {
        if (dev && server) return paramsFromGate(server);
        const record = await attempt.wait(
            createIdbGraphRegistry().getGraph(graphId),
        );
        if (record?.backend === "server") {
            return paramsFromRegistry(
                record.handle as { rootDocId: string },
                attempt,
            );
        }
        return null;
    }

    async function openGraph(attempt: GraphOpenAttempt): Promise<boolean> {
        // Phase timings, logged once per open: when "opening is slow" is reported, this
        // one line says WHICH phase — resolving params/vault, the store scan, or the index.
        const openStarted = performance.now();
        const useServer = await resolveServerParams(attempt);
        if (dev && page.url.searchParams.get("openDelay") === "store") {
            await attempt.wait(
                new Promise((resolve) => setTimeout(resolve, 2_000)),
            );
        }
        const delayIndexOpen =
            dev && page.url.searchParams.get("openDelay") === "index";

        // Opening the shared worker is graph-only work. Start it as soon as a store object
        // exists, before the Server store scans its cache, so a saturated browser can deliver
        // both results in the same scheduling window. `prepare()` never reads the source;
        // refresh below remains the boundary that may catch up or derive documents.
        const indexProgress = (progress: {
            phase: "loading" | "indexing";
            done: number;
            total: number;
        }) => {
            if (!attempt.isCurrent()) return;
            loadingStep = progress.phase;
            indexed = { done: progress.done, total: progress.total };
        };
        const indexOptions = {
            graphId,
            onProgress: indexProgress,
            onBackgroundError: (error: Error) => {
                if (!attempt.isCurrent()) return;
                health.report({
                    code: "index-refresh-failed",
                    message: `The stored search index could not be verified: ${error.message}`,
                });
            },
        };
        let ownedGraphIndex: RemoteGraphIndex | undefined;
        let currentGraphIndex: RemoteGraphIndex | undefined;
        let detachIndexPersistence = () => {};
        let detachSearchRefresh = () => {};
        let ownsIndexCleanup = false;
        const useGraphIndex = (next: RemoteGraphIndex) => {
            detachIndexPersistence();
            ownedGraphIndex = next;
            currentGraphIndex = next;
            graphIndex = next;
            detachIndexPersistence = next.onPersistenceChanged((status) => {
                if (!attempt.isCurrent() || graphIndex !== next) return;
                applyIndexPersistence(status);
            });
            // Re-run an OPEN Search when the index changes underneath it — a document edited
            // in another tab, a sync arriving, or the initial build finishing. Quick Find
            // already does this for the same reason: results ranked only on keystroke go
            // stale against a graph that moved, and a search that silently misses something
            // is this feature's one unacceptable failure. A no-op while the modal is closed.
            detachSearchRefresh();
            const detachRefresh = next.onUpdated(() => {
                searchController?.refresh();
                // The globe on an included document's tab reads the index's candidate flag,
                // which this update may have changed; a publication page's Save is one such.
                repaintTabPadlocks();
            });
            detachSearchRefresh = () => {
                detachRefresh();
                detachSearchRefresh = () => {};
            };
        };
        const startGraphIndex = (
            source: FilesystemDocumentStore | ServerDocumentStore,
        ): RemoteGraphIndex => {
            if (currentGraphIndex) return currentGraphIndex;
            indexTransport = createSharedIndexTransport(graphId);
            const next = createRemoteGraphIndex(
                source,
                indexTransport,
                indexOptions,
            );
            useGraphIndex(next);
            searchController?.dispose();
            searchController = createSearchController({
                concepts: () => graphIndex?.allConcepts() ?? [],
                searchText: (query, offset, limit) =>
                    graphIndex
                        ? graphIndex.searchText(query, offset, limit)
                        : Promise.resolve({ groups: [], hasMore: false }),
                searchTextCount: (query) =>
                    graphIndex
                        ? graphIndex.searchTextCount(query)
                        : Promise.resolve({ total: 0, capped: false }),
                // Refuse text results rather than showing partial ones: a user cannot tell
                // "not found" from "not indexed yet", and a wrong "no" is this feature's one
                // unacceptable failure.
                building: () =>
                    graphIndex?.isBuilding()
                        ? (indexed ?? { done: 0, total: 0 })
                        : null,
            });
            if (!ownsIndexCleanup) {
                ownsIndexCleanup = true;
                attempt.own(() => {
                    detachIndexPersistence();
                    detachSearchRefresh();
                    ownedGraphIndex?.dispose();
                    // Search is scoped to this graph's index, so it goes with it (ADR 0014).
                    searchController?.dispose();
                    searchController = null;
                });
            }
            return next;
        };
        if (!useServer) {
            const root = await resolveRoot(attempt);
            if (!root) return false; // phase already set (missing / needs-permission)
            const adapter = createWebFsDirectoryAdapter(root);
            const s = createFilesystemDocumentStore(adapter, {
                autosaveMs: dev ? autosaveMs : undefined,
                onConflict: (c) => (conflict = c),
                onResurrected: noteResurrection,
                // A failed write lands in the same notice a failed server save uses, with a
                // Retry that flushes the documents that failed.
                onSaveError: (concept, error) => {
                    console.warn(`[fs] could not save "${concept}"`, error);
                    fsSaveFailures.add(concept);
                    const copy = describeFilesystemSaveFailure(error, concept);
                    health.report({ code: "sync-degraded", message: copy });
                    saveFailure = copy;
                    saveFailureReloadable = false;
                },
            });
            attempt.own(() => s.dispose());
            // Quick Notes: etherpk/quick-notes.json, beside settings.json (ADR 0078). One
            // browser owns the folder, so the whole list is rewritten on every change. Read
            // before the folder scan so a waiting share lands on one file read (ADR 0087,
            // amended), not after every document has been listed.
            let fsQuickNotes = await attempt.wait(readQuickNotes(adapter));
            setQuickNotes(fsQuickNotes, {
                add: async (note) => {
                    fsQuickNotes = [...fsQuickNotes, note];
                    await writeQuickNotes(adapter, fsQuickNotes);
                },
                remove: async (ids) => {
                    const gone = new Set(ids);
                    fsQuickNotes = fsQuickNotes.filter((n) => !gone.has(n.id));
                    await writeQuickNotes(adapter, fsQuickNotes);
                },
            });
            // The Graph Dictionary: etherpk/dictionary.txt, beside quick-notes.json (ADR 0095),
            // rewritten whole on every change. Unlike quick-notes.json an agent may add to it
            // (the folder's AGENTS.md says so), so each write merges what is on disk first
            // rather than overwriting a word added while the graph was open.
            let fsDictionary = await attempt.wait(readDictionary(adapter));
            const writeMerged = async (next: string[]) => {
                fsDictionary = next;
                await writeDictionary(adapter, fsDictionary);
                adoptGraphDictionary(fsDictionary);
            };
            setGraphDictionary(fsDictionary, {
                add: async (word) =>
                    writeMerged(unionDictionary(await readDictionary(adapter), [...fsDictionary, word])),
                remove: async (words) => {
                    const gone = new Set(words);
                    const merged = unionDictionary(await readDictionary(adapter), fsDictionary);
                    await writeMerged(merged.filter((w) => !gone.has(w)));
                },
            });
            await landPendingShare();
            await attempt.wait(s.scan());
            store = s;
            // The folder's AGENTS.md and CLAUDE.md: created on first open, their managed sections refreshed on every later
            // one. Off the critical path and never fatal - a graph whose root cannot be written to
            // is still a graph - so a failure is logged, not surfaced, and the open carries on.
            void ensureAgentInstructions(adapter).catch((error: unknown) => {
                console.warn("[fs] could not update AGENTS.md / CLAUDE.md", error);
            });
            // The Asset store shares the graph's directory adapter (uploads land in assets/).
            assetStore = createAssetStore(adapter);
            attempt.own(() => assetStore?.dispose());
            // Graph Settings (etherpk/settings.json) — a snapshot read once.
            currentFsSettings = await attempt.wait(readGraphSettings(adapter));
            setGraphAccent(graphId, currentFsSettings.toolbarColor);
            // Favourites ride Graph Settings on this backend too, so they land in the
            // committed, exported `etherpk/` folder like the rest of the graph's content.
            setFavourites(currentFsSettings.favourites ?? [], async (next) => {
                currentFsSettings = {
                    ...currentFsSettings,
                    favourites: [...next],
                };
                await writeGraphSettings(adapter, currentFsSettings);
                if (workspaceGeneration !== undefined) {
                    updateWorkspaceServices(workspaceGeneration, {
                        settings: currentFsSettings,
                    });
                }
            });
            // Quick Notes were wired before the folder scan above, so a waiting share could
            // land on one file read; see there.
            // Themes: etherpk/theme-<id>.jsonc, one file per theme (ADR 0082).
            let fsThemes = await attempt.wait(readGraphThemes(adapter));
            const fsThemeById = (id: string) => fsThemes.find((theme) => theme.id === id);
            setGraphThemes(fsThemes, {
                put: async (theme) => {
                    fsThemes = [...fsThemes.filter((existing) => existing.id !== theme.id), theme];
                    await writeGraphTheme(adapter, theme);
                },
                putFile: async (id, path, text) => {
                    const existing = fsThemeById(id);
                    const next = { ...(existing ?? { id, name: id, files: {} }), files: { ...(existing?.files ?? {}), [path]: text }, updatedAt: new Date().toISOString() };
                    fsThemes = [...fsThemes.filter((theme) => theme.id !== id), next];
                    await writeGraphTheme(adapter, next);
                },
                removeFile: async (id, path) => {
                    const existing = fsThemeById(id);
                    if (!existing) return;
                    const files = { ...existing.files };
                    delete files[path];
                    const next = { ...existing, files, updatedAt: new Date().toISOString() };
                    fsThemes = [...fsThemes.filter((theme) => theme.id !== id), next];
                    await writeGraphTheme(adapter, next);
                },
                remove: async (id) => {
                    fsThemes = fsThemes.filter((theme) => theme.id !== id);
                    await deleteGraphTheme(adapter, id);
                },
            });
            // The settings dialog's name field shows the registry display name (local-only).
            // Dev-gate OPFS graphs have no registry record - the id stands in so the
            // dialog's name validation never blocks a settings save.
            fsAdapter = adapter;
            fsFolderName = (await attempt.wait(isOnDisk(root))) ? root.name : undefined;
            const fsRegistry = createIdbGraphRegistry();
            const fsRecord = await attempt.wait(fsRegistry.getGraph(graphId));
            graphDisplayName = fsRecord?.name ?? graphId;
            // The record caches the toolbar colour for the header's Graphs menu, which lists
            // graphs that are not open and so cannot read their settings.json.
            const recoloured = fsRecord && withCachedToolbarColor(fsRecord, currentFsSettings.toolbarColor);
            if (recoloured) void fsRegistry.insertGraph(recoloured);
            assetTools = filesystemAssetTools(adapter, {
                readProtected: readProtectedText,
                settle: settlePendingWrites,
            });
        } else {
            const s = await buildServerStore(useServer, attempt);
            attempt.own(() => s.dispose());
            // Fire-and-overlap is deliberate. The prepared promise owns an immediate
            // rejection observer; refresh consumes the same result and surfaces any error.
            // The dev delay intentionally leaves the worker unopened so tests can prove
            // that source changes arriving before open remain queued and are not lost.
            const earlyIndex = startGraphIndex(s);
            if (!delayIndexOpen) void earlyIndex.prepare();
            // Quick Notes are wired the moment the root doc is hydrated from the cache - the
            // root doc's own Y.Array, not a settings field (ADR 0078) - so a waiting share lands
            // here, before the relay wait in scan() and the index (ADR 0087, amended). A peer's
            // add or remove arrives as an array change and is adopted whole; the View sorts.
            const sg = serverGraph!;
            await attempt.wait(sg.ready());
            const quickNotesApi = sg.quickNotes();
            setQuickNotes(quickNotesApi.list(), {
                add: async (note) => quickNotesApi.add(note),
                remove: async (ids) => quickNotesApi.remove(ids),
            });
            attempt.own(
                quickNotesApi.observe(() => adoptQuickNotes(quickNotesApi.list())),
            );
            // The Graph Dictionary: the root doc's own Y.Map (ADR 0095), a peer's word adopted
            // as it arrives.
            const dictionaryApi = sg.spellingDictionary();
            setGraphDictionary(dictionaryApi.list(), {
                add: async (word) => dictionaryApi.add(word),
                remove: async (words) => dictionaryApi.remove(words),
            });
            attempt.own(
                dictionaryApi.observe(() => adoptGraphDictionary(dictionaryApi.list())),
            );
            await landPendingShare();
            await attempt.wait(s.scan());
            store = s;
            isServerStore = true;
            // Dev/e2e-only introspection hook for the multiplayer spec (like /dev/editor's hooks).
            if (dev)
                (
                    window as unknown as { __etherpkServerStore?: unknown }
                ).__etherpkServerStore = s;
            // Encrypted assets over S3 (ADR 0027) — the real path always has an HTTP base URL;
            // the dev gate only when e2e passes `http`. Uploads encrypt client-side and travel
            // to S3 via presigned URLs.
            if (useServer.httpBaseUrl) {
                assetStore = createServerAssetStore({
                    graphId,
                    keyring: useServer.keyring,
                    baseUrl: useServer.httpBaseUrl,
                    syncToken: useServer.token,
                });
                attempt.own(() => assetStore?.dispose());
                // Orphan scan/cleanup: the blind server only enumerates ids; this
                // key-holding client diffs them against every synced document.
                const orphanDeps = {
                    graph: serverGraph!,
                    graphId,
                    baseUrl: useServer.httpBaseUrl,
                    syncToken: useServer.token,
                    // Names each orphan from its encrypted metadata, and (TEMPORARY, ADR 0053)
                    // lets the scan token legacy assets for reuse.
                    keyring: useServer.keyring,
                    readProtected: readProtectedText,
                    settle: settlePendingWrites,
                };
                assetTools = serverAssetTools(orphanDeps);
                listMirrorAssetIds = () =>
                    listCompleteServerAssetIds(orphanDeps);
                listExportAssets = () => listServerAssets(orphanDeps);
                // An export's scratch file is swept when a graph opens, when an export starts
                // and on a timer while the graph is open (ADR 0092, decision 5).
                if (scratchAvailable()) {
                    void sweepExportScratch({ store: opfsScratchStore() }).catch(
                        () => {},
                    );
                    const sweepTimer = setInterval(
                        () =>
                            void sweepExportScratch({
                                store: opfsScratchStore(),
                            }).catch(() => {}),
                        EXPORT_SCRATCH_SWEEP_INTERVAL_MS,
                    );
                    session.own(() => clearInterval(sweepTimer));
                }
                const storageUrl = `${useServer.httpBaseUrl.replace(/\/$/, "")}/api/v1/sync/graphs/${graphId}/storage`;
                fetchGraphStorage = async () => {
                    const res = await fetch(storageUrl, {
                        headers: { "x-sync-token": await useServer.token() },
                    });
                    if (!res.ok)
                        throw new Error(`storage fetch failed: ${res.status}`);
                    return (await res.json()) as {
                        docBytes: number;
                        assetBytes: number;
                    };
                };
            }
            await wireGraphMeta(attempt);
            // A mirror this device set up earlier picks itself up here. Detached on purpose: the
            // first pass reads the folder, and the workspace must not wait on a disk for it.
            void resumeMirror().catch((error: Error) => {
                health.report({
                    code: "mirror-resume-failed",
                    message: `The mirror folder for this graph could not be reopened: ${error.message}`,
                });
            });
        }
        const s = store!;
        currentGraphIndex ??= startGraphIndex(s);
        const storeReadyAt = performance.now();

        // The graph-scoped Event bus (extension surface, Phase 1). Created here so
        // it is active before the Views mount in restore(); torn down on leave. The
        // composition root is the only place that knows both the store and the bus,
        // so it bridges the store's document-set signal onto `documents:changed`
        // (the store stays a leaf, unaware of the surface).
        bus = createEventBus(graphId);
        detachDocsBridge = s.onDocumentsChanged(() => {
            identityIndex = null;
            bus?.emit("documents:changed", {});
        });
        // A `title` edited outside the app is a rename that already happened (ADR 0061): the
        // store re-keyed the document, and everything keyed by its old name follows.
        detachDocRenamed = (
            s as {
                onDocumentRenamed?: (
                    l: (from: string, to: string) => void,
                ) => () => void;
            }
        ).onDocumentRenamed?.((from, to) => {
            identityIndex = null;
            void documentMutations.followRename(from, to);
            notify(
                `"${from}" was renamed to "${to}" outside EtherPK; it now answers to that name.`,
            );
        });
        // A document that has gone must not leave its tab behind over a phantom buffer.
        // `onDocumentRemoved` has existed on both stores from the start with NO consumer -
        // delete is simply the first thing that makes it reachable from inside the app.
        // Moving from a protected document to another masks (ADR 0058); coming back to a
        // protected one shows it again, on the same terms as the window coming back. Only
        // KNOWN documents count either way: the active document changes as a View mounts,
        // before its store document is open, and masking on that would hide the very
        // document the user is opening with nothing to bring it back.
        // What Show backlinks asked the Backlinks View to show while it follows the editor
        // stands only while the editor stays put. The store is told of every move here rather
        // than by the View, which a phone's closed drawer has unmounted. Read lazily: Reset
        // workspace replaces the store.
        detachActiveForBacklinks = bus.on(
            "document:active-changed",
            ({ documentId }) => backlinksPreferences?.activeDocumentChanged(documentId),
        );
        let lastActiveProtected = false;
        detachActiveForProtection = bus.on(
            "document:active-changed",
            ({ documentId }) => {
                if (!protection?.isConfigured) return;
                const kind =
                    documentId === null
                        ? undefined
                        : protectedStore?.protectionKindFor(documentId);
                if (kind === undefined) return;
                if (kind === "document") {
                    maybeShown();
                } else if (lastActiveProtected) {
                    protection.navigatedAway();
                }
                lastActiveProtected = kind === "document";
            },
        );
        detachDocRemoved = s.onDocumentRemoved((target) => {
            // The document the user is IN stays put. A removal that arrives from elsewhere is
            // a proposal, not a fact: ADR 0039 §4 gives their next keystroke the last word,
            // and a View that has already been closed can no longer be typed in — which made
            // resurrection unreachable in practice until this exception existed. Every other
            // open-but-untouched document closes, as the ADR says. A delete the user made
            // themselves is closed explicitly by `confirmDelete`.
            if (getActiveDocument() === target) return;
            controller?.closeView({ kind: "document", target });
        });

        // Recents: per-device, per-graph (ADR 0036 §3). Opened before the Views mount so the
        // Sidebar's subscription finds a real store rather than the no-op stand-in.
        recents = createRecents(graphId);

        // Finish opening the derived SQLite index before the Views mount because the editor's
        // missing-link styling and the Backlinks View read it on mount. The index lives
        // in an owning dedicated worker and persists to OPFS (ADRs 0041 and 0042): a reopened graph
        // usually attaches to what is already built instead of re-deriving every document.
        // Progress only appears when there IS a build to report.
        // Give the deep-linked document the same foreground head start on cold and warm
        // opens. The index source is subscribed first so an early relay update cannot be
        // missed, then this temporary retain bridges the gap until DocumentView mounts and
        // takes its own reference. Without it, warm reconciliation could enqueue the chosen
        // document as background work before the presenter even existed.
        const initialTarget = isServerStore ? page.params.concept : undefined;
        if (initialTarget) {
            const release = (s as ServerDocumentStore).retainDocument(
                initialTarget,
            );
            let released = false;
            releasePreloadedDocument = () => {
                if (released) return;
                released = true;
                release();
            };
            attempt.own(releasePreloadedDocument);
            // DocumentView owns any user-facing readiness error once it mounts. Handling this
            // eager promise prevents a rejection from escaping during the index wait.
            preloadedDocumentReady = (s as ServerDocumentStore)
                .whenReady(initialTarget)
                .catch(() => {});
        }
        if (delayIndexOpen) {
            await attempt.wait(
                new Promise((resolve) => setTimeout(resolve, 2_000)),
            );
        }
        try {
            await attempt.wait(currentGraphIndex.refresh());
        } catch (error) {
            // Only transport OPEN failures justify changing host. A source stream, rebuild
            // or lock failure would fail identically inline; retrying it there merely walks
            // the graph twice, loses the real persistence reason and mislabels the problem.
            if (!(error instanceof IndexTransportOpenError)) throw error;
            // Fail closed (ADR 0041): a worker that cannot start — a blocked script, a
            // broken service worker, an exotic CSP — degrades to the inline index on this
            // thread. Slower, never unopenable. (Found live: a SW that wrapped every fetch
            // in respondWith() killed the worker's wasm load and hung the open here.)
            console.warn(
                "[index] shared transport open failed; using inline fallback:",
                error,
            );
            currentGraphIndex.dispose();
            indexTransport = inlineTransport();
            currentGraphIndex = createRemoteGraphIndex(
                s,
                indexTransport,
                indexOptions,
            );
            useGraphIndex(currentGraphIndex);
            await attempt.wait(currentGraphIndex.refresh());
            health.report({
                code: "index-fallback",
                message:
                    error instanceof Error
                        ? error.message
                        : "The persistent index worker was unavailable.",
            });
        }
        // Dev/e2e-only introspection hook (like __etherpkServerStore): the two-tab sharing
        // spec asserts persistence and cross-tab snapshot flow through it.
        if (dev)
            (
                window as unknown as { __etherpkGraphIndex?: unknown }
            ).__etherpkGraphIndex = graphIndex;
        // Dev/e2e-only: run a Command by id. The protection specs need to lock deterministically,
        // and reaching Lock now through the Command Menu would mean typing `/` into the editor —
        // which, on an unlocked Protected Document, lands in the projected plaintext and is
        // committed, so the spec would corrupt the very secret it is asserting on.
        if (dev) {
            (
                window as unknown as { __etherpkCommands?: unknown }
            ).__etherpkCommands = {
                execute: (id: string, arg?: unknown) =>
                    commandRegistry?.execute(id, arg),
            };
            // Dev/e2e-only: open a View through the Layout controller. The tab-management specs
            // need a second main-region Pane, and the only user path to one on desktop is a
            // dockview tab drag - an HTML5 drag-and-drop a spec cannot drive reliably.
            (
                window as unknown as { __etherpkLayout?: unknown }
            ).__etherpkLayout = {
                openView: (
                    ...args: Parameters<
                        NonNullable<typeof controller>["openView"]
                    >
                ) => controller?.openView(...args),
                // The phone spec closes a resident this way: the drawer strip deliberately has no
                // close cross on one, so the only route to a closed resident on a phone is a
                // desktop that closed it earlier.
                closeView: (
                    ...args: Parameters<
                        NonNullable<typeof controller>["closeView"]
                    >
                ) => controller?.closeView(...args),
                // A tab drag, as dockview performs one: the same `moveGroupOrPanel` path and the
                // same events, so the specs can drive drags within and between Panes.
                movePanel: (
                    panelId: string,
                    index: number,
                    besidePanelId?: string,
                ) => {
                    const api = (renderer as DockviewRenderer | undefined)?.api;
                    const group = besidePanelId
                        ? api?.getPanel(besidePanelId)?.api.group
                        : undefined;
                    api?.getPanel(panelId)?.api.moveTo({ group, index });
                },
            };
        }
        // With cross-tab sharing (ADR 0042) a second tab attaches to the owner's persisted
        // index, so this banner is reserved for environments that truly cannot persist —
        // no OPFS/SyncAccessHandle, no Web Locks, some private modes. Say so once per device.
        applyIndexPersistence({
            persisted: currentGraphIndex.isPersisted(),
            blocked: currentGraphIndex.persistenceBlocked(),
        });
        console.debug(
            `[open] store ${Math.round(storeReadyAt - openStarted)}ms, index ${Math.round(performance.now() - storeReadyAt)}ms, persisted=${indexPersisted}, backend=${isServerStore ? "server" : "fs"}`,
        );

        // The Command registry + app-level keybindings (extension surface, step 4).
        // The registry's genuine first indirect consumer; editor block-ops stay
        // CM-native. Handlers read `controller` lazily — it is created in mountPresenter.
        commandRegistry = createCommandRegistry();
        // Each Sidebar toggle brings its resident back first if it has been closed (residents.ts):
        // a chord that expanded an empty Sidebar was the only way to lose a View for good.
        commandRegistry.register("layout.toggleSidebar", () => {
            if (controller) toggleResidentSidebar(controller, [RESIDENTS.graph, RESIDENTS.quickNotes]);
        });
        commandRegistry.register("layout.toggleBacklinks", () => {
            if (controller) toggleResidentSidebar(controller, [RESIDENTS.backlinks, RESIDENTS.tasks]);
        });
        // The reveal commands (Alt+G / Alt+B): the resident in front of an expanded Sidebar.
        commandRegistry.register("graph.open", () => {
            if (controller) revealResident(controller, RESIDENTS.graph);
        });
        commandRegistry.register("backlinks.open", () => {
            if (controller) revealResident(controller, RESIDENTS.backlinks);
        });
        // Reset workspace: the Command opens the confirmation; `resetWorkspace` does the work.
        commandRegistry.register("workspace.reset", () => {
            resetDialogOpen = true;
        });
        commandRegistry.register("document.openTodayJournal", () =>
            controller?.openView({ kind: "document", target: todayISO() }),
        );
        commandRegistry.register("document.openAllDocuments", () =>
            controller?.openView({
                kind: "all-documents",
                target: "all-documents",
            }),
        );
        commandRegistry.register("search.open", (argument?: unknown) =>
            // The optional argument is Quick Find handing over what was already typed.
            searchController?.open(
                typeof argument === "string" ? argument : "",
            ),
        );
        // Tasks is a resident of the right Sidebar, so this never creates it: openView, given
        // an identity that is already open, FOCUSES that tab. It does not expand a collapsed
        // region, though — placeInstance only adds and focuses — so a focused tab in a
        // collapsed Sidebar would still be invisible. Expanding after is what makes "open
        // Tasks" mean the user can see them. (The resident itself is ensured post-restore.)
        commandRegistry.register("tasks.open", () => {
            if (controller) revealResident(controller, RESIDENTS.tasks);
        });
        // Quick Notes is the left Sidebar's second resident: the same reveal as Tasks, plus an
        // Event the View answers by putting the caret in its box, so Alt+N, type, Enter captures
        // a thought from anywhere without a pointer.
        commandRegistry.register(QUICK_NOTES_OPEN, () => {
            if (!controller) return;
            // A View that is not open yet mounts AFTER this tick and misses the Event, so the
            // request is left for it to take at mount; an open one hears the Event.
            const mounted = controller.findView(QUICK_NOTES_VIEW.kind) !== undefined;
            if (!mounted) requestQuickNoteFocus();
            revealResident(controller, RESIDENTS.quickNotes);
            if (mounted) bus?.emit("quick-notes:focus", {});
        });
        // The Settings modal, for a surface with no cog of its own. The desktop toolbar carries
        // one; the mobile presenter's chrome does not, so on a phone the Sidebar offers Settings
        // from the drawer - through the registry, as Tasks is, so the Sidebar learns nothing about
        // the workspace's dialogs.
        commandRegistry.register(
            "graph.settings.open",
            () => openGraphSettings(),
        );
        // The publishing pair (ADR 0082): Alt+P for the settings, Alt+Shift+P to publish again.
        commandRegistry.register("publish.settings", () => openGraphSettings("publish"));
        // Spell Check (ADR 0095): its Spelling tab, then the spelling menu's rows, the phone's
        // Fix spelling button and the `/` row.
        commandRegistry.register(SPELLING_OPEN_SETTINGS, () => openGraphSettings("spelling"));
        detachSpellingCommands = registerSpellingCommands(commandRegistry, contributions);
        commandRegistry.register("publish.run", () => void publishAgain());
        // Registered so a keybinding or a menu row can reach it later; today it is offered from
        // Graph Settings → Storage, beside the orphaned-asset scan it belongs with.
        commandRegistry.register("index.rebuild", () => void rebuildIndex());
        // The Keyboard Shortcuts card: the toolbar button and its own chord both come here.
        commandRegistry.register("help.openShortcuts", () => {
            shortcutsDialogOpen = true;
        });
        // The Command Menu's editor Commands (date insertion + table edits) and their
        // menu-item descriptors — the Contribution registry's second kind (ADR 0017).
        detachEditorCommands = registerEditorCommands(
            commandRegistry,
            contributions,
        );
        // The [[File Link]] Command (copy the path) and its `/` menu row; a refused clipboard
        // write is told through the workspace notice, path included.
        detachLinkCommands = registerLinkCommands(
            commandRegistry,
            contributions,
            { onError: (text) => notify(text) },
        );
        // Favourites + rename, and their Context Menu rows — the registry's fourth kind.
        detachDocumentCommands = registerDocumentCommands(
            commandRegistry,
            contributions,
            {
                promptRename: (concept) => startRename(concept),
                promptDelete: (concept) => startDelete(concept),
                promptPublish: (concept) => void startPublishDocument(concept),
                // Show backlinks: tell the store what to show (the pin is left as it is, ADR
                // 0088), then reveal the View. The store first, so a View the reveal mounts (a
                // phone's drawer) reads it at mount; one already mounted hears it.
                showBacklinks: (concept) => {
                    backlinksPreferences?.show(concept, getActiveDocument());
                    if (controller) revealResident(controller, RESIDENTS.backlinks);
                },
                onError: (text) => notify(text),
                onCopied: (text) => notify(text),
                hasFilePath: (concept) =>
                    fsFolderName !== undefined && fileLocationOf(concept) !== null,
                copyFilePath: (concept) => void copyDocumentFilePath(concept),
            },
        );
        // The Quick Notes move and its Command Menu row (ADR 0078). The raw store, not the
        // protection decorator: a journal cannot be protected, and a bare open through the
        // decorator would leave a wrapper retained for nothing.
        detachQuickNotesCommands = registerQuickNotesCommands(
            commandRegistry,
            contributions,
            {
                store: () => store,
                openConcept: (concept) =>
                    controller?.openView({ kind: "document", target: concept }),
                onError: (text) => notify(text),
                onMoved: (moved) =>
                    notify(
                        moved === 1
                            ? "Moved 1 quick note to today's journal"
                            : `Moved ${moved} quick notes to today's journal`,
                    ),
            },
        );
        // The [[Asset Reference]] Commands and their Context Menu rows (ADR 0054), plus
        // the viewers that decide what "open in a new tab" is offered for (ADR 0055).
        detachAssetViewers = registerAssetViewers(contributions);
        detachAssetCommands = registerAssetCommands(
            commandRegistry,
            contributions,
            {
                store: () => assetStore ?? null,
                tools: () => assetTools,
                index: () => graphIndex ?? null,
                protectedUsage: protectedUsageOf,
                download: downloadResolvedAsset,
                copyImage: copyImageToClipboard,
                openAsset: (assetId) =>
                    controller?.openView({ kind: "asset", target: assetId }),
                canOpen: canOpenAsset,
                canCopyImage: canCopyImageAsset,
                applyToEditor: (command) => {
                    const view = getActiveEditorView();
                    return view
                        ? command({
                              state: view.state,
                              dispatch: (tr) => view.dispatch(tr),
                          })
                        : false;
                },
                promptDelete: (prompt) =>
                    new Promise<AssetDeleteChoice>((resolve) => {
                        deletingAsset = {
                            prompt,
                            decide: (choice) => {
                                deletingAsset = null;
                                resolve(choice);
                            },
                        };
                    }),
                onError: (text) => notify(text),
                onNotice: (text) => notify(text),
            },
        );
        // Tab management (close others / to the right / to the left) on any Pane tab.
        detachTabCommands = registerTabCommands(
            commandRegistry,
            contributions,
            {
                controller: () => controller,
            },
        );
        // The built-in Augmentation renderers (mermaid, math) — ADR 0022.
        detachRenderers = registerAugmentationRenderers(contributions);
        // The one list: the same rows the Keyboard Shortcuts card shows (keyboard-shortcuts.ts).
        detachKeybindings = attachKeybindings(commandRegistry, APP_KEYBINDINGS);

        // The graph opened successfully: remember it so a root visit resumes here.
        setLastGraphId(graphId);

        layoutStore = createLocalLayoutStore();

        // Navigation History (ADR 0023): Reading Positions per graph (localStorage),
        // per-Visit snapshots per tab (sessionStorage), and the Visit engine over
        // both. The engine reads the controller lazily — presenter swaps recreate it.
        readingPositions = createReadingPositions(graphId);
        // The Tasks View's filter: per-device, per-graph, and deliberately NOT in the Layout
        // model — a per-View state slot there would bump LAYOUT_VERSION and discard everyone's
        // saved pane arrangement to persist a filter.
        taskFilter = createTaskFilterStore(graphId);
        // The Backlinks View's highlight toggle and pin, kept out of the Layout for the same reason.
        backlinksPreferences = createBacklinksPreferencesStore(graphId);
        const snapshots = createVisitSnapshots();
        navEngine = createHistoryEngine({
            graphId,
            controller: () => controller,
            // Preserve the query string (?fs=opfs, ?autosaveMs=… in dev/e2e —
            // documentUrl builds a bare path and pushState resolves against the
            // current URL, so the search would otherwise be silently dropped) -
            // all but the Settings param: a Visit is a View becoming active, and
            // Settings is never open on the entry a fresh Visit makes (ADR 0023,
            // 2026-09-20). That drop is what closes the modal when the Publish tab
            // sends someone to a theme or a page, and what lets Back find it again.
            pushUrl: (url, state) =>
                pushState(url + withoutSettingsTab(page.url.search), { etherpkVisit: state }),
            replaceUrl: (url, state) =>
                replaceState(url + withoutSettingsTab(page.url.search), { etherpkVisit: state }),
            capture: capturePosition,
            restore: (key, position) => void restorePosition(key, position),
            readingPosition: (key) => readingPositions?.get(key) ?? null,
            saveSnapshot: (id, position) => snapshots.save(id, position),
            loadSnapshot: (id) => snapshots.load(id),
        });

        // ── Protection (ADR 0057-0059) ──────────────────────────────────────────────────────
        // The record lives with the user, not with the graph's shared content: in `etherpk/` on a
        // Filesystem Backend (no account, no other member) and in the personal account vault on a
        // Server Backend. A synced graph reached with no account at all — a bare relay, the test
        // harness — keeps a device-local record instead: the passphrase-wrapped key, exactly what a
        // graph folder holds, so nothing ADR 0057 protects is given up; only portability is, as on
        // a Filesystem Backend. An in-memory store here lost the passphrase on every reload.
        const protectionApi = useServer ? createConfiguredSyncApi() : null;
        const protectionRecords = !useServer
            ? fsAdapter
                ? filesystemProtectionStore(fsAdapter)
                : inMemoryProtectionStore()
            : protectionApi
              ? vaultProtectionStore(
                    graphId,
                    vaultProtectionAccess(protectionApi, async () => {
                        const cached = getVaultWrapKey();
                        if (!cached) throw new VaultLockedError();
                        return cached;
                    }),
                )
              : localProtectionStore(graphId);

        const protectionSession = new ProtectionSession({
            store: protectionRecords,
            // The forced commit of ADR 0058, run before the key is discarded. It cannot fail for
            // want of a key: the machine emits it while the key is still held.
            commit: async () => {
                await protectedStore?.commitAll();
            },
            onChange: () => {
                // A lock transition is not a document change, so the editor needs telling twice:
                // the projections must drop, hide, or re-open, and the fence widgets must redraw.
                // Masked is its own branch (ADR 0058): the bodies are kept but the cards go up,
                // synchronously, before anything else can paint.
                const status = protectionSession.status;
                if (status === "locked") {
                    // The relock swaps ciphertext into every protected editor (their coordinators
                    // sweep the plaintext results as it does); only then may the render caches
                    // go, because the clear re-renders whatever the live editors still show.
                    // finally, not then: relockAll rejects on the first failing
                    // relock and the clear must still run.
                    void (protectedStore?.relockAll() ?? Promise.resolve()).finally(() =>
                        clearAugmentationRenderCaches(),
                    );
                } else if (status === "masked") {
                    protectedStore?.maskAll();
                } else {
                    protectedStore?.unmaskAll();
                    void protectedStore?.unlockAll();
                }
                notifyProtectionChanged();
            },
        });
        protection = protectionSession;
        protectionRecordStore = protectionRecords;
        void refreshProtectionRecord();

        protectedStore = createProtectedDocumentStore(s, {
            encrypt: (plaintext: string) =>
                protectionSession.service.encrypt(plaintext),
            decryptEnvelope: (armoured: string) =>
                protectionSession.service.decryptArmoured(armoured),
            onError: (error) =>
                notify(`Could not save protected content: ${error.message}`),
            onOpened: (target) => {
                repaintTabPadlocks();
                // Opening a protected document is coming to it (ADR 0058's navigate-away, in
                // reverse); the check inside keeps a hidden tab's preloads from counting.
                if (protectedStore?.protectionKindFor(target) === "document")
                    maybeShown();
            },
            // Its editor was bound to the CRDT before its text seeded, and can never show a
            // projection. Same remount a local protection change gets.
            onCollabBoundProtected: (target) =>
                announceProtectionChanged(target),
        });
        attempt.own(() => {
            protectionSession.dispose();
            protectedStore?.dispose();
        });
        // The augmentation reads this accessor rather than a facet, so it is what makes a locked
        // fence render as "Unlock" instead of the safe default of an unexplained lock card.
        setActiveProtectionStatus(buildProtectionStatus(protectionSession));
        // Deliberately NOT awaited, for the same reason as the passkey lookup below: reading the
        // record is a vault fetch on a Server Backend, and putting a network round trip in front of
        // the index open delayed the whole warm-open sequence. `start()` arms the lock lifecycle
        // synchronously before it gets there, and until the record lands the graph reads as locked
        // — which is what it is. Never fatal: a graph whose record cannot be read must still open.
        void protectionSession
            .start()
            .then(() => notifyProtectionChanged())
            .catch(() => notifyProtectionChanged());
        // Deliberately NOT awaited, and not on the critical path: this opens a fresh IndexedDB
        // database, and blocking a graph open on it pushed a large-graph multi-tab timing budget
        // over its limit. Nothing needs the answer at open — the unlock dialog re-reads it, and
        // the settings tab only shows a row. Never fatal either: a browser with no usable
        // IndexedDB must still open the graph and unlock with a passphrase.
        void boundPasskey(graphId, protectionSession.fingerprint)
            .then((wrap) => (protectionPasskeyBound = wrap !== null))
            .catch(() => (protectionPasskeyBound = false));

        detachProtectionCommands = registerProtectionCommands(
            commandRegistry,
            contributions,
            {
                isConfigured: () => protectionSession.isConfigured,
                isUnlocked: () => protectionSession.isUnlocked,
                isProtected: (concept) => isConceptProtected(concept),
                lockNow,
                promptUnlock: () => void openUnlockProtection(null),
                promptProtect: (concept) => void startProtect(concept),
                promptUnprotect: (concept) => void startUnprotect(concept),
                activeConcept: () => getActiveDocument(),
                // Only pages can be protected — a journal entry's body is its identity by date.
                isProtectable: (concept) => !isJournalConcept(concept),
                onError: (text) => notify(text),
            },
        );

        // Reconciliation is a Filesystem-only concern (external edits under a dirty buffer).
        // A CRDT backend merges instead of conflicting, so reconcile() is a no-op — skip it.
        if (!useServer)
            detachReconcile = attachReconciliation(
                s as FilesystemDocumentStore,
            );
        attempt.checkpoint();
        workspaceGeneration = publishWorkspaceServices({
            graphId,
            health,
            // The PROJECTION, not the raw store: every editor surface must see a Protected
            // Document's plaintext while the key is held (ADR 0059). The index is given the raw
            // `s` above and keeps seeing ciphertext, which is what keeps protected content out of
            // a file that is plaintext at rest in OPFS.
            store: protectedStore ?? s,
            assets: assetStore,
            index: graphIndex,
            settings: isServerStore
                ? sanitizeGraphSettings(serverGraph?.getMeta().settings ?? {})
                : currentFsSettings,
            events: bus,
            commands: commandRegistry,
            contributions,
            readingPositions,
            // Getters over the session's runes, so a template reading them re-renders on a lock
            // transition. Actions only: no key, no record, nothing to leak.
            protection: {
                get isConfigured() {
                    return protectionSession.isConfigured;
                },
                get status() {
                    return protectionSession.status;
                },
                lockNow,
                requestUnlock: () => void openUnlockProtection(null),
            },
            recents,
            taskFilter,
            backlinksPreferences,
            backend: isServerStore ? "server" : "filesystem",
            publishing: {
                readSource: () => readGraphForPublishing(),
                environment: () => publishEnvironment(),
            },
            frontmatter: {
                backend: isServerStore ? "server" : "filesystem",
                identityOf,
                proposalFor: (target, blockText) => {
                    const registry = identityOf(target);
                    if (!registry) return [];
                    return proposeFrontmatter({
                        text: blockText,
                        registry,
                        backend: isServerStore ? "server" : "filesystem",
                        fileStem: registry.fileStem,
                    });
                },
                episodeEnded: (target, end) =>
                    void frontmatterController.episodeEnded(target, end),
                restore: (target) => frontmatterController.restore(target),
            },
            wikilinkRename: {
                edited: (target, before, after) =>
                    void linkRenameController.edited(target, before, after),
            },
            // A View that learns its name late (an asset tab on a synced graph) retitles through
            // this rather than holding the renderer, which a presenter swap replaces. Published
            // here, not via setWorkspaceService: that setter writes to whatever generation is
            // current, and this publish replaces it wholesale - which is exactly how the first
            // attempt at this vanished before any View could call it.
            retitleView: (panelId, title) =>
                renderer?.setTitle?.(panelId, title),
        });
        return true;
    }

    /**
     * A document View became the active one — however it happened, on whichever presenter.
     *
     * The focus policy lives here, once, because the workspace is the only party that knows
     * both things it depends on: whether the Layout is still assembling, and which presenter
     * is live. The View itself owns the other half of the question — whether it has anything
     * in it to read — because only it can see past [[Frontmatter]] and a [[Draft]] to the body
     * (`PositionAdapter.focusIfEmpty`).
     *
     * Desktop puts the caret in whatever document you activate: that is the VS Code feel ADR
     * 0023 is after, and a keyboard is already on the desk. Mobile takes it only when the
     * document is EMPTY, because there focus means the soft keyboard rising over half the
     * screen — right when there is nothing to write is the one time that is what you wanted,
     * and tapping a wikilink to READ a page is every other time.
     *
     * Deferred a frame for both: dockview focuses the group element AFTER this event and would
     * steal focus straight back, and the mobile presenter has not yet mounted the View (it
     * renders on the effect flush), so its adapter is not registered until after this returns.
     * Re-checked inside that frame, so a fast second activation wins rather than both firing.
     */
    function focusActivatedDocument(panelId: string): void {
        if (suppressNav) return;
        requestAnimationFrame(() => {
            const active = controller?.activeView();
            if (active?.panelId !== panelId || active.view.kind !== "document")
                return;
            if (useMobile) focusEditorIfEmpty(panelId);
            else focusEditor(panelId);
        });
    }

    /**
     * Create the renderer for the current viewport (dockview or mobile) and a
     * controller over it, then restore state. Pass a `model` to carry live state
     * across a presenter swap; omit it on first mount to load from the store.
     */
    async function mountPresenter(
        attempt: GraphOpenAttempt,
        model?: LayoutModel,
    ) {
        const initial = model
            ? { version: LAYOUT_VERSION, model }
            : ((await attempt.wait(layoutStore!.load(graphId))) ??
              freshLayout());

        if (useMobile) {
            const { createMobileRenderer } = await attempt.wait(
                import("$lib/layout/renderers/mobile-renderer.svelte"),
            );
            mobileRenderer = createMobileRenderer(registry, {
                onActiveViewChange: (panelId) => {
                    noteMainViewActivated(viewForActivatedPanel(panelId));
                    focusActivatedDocument(panelId);
                },
            });
            renderer = mobileRenderer;
        } else {
            const { createDockviewRenderer } = await attempt.wait(
                import("$lib/layout/renderers/dockview-adapter"),
            );
            mobileRenderer = undefined;
            await waitForSize(container!, attempt);
            renderer = createDockviewRenderer({
                container: container!,
                registry,
                onGeometryChange: scheduleSave, // persist drags / resizes
                markFor: (panelId) => tabMarkFor(panelId),
                // The pin on a pinned tab. The controller owns the flag and is created just
                // below; the renderer asks lazily, on each repaint, so the order is fine.
                pinnedFor: (panelId) =>
                    controller?.isViewPinned(panelId) ?? false,
                // Follow the active editor tab so the Backlinks View tracks whichever
                // document is active, however it was activated (tab click, navigation).
                onActiveViewChange: (view) => {
                    if (view) noteMainViewActivated(view);
                    // A raw tab click activates a panel without passing through the
                    // controller; mirror it into the model so persistence and the
                    // Visit engine (via onChange) see the real active View.
                    if (view) controller?.notePanelActivated(viewKey(view));
                    // Then the shared focus policy — the same call the mobile renderer makes.
                    if (view) focusActivatedDocument(viewKey(view));
                },
                // Keep the model in sync when a tab is closed via dockview's native ×,
                // so reopening it from the tree works (and a reload won't re-open it).
                onViewClosed: (panelId) =>
                    controller?.forgetClosedView(panelId),
            });
        }
        controller = createLayoutController({
            renderer,
            registry,
            onChange: () => {
                scheduleSave(); // persist open / close / focus / collapse
                if (!suppressNav) navEngine?.sync();
            },
        });
        // Set the accessors BEFORE restore(), because restore() mounts the Views and
        // they read the active store / controller in their onMount.
        if (workspaceGeneration !== undefined) {
            updateWorkspaceServices(workspaceGeneration, {
                layout: controller,
            });
        }
        // Suppress saves while restore() assembles the layout (it emits transitional
        // geometry events); persist the baseline once, then re-enable.
        suppressSave = true;
        suppressNav = true;
        controller.restore(initial);
        // A restored Layout brings the title its tab was saved with; the name is the truth.
        retitleSidebar();
        // Tasks is a RESIDENT of the right Sidebar (CONTEXT.md → Sidebar): present as a tab from
        // the first open, on every device. A Layout persisted before it became one has no
        // Tasks tab and — being per-device — would never gain it, so the resident is ensured
        // here rather than by bumping LAYOUT_VERSION, which would discard everyone's panes to
        // add one tab. `activate: false` places it without stealing focus or expanding anything;
        // a Layout that already holds it is untouched (openView focuses the existing View).
        if (!controller.isOpen(TASKS_VIEW))
            controller.openView(TASKS_VIEW, { activate: false });
        // Quick Notes is the left Sidebar's resident (ADR 0078), ensured the same way.
        if (!controller.isOpen(QUICK_NOTES_VIEW))
            controller.openView(QUICK_NOTES_VIEW, { activate: false });
        // A share that landed while the graph was opening (ADR 0087, amended) is shown now: in
        // front of its Sidebar, expanded, and BEFORE the baseline save below, so the layout is
        // persisted with Quick Notes in front and a reload finds it there. Revealing after this
        // function returned put it inside the save-suppression window and lost it on reload.
        if (revealQuickNotesOnMount) {
            revealQuickNotesOnMount = false;
            revealResident(controller, RESIDENTS.quickNotes);
        }
        saveLayout();
        requestAnimationFrame(() => {
            if (attempt.isCurrent()) suppressSave = false;
        });
        // Navigation: a Document URL on a fresh load means "restore the layout,
        // then ensure that document is open and focused" (ADR 0023); a bare URL
        // is replaceState-normalised by seed(). First mount only — a presenter
        // swap carries live state and keeps its current Visit.
        if (!seeded) {
            const view = viewFromParams();
            if (view) controller.openView(view);
            suppressNav = false;
            navEngine?.seed();
            adoptSettingsFromUrl();
            seeded = true;
        } else {
            suppressNav = false;
        }
    }

    /**
     * The [[View]] the current URL names, or null for a bare workspace URL. The inverse of
     * `viewUrl` - one place that reads the route params, so both the deep-link path and the
     * popstate path agree about what an address means.
     */
    function viewFromParams(): ViewRef | null {
        const concept = page.params.concept;
        if (concept) return { kind: "document", target: concept };
        const assetId = page.params.assetId;
        if (assetId) return { kind: "asset", target: assetId };
        const themeId = page.params.themeId;
        if (themeId) return { kind: "theme", target: themeId };
        return null;
    }

    /**
     * A real navigation carrying `?settings=<tab>` - a deep link, a reload, a post-reload Back -
     * has no state of ours yet, so the tab is read off the URL once and written into the entry's
     * state, which is what the modal follows from then on. Not pushed by this workspace, so
     * closing it strips the address in place rather than going back to wherever the browser
     * came from. A value that is not a tab is dropped from the address rather than left to
     * mislead. Nothing is touched when the address names no Settings at all.
     */
    function adoptSettingsFromUrl() {
        if (!page.url.searchParams.has(SETTINGS_PARAM)) return;
        const tab = settingsTabFromUrl(page.url);
        // `location`, not `page.url`: seed() may just have replaced the address, which
        // `page.url` does not reflect (shallow writes never update it).
        const search = tab
            ? withSettingsTab(location.search, tab)
            : withoutSettingsTab(location.search);
        const state = { ...page.state };
        if (tab) state.etherpkSettings = { tab, pushed: false };
        else delete state.etherpkSettings;
        replaceState(location.pathname + search, state);
    }

    /** Swap presenters when the viewport crosses the breakpoint, carrying state. */
    async function switchPresenter(mobile: boolean) {
        const attempt = openAttempt;
        if (!attempt) return;
        try {
            await session.transitionPresenter(async () => {
                attempt.checkpoint();
                if (mobile === useMobile || phase !== "ready") return;
                const snapshot = controller?.serialize().model;
                renderer?.destroy?.();
                controller = undefined;
                renderer = undefined;
                mobileRenderer = undefined;
                useMobile = mobile;
                await attempt.wait(tick());
                await mountPresenter(attempt, snapshot);
            });
        } catch (error) {
            if (!(error instanceof GraphSessionCancelledError)) throw error;
        }
    }

    async function build() {
        const attempt = session.beginOpen();
        openAttempt = attempt;
        shareWaiting = peekPendingShare()?.graphId === graphId;
        shareLanded = false;
        revealQuickNotesOnMount = false;
        try {
            if (!(await openGraph(attempt))) {
                attempt.discard();
                return;
            }
            useMobile = prefersMobileLayout();
            // Access can end while the graph is still opening (a deleted graph's cached copy
            // refused a token): the notice stands, the workspace behind it stays hidden.
            if (!accessLoss) phase = "ready";
            await attempt.wait(tick());
            await session.transitionPresenter(() => mountPresenter(attempt));
            // Svelte has now mounted the requested DocumentView. Keep the temporary claim
            // until cache hydration has at least issued the foreground request; IndexedDB can
            // otherwise finish after a quick index/presenter path and observe no retain at all.
            await attempt.wait(tick());
            if (preloadedDocumentReady)
                await attempt.wait(preloadedDocumentReady);
            releasePreloadedDocument?.();
            releasePreloadedDocument = undefined;
            preloadedDocumentReady = undefined;
            attempt.checkpoint();
            attempt.commit();
            stopWatch = watchMobileLayout(
                (mobile) => void switchPresenter(mobile),
            );
        } catch (error) {
            renderer?.destroy?.();
            renderer = undefined;
            controller = undefined;
            mobileRenderer = undefined;
            releasePreloadedDocument?.();
            releasePreloadedDocument = undefined;
            preloadedDocumentReady = undefined;
            if (workspaceGeneration !== undefined) {
                clearWorkspaceServices(workspaceGeneration);
                workspaceGeneration = undefined;
            }
            attempt.discard();
            throw error;
        }
    }

    /**
     * The [[Share Target]]'s hand-off (ADR 0087, amended 2026-09-21): the share page chose this
     * graph and stashed the text; the note is added the moment the graph's quick notes are
     * wired - the root doc hydrated from the cache on a Server Backend, the notes file read on a
     * Filesystem Backend - before the relay wait, the index and the presenter, so a phone is not
     * kept waiting on the whole open for a one-line write. The note carries the instant it was
     * shared, and the Quick Notes resident is revealed with it at the top once a presenter
     * exists. The caret is NOT put in the box - on a phone that pops the keyboard, and the user
     * came to put something down, not to type. Taken before the add, so a reload cannot add it
     * twice; a refused write puts the text in the box as unsent text, the same fallback a typed
     * note gets, and the notice says why.
     */
    async function landPendingShare(): Promise<void> {
        const share = takePendingShare(graphId);
        shareWaiting = false;
        if (!share) return;
        try {
            await addQuickNote(share.text, { createdAt: share.createdAt });
            shareLanded = true;
        } catch (err) {
            offerQuickNoteDraft(share.text);
            notify(`Could not add the shared text to Quick notes, so it is in the box for you to add later: ${(err as Error).message}`);
        }
        revealQuickNotesOnMount = true;
    }

    async function runBuild() {
        try {
            await build();
        } catch (err) {
            if (err instanceof GraphSessionCancelledError) return;
            // An open that failed because access ended says why access ended, not that it failed.
            if (accessLoss) {
                phase = "access-lost";
                return;
            }
            if (err instanceof VaultLockedError) {
                phase = "needs-unlock";
            } else {
                phase = "error";
                // The raw error is for the console; the notice says what to do next. A
                // NotFoundError from the File System Access API means the stored handle no
                // longer resolves because the folder moved, was renamed, or was deleted.
                console.warn("[workspace] could not open the graph", err);
                message =
                    (err as DOMException).name === "NotFoundError"
                        ? "Could not open the graph. Its folder could not be found on disk: it may have been moved, renamed, or deleted. Forget the graph on the Graphs page (your files are untouched) and use Open folder to pick it again."
                        : describeSyncFailure(err, "open the graph");
            }
        }
    }

    /**
     * The in-place repair for a Server graph the server lists but this device cannot see:
     * write the registry record here, then open as normal. The open's own key path takes it
     * from there: a locked vault becomes the unlock prompt, and the first sync pulls the real
     * name from the encrypted meta map into the record.
     */
    async function setUpHere() {
        const diagnosis = missing;
        if (diagnosis?.kind !== "available" || settingUp) return;
        const scope = readActiveSyncAccount();
        if (!scope) {
            missing = { kind: "unknown", reason: "no-sync-config" };
            return;
        }
        settingUp = true;
        setupError = null;
        try {
            await registerSyncedGraphOnDevice(
                { id: graphId, rootDocId: diagnosis.rootDocId },
                { registry: createIdbGraphRegistry(), scope },
            );
        } catch (err) {
            console.warn(
                "[workspace] could not register the graph on this device",
                err,
            );
            setupError = describeSyncFailure(
                err,
                "set this graph up on this device",
            );
            settingUp = false;
            return;
        }
        settingUp = false;
        missing = null;
        phase = "loading";
        await runBuild();
    }

    /**
     * Push the edits a failed save left in memory: over the reopened Local Cache on the Server
     * path, or back to the folder for the documents whose write failed on the Filesystem path.
     */
    async function retrySave() {
        if (retryingSave) return;
        const sg = serverGraph;
        if (!sg) {
            const fs = store as FilesystemDocumentStore | undefined;
            if (!fs || !("flushDocument" in fs)) return;
            retryingSave = true;
            try {
                const failed = [...fsSaveFailures];
                fsSaveFailures.clear();
                for (const concept of failed) await fs.flushDocument(concept);
                // flushDocument resolves whether or not the write succeeded; a write that failed
                // again has re-added its document through onSaveError by now.
                if (fsSaveFailures.size === 0) {
                    saveFailure = null;
                    health.clear("sync-degraded");
                }
            } finally {
                retryingSave = false;
            }
            return;
        }
        retryingSave = true;
        try {
            await sg.flushAll();
            saveFailure = null;
            health.clear("sync-degraded");
        } catch (err) {
            console.warn("[sync] retrying the save failed", err);
            saveFailure = describeSyncFailure(err, "save your latest changes");
        } finally {
            retryingSave = false;
        }
    }

    async function grantAccess() {
        phase = "loading";
        await runBuild();
    }

    /**
     * The sync session ended for good. It has already closed its socket and will not reconnect;
     * this says why, in place of the workspace. Unsent changes stay in the Local Cache: after a
     * sign-out or a refused token they sync once the person is back in, and after a lost
     * membership they are counted, offered as a download, and never sent (accepting a later
     * invite clears them; see the Graphs page).
     */
    async function accessEnded(loss: SyncAccessLoss): Promise<void> {
        if (accessLoss) return;
        let unsentDocuments = 0;
        if (loss.kind === "membership" && serverCache) {
            // One item per pending document, the root counted as "quick notes and graph
            // settings": the same list the download and the Graphs page's invite check read.
            unsentDocuments = (
                await serverCache.pendingDocIds().catch(() => [] as string[])
            ).length;
        }
        accessLoss = workspaceAccessLoss(loss, {
            managed: serverAtOpen?.managed ?? false,
            server: serverAtOpen?.server ?? null,
            unsentDocuments,
        });
        phase = "access-lost";
    }

    /** Another tab (or this tab's account menu) ended the device's Sync account. */
    function endSyncFromElsewhere(reason: AccountEndReason): void {
        if (syncConfigAtOpen === null || !serverGraph) return;
        serverGraph.endAccess({ kind: "credentials", cause: new AccountEnded(reason) });
    }

    /**
     * A standalone Disconnect in another tab clears the stored connection; replacing it with
     * another server or token ends this one too. The `storage` event is the backstop for a
     * browser without BroadcastChannel.
     */
    function watchSyncConfig(event: StorageEvent): void {
        if (event.key !== SYNC_CONFIG_STORAGE_KEY && event.key !== null) return;
        if (syncConfigAtOpen === null) return;
        if (JSON.stringify(readSyncConfig()) !== syncConfigAtOpen) endSyncFromElsewhere("disconnected");
    }

    /**
     * Download the documents whose changes will never be sent, as one Markdown file, read from
     * this device's Local Cache: the relay is no longer there to ask.
     */
    async function downloadUnsentChanges(): Promise<void> {
        const sg = serverGraph;
        const cache = serverCache;
        if (!sg || !cache || !serverRootDocId || downloadingUnsent) return;
        downloadingUnsent = true;
        unsentDownloadError = null;
        try {
            // The live engines are read over their cache rows: they can be a debounce ahead.
            const unsent = await readUnsentChanges(cache, serverRootDocId, (docId) =>
                docId === serverRootDocId ? sg.rootDoc : sg.docSync(docId).doc,
            );
            saveUnsentChangesFile(unsent, exportStem());
        } catch (err) {
            console.warn("[workspace] could not prepare the unsent changes", err);
            unsentDownloadError = `Could not prepare the download: ${(err as Error).message}. Try again.`;
        } finally {
            downloadingUnsent = false;
        }
    }

    /** Retry a failed open. The notice covers the workspace, so it needs a way forward. */
    async function retryOpen() {
        phase = "loading";
        message = "";
        await runBuild();
    }

    /** After the Recovery Code unlock dialog succeeds, retry opening the graph. */
    async function afterUnlock() {
        phase = "loading";
        await runBuild();
    }

    /**
     * Where a document sits under the graph folder (`pages/Alpha.md`), from the Filesystem
     * store's registry; null on a Server graph, or for a concept with no file yet (a [[Draft]]).
     */
    function fileLocationOf(
        concept: string,
    ): { subdir: Subdir; fileName: string } | null {
        if (isServerStore || !store || !("listDocuments" in store)) return null;
        const key = conceptKey(concept);
        const entry = store.listDocuments().find((e) => e.key === key);
        return entry ? { subdir: entry.subdir, fileName: entry.fileName } : null;
    }

    /**
     * Copy a document's full path on this device (folder-path.ts). The folder path is asked for
     * on first use and remembered; the copy then runs from the dialog's own submit, so it still
     * sits inside a user gesture, which the async clipboard API requires.
     */
    async function copyDocumentFilePath(concept: string): Promise<void> {
        const location = fileLocationOf(concept);
        if (!location || fsFolderName === undefined) return;
        const folder = readGraphFolderPath(graphId);
        if (!folder) {
            folderPathPrompt = { concept };
            return;
        }
        const path = joinGraphPath(folder, location.subdir, location.fileName);
        try {
            await writeClipboardText(path);
            notify(`Copied ${path}`);
        } catch (err) {
            notify(copyFailureMessage("file path", err, path));
        }
    }

    // ── Publishing (ADR 0082) ─────────────────────────────────────────────────────────────
    /**
     * The last outcome of each publication this session, by id. Kept here rather than in the
     * Publish tab because the tab is mounted per open of Settings, and a finished publish's
     * toast offers "Show report" after the modal has long closed.
     */
    let publishOutcomes = $state<Record<string, PublishOutcome>>({});

    /** The Publish dialog open for one document, or null. */
    let publishingDocument = $state<{
        concept: string;
        isProtected: boolean;
        current: { isPublic: boolean; publications: string[] };
    } | null>(null);

    /** Every document's materialised text, read the way the Local Mirror reads (never `open()`). */
    async function readGraphForPublishing(
        onProgress?: (done: number, total: number) => void,
    ): Promise<{ source: PublishSource; unsettled: string[] }> {
        const assets = assetStore ?? null;
        if (isServerStore) {
            const serverStore = store as ServerDocumentStore | undefined;
            if (!serverStore) throw new Error("No graph is open.");
            return readPublishSource(
                {
                    listDocuments: () => serverStore.listIdentities(),
                    readTexts: (ids, progress) => serverStore.readTexts(ids, { onProgress: progress }),
                },
                assets,
                onProgress,
            );
        }
        if (!fsAdapter) throw new Error("No graph is open.");
        const reader = await folderPublishReader(fsAdapter).read(onProgress);
        return readPublishSource(reader, assets, onProgress);
    }

    /** The publications the graph defines right now, for the per-document dialog. */
    async function loadPublications(): Promise<Publication[]> {
        const { source } = await readGraphForPublishing();
        return summarisePublishing(source).publications;
    }

    function publishEnvironment() {
        return createBrowserPublishEnvironment({
            graphTheme: async (id) => getGraphTheme(id),
        });
    }

    async function publishTo(publication: Publication, target: PublishTarget): Promise<PublishOutcome> {
        const record = target === "folder" ? await readPublicationFolder(graphId, publication.id) : undefined;
        const handle = record?.handle as FileSystemDirectoryHandle | undefined;
        if (target === "folder" && !handle) throw new Error("Choose a folder first.");
        if (handle && !(await ensurePermission(handle, "readwrite"))) {
            throw new Error("EtherPK was not allowed to write to the folder. Choose it again to grant access.");
        }
        let outcome: PublishOutcome | null = null;
        let failure: unknown = null;
        await runActivity({
            kind: "publish",
            title: `Publishing ${publication.name}`,
            failureTitle: `Publishing ${publication.name} failed`,
            cancellable: false,
            phases: [
                { label: "Reading the graph", unit: "items" },
                { label: "Rendering", unit: "items" },
                { label: target === "zip" ? "Building the zip" : "Writing the folder", unit: "items" },
            ],
            run: async (activity) => {
                try {
                    activity.beginPhase(0, 0);
                    const { source, unsettled } = await readGraphForPublishing((done, total) =>
                        activity.report({ phase: 0, done, total }),
                    );
                    activity.beginPhase(1, 0);
                    const run = await runPublish(publication, {
                        source,
                        unsettled,
                        environment: publishEnvironment(),
                        onProgress: (p) => {
                            if (p.phase === "rendering") activity.report({ phase: 1, done: p.done, total: p.total });
                        },
                    });
                    if (!run.report.ok) {
                        outcome = { report: run.report, target };
                        publishOutcomes = { ...publishOutcomes, [publication.id]: outcome };
                        return {
                            state: "partial",
                            title: `${publication.name} was not published`,
                            detail: run.report.errors.map((e) => e.message).join(" "),
                            action: showReportAction(publication.id),
                        };
                    }
                    activity.beginPhase(2, run.bundle.size);
                    if (target === "zip") {
                        const bytes = zipSite(run.bundle, run.seeded, run.agentsMd(null));
                        downloadZip(bytes, `${publication.id}-site.zip`);
                        outcome = { report: run.report, target };
                    } else {
                        const written = await writeSiteToDirectory(handle as FileSystemDirectoryHandle, run.bundle, {
                            seeded: run.seeded,
                            agentsMd: run.agentsMd,
                            onProgress: (done, total) => activity.report({ phase: 2, done, total }),
                        });
                        outcome = { report: run.report, target, written };
                        if (record) await writePublicationFolder({ ...record, publishedAt: run.report.generatedAt });
                    }
                    publishOutcomes = { ...publishOutcomes, [publication.id]: outcome };
                    writeLastPublication(graphId, publication.id);
                    const warnings = run.report.warnings.length;
                    return {
                        title: `Published ${publication.name}`,
                        detail: `${run.report.included.length} document${run.report.included.length === 1 ? "" : "s"}${
                            target === "zip" ? " in the zip" : ` in ${record?.folder ?? "the folder"}`
                        }${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"} in the report` : ""}`,
                        // The report is where the warnings are read, so the toast leads there; a
                        // clean publish still offers it, but goes by itself.
                        action: showReportAction(publication.id),
                        dismissal: warnings > 0 ? "manual" : "auto",
                    };
                } catch (error) {
                    failure = error;
                    throw error;
                }
            },
        });
        if (failure) throw failure;
        if (!outcome) throw new Error("The publish did not finish.");
        return outcome;
    }

    /** The toast's follow-on: Settings → Publish, with that publication's report open. */
    function showReportAction(publicationId: string) {
        return {
            label: "Show report",
            run: () => openGraphSettings("publish", { publishReport: publicationId }),
        };
    }

    /**
     * The Publish command: the publication last published from this device (or the graph's
     * only one) again, to its remembered folder, with no dialog in between. When it cannot tell
     * which publication or where, the Publish tab opens instead, which is where both are chosen.
     */
    async function publishAgain(): Promise<void> {
        let candidate: Publication | undefined;
        try {
            const publications = await loadPublications();
            const remembered = readLastPublication(graphId);
            candidate = publications.find((p) => p.id === remembered) ?? (publications.length === 1 ? publications[0] : undefined);
        } catch (error) {
            notify(`Could not read the graph's publications: ${(error as Error).message}`);
            return;
        }
        if (!candidate) {
            openGraphSettings("publish");
            return;
        }
        const record = await readPublicationFolder(graphId, candidate.id);
        if (!record) {
            notify(`No folder is chosen for ${candidate.name} on this device; choose one to publish from the keyboard.`);
            openGraphSettings("publish");
            return;
        }
        try {
            await publishTo(candidate, "folder");
        } catch (error) {
            // The Activity toast has already reported a failed run; this is the step before it.
            notify((error as Error).message);
        }
    }

    function publishTabProps(): PublishTabProps {
        return {
            folderSupported: "showDirectoryPicker" in window,
            load: async () => {
                const { source, unsettled } = await readGraphForPublishing();
                const summary = summarisePublishing(source);
                return { ...summary, unsettled };
            },
            folderOf: async (publicationId) => {
                const record = await readPublicationFolder(graphId, publicationId);
                return record ? { folder: record.folder, publishedAt: record.publishedAt } : null;
            },
            onchoosefolder: async (publicationId) => {
                let handle: FileSystemDirectoryHandle;
                try {
                    handle = await window.showDirectoryPicker({ mode: "readwrite" });
                } catch {
                    return null; // cancelled
                }
                await writePublicationFolder({
                    key: `${graphId}/${publicationId}`,
                    graphId,
                    publicationId,
                    handle,
                    folder: handle.name,
                });
                return { folder: handle.name };
            },
            onforgetfolder: (publicationId) => forgetPublicationFolder(graphId, publicationId),
            onpublish: publishTo,
            outcomes: publishOutcomes,
            showReport: graphSettingsDialog?.publishReport,
            onopenpage: (concept) => openViewFromSettings({ kind: "document", target: concept }),
            oncreatepublication: async (input: NewPublicationInput) => {
                if (!store) throw new Error("No graph is open.");
                const concept = await createPublicationPage(store, input);
                openViewFromSettings({ kind: "document", target: concept });
            },
            onupdatepublication: async (publication, changes) => {
                if (!store) throw new Error("No graph is open.");
                await updatePublicationPage(store, publication.concept, publication, changes);
            },
            subscribeThemes: subscribeGraphThemes,
            bundledThemes: bundledThemeList(),
            oncustomisetheme: async (publication) => {
                if (!store) throw new Error("No graph is open.");
                const existing = getGraphThemes().map((theme) => theme.id);
                const id = freeThemeId(`${publication.id}-theme`, existing);
                const theme = await copyThemeForGraph(publication.theme, id, `${publication.name} theme`, {
                    existingIds: existing,
                    fetchText: async (url) => {
                        const response = await fetch(url, { mode: "cors", credentials: "omit" });
                        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                        return response.text();
                    },
                });
                await saveGraphTheme(theme);
                await updatePublicationPage(store, publication.concept, publication, { theme: id });
                openViewFromSettings({ kind: "theme", target: id });
            },
            onopentheme: (id) => openViewFromSettings({ kind: "theme", target: id }),
            onaddtheme: async ({ ref, id, name }) => {
                const theme = await copyThemeForGraph(ref, id, name, {
                    existingIds: getGraphThemes().map((existing) => existing.id),
                    fetchText: async (url) => {
                        const response = await fetch(url, { mode: "cors", credentials: "omit" });
                        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                        return response.text();
                    },
                });
                await saveGraphTheme(theme);
            },
            ondeletetheme: (id) => removeGraphTheme(id),
            includeSlotsOf: async (themeRef) => {
                try {
                    const loaded = await createThemeLoader({
                        graphTheme: async (id) => getGraphTheme(id),
                        fetchText: async (url) => {
                            const response = await fetch(url, { mode: "cors", credentials: "omit" });
                            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                            return response.text();
                        },
                    })(themeRef);
                    return loaded.theme.manifest.includes;
                } catch {
                    return null;
                }
            },
        };
    }

    /** The Publish dialog for one document: read its current keys, then let the dialog write them. */
    async function startPublishDocument(concept: string) {
        if (!store) return;
        await store.whenReady?.(concept);
        const text = store.open(concept).getText();
        const membership = readMembership(text);
        publishingDocument = {
            concept,
            isProtected: containsCipherFence(text),
            current: { isPublic: membership.isPublic, publications: membership.publications },
        };
    }

    /**
     * Open Settings, or move an open Settings to a tab. A history write, which the effect on
     * settingsTab turns into the modal (ADR 0023, 2026-09-20): opening pushes an entry naming
     * the tab, so Back closes it and Forward brings it back; moving replaces that entry. A
     * caller that names a tab (the mirror dot, a toast, the Publish chord) lands there; the
     * plain cog and the command land on the tab this graph's Settings was last on, so a run of
     * edits to one tab does not start from General each time. Resolved here, so the address
     * never says "settings" without saying which tab; the dialog still falls back to General
     * if the tab is not offered (a Filesystem graph has no Mirror tab) and says so.
     */
    function openGraphSettings(tab?: SettingsTab, options: { publishReport?: string } = {}) {
        const target = tab ?? readSettingsTab(graphId) ?? "general";
        if (page.state.etherpkSettings) {
            // Open already: the Publish tab is mounted and read its report request once, so a
            // report asked for now is not shown (as before this change) - and must not be
            // carried to some later, unrelated open.
            pendingPublishReport = undefined;
            moveSettingsTab(target);
            return;
        }
        pendingPublishReport = options.publishReport;
        pushState(location.pathname + withSettingsTab(location.search, target), {
            ...page.state,
            etherpkSettings: { tab: target, pushed: true },
        });
    }

    /** The open Settings changes tab: the same history entry, renamed - never a second entry. */
    function moveSettingsTab(tab: SettingsTab) {
        const current = page.state.etherpkSettings;
        if (!current || current.tab === tab) return;
        replaceState(location.pathname + withSettingsTab(location.search, tab), {
            ...page.state,
            etherpkSettings: { ...current, tab },
        });
    }

    /**
     * Close Settings. The modal goes at once, so a dialog that opens next (set a passphrase,
     * pick a mirror folder) is not fought over for focus by one still unmounting; the history
     * entry goes with it - by going back when this workspace pushed it, so Forward can bring it
     * back on its tab, and in place when the address arrived by deep link or reload and nothing
     * of ours sits beneath it.
     */
    function closeGraphSettings() {
        graphSettingsDialog = null;
        // A prep still in flight must not land the modal again while the Back is on its way.
        settingsShowToken += 1;
        const current = page.state.etherpkSettings;
        if (!current) return;
        if (current.pushed) {
            history.back();
            return;
        }
        const state = { ...page.state };
        delete state.etherpkSettings;
        replaceState(location.pathname + withoutSettingsTab(location.search), state);
    }

    /**
     * Leave Settings for a View - a theme in its editor, a publication's page. The View's own
     * Visit pushes an address without the Settings param, which is what closes the modal and
     * what makes Back return to the tab that sent the user there. When the View is already the
     * active one there is no Visit to push, so the modal closes the ordinary way instead.
     */
    function openViewFromSettings(view: ViewRef) {
        const active = controller?.activeView();
        if (active && active.region === "main" && sameView(active.view, view)) {
            closeGraphSettings();
            return;
        }
        graphSettingsDialog = null;
        controller?.openView(view);
    }

    /** The modal's snapshot for the tab the entry names: the async prep, then the state the template renders. */
    async function showGraphSettings() {
        const token = ++settingsShowToken;
        // Fetch the Storage Footprint first (single counter-row read); tolerate failure.
        const storage = await fetchGraphStorage?.().catch(() => null);
        // Whether THIS device holds a passkey wrap for the current key, asked now rather than
        // trusted from graph open: that lookup ran before the record had loaded, so it could not
        // tell a wrap for the graph's key from one for a key the graph no longer uses.
        if (protection) {
            protectionPasskeyBound =
                (await boundPasskey(graphId, protection.fingerprint).catch(
                    () => null,
                )) !== null;
        }
        // Back may have closed it while the footprint was being read: a modal the entry no
        // longer names must not appear.
        const tab = settingsTab;
        if (token !== settingsShowToken || tab === null) return;
        graphSettingsDialog = {
            name: graphDisplayName,
            settings: isServerStore
                ? sanitizeGraphSettings(serverGraph?.getMeta().settings ?? {})
                : currentFsSettings,
            storage: storage ?? null,
            tab,
            publishReport: pendingPublishReport,
        };
        pendingPublishReport = undefined;
        if (tab === "mirror") void refreshExportTab();
    }

    /**
     * Save from the Graph Settings dialog. Synced: name + settings go to the encrypted
     * meta map (ADR 0031). Filesystem: settings go to etherpk/settings.json and the name
     * is the local registry display name only (the folder on disk keeps its name).
     */
    function saveGraphSettings(result: {
        name: string;
        settings: GraphSettings;
        folderPath?: string;
    }) {
        closeGraphSettings();
        // Per device, so written here rather than with the shared settings below; blank forgets it.
        if (result.folderPath !== undefined)
            writeGraphFolderPath(graphId, result.folderPath);
        if (isServerStore) {
            const sg = serverGraph;
            if (!sg) return;
            const name = result.name.trim();
            if (name && name !== sg.getMeta().name) sg.setMetaName(name);
            sg.setMetaSettings(result.settings as Record<string, unknown>);
            // onMetaChange's apply() refreshes the registry cache, display name, and active settings.
            // A deliberate save must not sit in the append debounce window — the user may navigate
            // away immediately, and the write would be lost with the socket.
            void sg.flushAll();
            return;
        }
        const adapter = fsAdapter;
        if (!adapter) return;
        void (async () => {
            try {
                await writeGraphSettings(adapter, result.settings);
                currentFsSettings = sanitizeGraphSettings(result.settings);
                setGraphAccent(graphId, currentFsSettings.toolbarColor);
                if (workspaceGeneration !== undefined) {
                    updateWorkspaceServices(workspaceGeneration, {
                        settings: currentFsSettings,
                    });
                }
                const name = result.name.trim();
                const registryStore = createIdbGraphRegistry();
                const record = await registryStore.getGraph(graphId);
                if (record) {
                    // One write refreshes both caches the record holds: the display name, and
                    // the toolbar colour the header's Graphs menu paints the row with.
                    const renamed = name && name !== record.name ? { ...record, name } : record;
                    const next = withCachedToolbarColor(renamed, currentFsSettings.toolbarColor) ?? renamed;
                    if (next !== record) await registryStore.insertGraph(next);
                    if (renamed !== record) graphDisplayName = name;
                }
            } catch (err) {
                notify(
                    `Could not save the graph settings: ${(err as Error).message}`,
                );
            }
        })();
    }

    /**
     * Enable a Local Mirror (ADR 0008): pick a directory and continuously write the graph's
     * materialized markdown and assets to it, for Data Ownership. Server-master, faithful
     * (deletes strays), so the folder is checked before anything is written: a local graph's
     * folder or another graph's mirror is refused by name, and a folder holding anything in
     * journals/, pages/, assets/ or etherpk/ gets a confirmation that counts what goes.
     */
    async function enableMirror() {
        const s = store as ServerDocumentStore | undefined;
        if (!s || !isServerStore) return;
        let checking: ReturnType<typeof setTimeout> | undefined;
        try {
            const handle = await pickGraphDirectory();
            // Reading a large folder takes a moment, and nothing else is on screen meanwhile.
            // Delayed so the common case, an empty folder, never flashes it.
            checking = setTimeout(
                () => notify(`Checking “${handle.name}” before mirroring to it…`),
                400,
            );
            const decision = await checkMirrorTakeover({
                handle,
                folder: handle.name,
                known: await readKnownGraphFolders(graphId),
                reader: readOnlyFolder(handle),
                docs: s.listIdentities(),
                heldAssetIds: async () =>
                    listMirrorAssetIds ? await listMirrorAssetIds() : null,
            });
            clearTimeout(checking);
            if (decision.kind === "start") {
                await startMirror(handle, handle.name, { announce: true });
                return;
            }
            mirrorTakeover =
                decision.kind === "confirm"
                    ? { ...decision, handle, folder: handle.name }
                    : decision;
        } catch (err) {
            clearTimeout(checking);
            // Closing the picker without choosing is a decision, not a failure to report.
            if ((err as Error).name === "AbortError") return;
            notify(`Could not enable mirroring: ${(err as Error).message}`);
        }
    }

    /**
     * Run the mirror against `handle`, and remember the folder so the next session on this device
     * picks it up by itself. A mirror that stops at the end of a session leaves a folder the user
     * believes is a current backup and is not.
     */
    async function startMirror(
        handle: FileSystemDirectoryHandle,
        folder: string,
        options: { announce?: boolean; persist?: boolean } = {},
    ) {
        const s = store as ServerDocumentStore | undefined;
        if (!s || !isServerStore) return;
        mirrorTakeover = null;
        mirrorNeedsPermission = null;
        // A Web Lock cannot be taken from its holder. If another tab has the folder, remember the
        // choice so that tab's successor - which may be this one - picks it up, and say so rather
        // than writing the same bytes alongside it.
        if (!(await claimMirrorFolder())) {
            if (options.persist !== false) {
                await writeMirrorFolder({ graphId, handle, folder }).catch(
                    () => {},
                );
            }
            notify(
                "Another tab is mirroring this graph. This tab will take over the folder when that one closes.",
            );
            return;
        }
        mirrorHandleInUse = handle;
        mirror?.dispose();
        mirror = createLocalMirror(
            createMirrorSource(mirrorSourceDeps(s)),
            createWebFsDirectoryAdapter(handle),
            { folder },
        );
        const own = mirror;
        session.own(() => {
            own.dispose();
            settleMirrorActivity(own);
        });
        mirrorStatus = own.status();
        own.onStatus((status) => {
            if (mirror !== own) return;
            mirrorStatus = status;
            reportMirrorPass(status);
        });
        own.start();
        if (options.persist !== false) {
            await writeMirrorFolder({ graphId, handle, folder }).catch(() => {
                notify(
                    "Mirroring started, but this device could not remember the folder for next time.",
                );
            });
        }
        // Said here because the Settings modal that offered it has closed, and the state now
        // lives on its Mirror tab, which nothing on screen points at.
        if (options.announce) notify(`Mirroring this graph to “${folder}”.`);
    }

    /**
     * End the Activity for a mirror that is being taken down mid-pass. The mirror clears its
     * listeners on dispose without a final status, so nothing else would ever finish the toast.
     */
    function settleMirrorActivity(own: LocalMirror): void {
        if (!mirrorActivity || mirror !== own) return;
        const finish = mirrorActivity.finish;
        mirrorActivity = undefined;
        finish({
            state: "partial",
            detail: "Stopped before the folder was checked complete.",
        });
    }

    /**
     * Report a long full pass where the user is actually looking (ADR 0035). Only a full pass over
     * a graph big enough to take noticeable time earns a toast: the first pass of a session, and
     * every resume. A toast per debounced write would be noise, and the Mirror tab already carries
     * the steady state.
     */
    function reportMirrorPass(status: MirrorStatus): void {
        const running = status.pass;
        if (
            running?.kind === "full" &&
            !mirrorActivity &&
            running.progress.total >= MIRROR_TOAST_MIN_ITEMS
        ) {
            const phases = MIRROR_ACTIVITY_PHASES.map((phase) => ({
                label: MIRROR_PHASE_LABELS[phase],
                unit: "items" as const,
            }));
            let settle: (outcome?: ActivityOutcome) => void = () => {};
            const finished = new Promise<ActivityOutcome | undefined>(
                (resolve) => (settle = resolve),
            );
            const handle = {
                report: (_: ActivityProgress) => {},
                finish: settle,
            };
            mirrorActivity = handle;
            void runActivity({
                kind: "mirror",
                title: `Mirroring to “${status.folder}”`,
                phases,
                cancellable: false,
                run: async (activity) => {
                    handle.report = (progress) => activity.report(progress);
                    return (await finished) ?? {};
                },
            });
        }
        if (!mirrorActivity) return;
        if (running) {
            const phase = MIRROR_ACTIVITY_PHASES.indexOf(
                running.progress.phase,
            );
            if (phase >= 0) {
                mirrorActivity.report({
                    phase,
                    done: running.progress.done,
                    total: running.progress.total,
                });
            }
            return;
        }
        // The pass ended. Which way it ended is the folder's state, not the toast's guess.
        const finish = mirrorActivity.finish;
        mirrorActivity = undefined;
        finish(
            status.paused
                ? {
                      state: "partial",
                      detail: status.paused.message,
                      title: `Mirroring to “${status.folder}” stopped`,
                  }
                : {
                      detail: `${status.documents} ${status.documents === 1 ? "document" : "documents"} and ${status.assets} ${status.assets === 1 ? "attachment" : "attachments"} are in the folder.`,
                      title: `Mirrored to “${status.folder}”`,
                  },
        );
    }

    /**
     * Pick up a mirror this device configured earlier, if this tab is the one that should run it.
     *
     * Permission is only queried, never asked for: a page load is not a user gesture, so an
     * ungranted folder becomes a "reconnect" state rather than an unexplained silence or an
     * unprompted browser dialog. The folder's cross-tab lock is taken first, so a second tab on
     * the same graph waits rather than writing the same bytes alongside the first.
     */
    async function resumeMirror() {
        if (!isServerStore || mirror) return;
        const remembered = await readMirrorFolder(graphId).catch(
            () => undefined,
        );
        if (!remembered?.handle) return;
        const handle = remembered.handle as FileSystemDirectoryHandle;
        if (!(await claimMirrorFolder())) return;
        if (await hasPermission(handle)) {
            await startMirror(handle, remembered.folder, { persist: false });
            return;
        }
        mirrorNeedsPermission = { handle, folder: remembered.folder };
    }

    /**
     * Take this graph's mirror lock, or queue for it. Resolves whether this tab owns the folder
     * now; a tab that does not own it takes over by itself the moment the owner goes away, which
     * closing a tab, a crash and a discard all look like to Web Locks and to nothing else.
     */
    async function claimMirrorFolder(): Promise<boolean> {
        if (releaseMirrorLock) return true;
        if (!crossTabLocksAvailable()) return true; // no locks, no coordination: behave as before
        const lockName = `${MIRROR_LOCK_PREFIX}${graphId}`;
        const release = await tryClaimLock(lockName);
        if (release) {
            releaseMirrorLock = release;
            mirrorHeldElsewhere = false;
            session.own(() => releaseMirrorFolder());
            return true;
        }
        mirrorHeldElsewhere = true;
        cancelMirrorClaim?.();
        cancelMirrorClaim = claimLockWhenFree(lockName, (takeover) => {
            releaseMirrorLock = takeover;
            mirrorHeldElsewhere = false;
            session.own(() => releaseMirrorFolder());
            void resumeMirror();
        });
        session.own(() => cancelMirrorClaim?.());
        return false;
    }

    function releaseMirrorFolder(): void {
        releaseMirrorLock?.();
        releaseMirrorLock = undefined;
        cancelMirrorClaim?.();
        cancelMirrorClaim = undefined;
    }

    /** Stop mirroring and forget the folder. Whatever is already in it is left alone. */
    /**
     * The live graph as the mirror and the export read it (ADR 0008, ADR 0092): the store's
     * cache-seeded batch read, the asset store, the server's asset list, and what travels with
     * the folder beside the documents - settings, Quick Notes, themes and the copier's own
     * protection record.
     */
    function mirrorSourceDeps(s: ServerDocumentStore): MirrorSourceDeps {
        return {
            store: s,
            assets: assetStore,
            listAssetIds: listMirrorAssetIds,
            metadata: () => ({
                name: serverGraph?.getMeta().name,
                settings: sanitizeGraphSettings(
                    serverGraph?.getMeta().settings ?? {},
                ) as Record<string, unknown>,
                quickNotes: serverGraph?.quickNotes().list() ?? [],
                spellingDictionary: serverGraph?.spellingDictionary().list() ?? [],
                themes: serverGraph?.themes().list() ?? [],
                protection: protectionRecord,
            }),
            // Quick Notes, the Graph Dictionary, themes and the protection record travel with the
            // folder too (ADR 0078, ADR 0095, ADR 0082, ADR 0093), so a change to any of them takes
            // the same full pass a settings change does.
            onMetadataChange: (listener) => {
                const offMeta =
                    serverGraph?.onMetaChange(listener) ?? (() => {});
                const offNotes =
                    serverGraph?.quickNotes().observe(listener) ?? (() => {});
                const offDictionary =
                    serverGraph?.spellingDictionary().observe(listener) ?? (() => {});
                const offThemes =
                    serverGraph?.themes().observe(listener) ?? (() => {});
                protectionRecordListeners.add(listener);
                return () => {
                    offMeta();
                    offNotes();
                    offDictionary();
                    offThemes();
                    protectionRecordListeners.delete(listener);
                };
            },
        };
    }

    /**
     * Read the protection record afresh (ADR 0093) - on open, and after it is set up or its
     * passphrase changes - and tell the mirror when it moved, so the folder's copy follows.
     */
    async function refreshProtectionRecord(): Promise<void> {
        const store = protectionRecordStore;
        if (!store) return;
        let next: ProtectionRecord | null | undefined;
        try {
            const read = await store.read();
            next =
                read.kind === "ok"
                    ? read.record
                    : read.kind === "missing"
                      ? null
                      : undefined;
        } catch {
            next = undefined;
        }
        if (store !== protectionRecordStore) return; // the graph changed under the read
        const same =
            next === protectionRecord ||
            (next != null &&
                protectionRecord != null &&
                next.fingerprint === protectionRecord.fingerprint &&
                next.wrapped === protectionRecord.wrapped);
        protectionRecord = next;
        if (!same) for (const listener of protectionRecordListeners) listener();
    }

    // ── Export (ADR 0092) ─────────────────────────────────────────────────────────────────

    /** The mirror's four phases, as the export's Activity declares them. */
    const EXPORT_ACTIVITY_PHASES = MIRROR_ACTIVITY_PHASES.map((phase) => ({
        label: MIRROR_PHASE_LABELS[phase],
        unit: "items" as const,
    }));

    /** Whether this browser offers private storage to build an archive in. */
    function scratchAvailable(): boolean {
        return (
            typeof navigator !== "undefined" &&
            typeof navigator.storage?.getDirectory === "function"
        );
    }

    /** What the Export half of the tab shows: the counts, and any scratch file left behind. */
    async function refreshExportTab(): Promise<void> {
        if (!isServerStore) return;
        exportEstimate = null;
        const s = store as ServerDocumentStore | undefined;
        const documents = s?.listIdentities().length ?? 0;
        // A graph reached with no asset storage (the dev harness) has nothing to download, and
        // exports its documents; a server that will not answer is the one case that stops it.
        if (!listExportAssets) {
            exportEstimate = { documents, assets: 0, bytes: 0 };
        } else {
            try {
                const assets = (await listExportAssets()).filter(
                    (asset) => asset.status === "complete",
                );
                exportEstimate = {
                    documents,
                    assets: assets.length,
                    bytes: assets.reduce((sum, asset) => sum + asset.size, 0),
                };
            } catch {
                exportEstimate = "offline";
            }
        }
        await refreshExportLeftover();
    }

    async function refreshExportLeftover(): Promise<void> {
        if (!scratchAvailable()) return;
        exportLeftover = await leftoverExportFor(
            graphId,
            opfsScratchStore(),
        ).catch(() => null);
    }

    /** The archive's top-level folder: the graph's name as a local graph would name its folder. */
    function exportStem(): string {
        return (
            portableFileStem(
                serverGraph?.getMeta().name || graphDisplayName || "",
            ) || "EtherPK Graph"
        );
    }

    /**
     * Export the graph as one zip (ADR 0092): the mirror pass streamed into the save picker's
     * file where there is one, or into a scratch file that is then downloaded. The archive is
     * finished but not handed over until the report says nothing is missing; otherwise the tab
     * offers Keep or Discard (decision 6).
     */
    async function startExport(): Promise<void> {
        const s = store as ServerDocumentStore | undefined;
        if (!s || !isServerStore || exportRunning) return;
        if (pendingExport) {
            notify(
                "Keep or discard the last export first, under Settings > Mirror and Export.",
            );
            return;
        }
        if (isRunning("export")) {
            notify("An export is already running in this tab.");
            return;
        }
        const release = await tryClaimLock(exportLockName(graphId));
        if (!release) {
            notify(
                "Another tab of this browser is exporting this graph. Wait for it to finish.",
            );
            return;
        }
        const stem = exportStem();
        const fileName = `${stem} ${todayISO()}.zip`;
        let sink: DeliverableSink;
        if (saveFilePickerAvailable()) {
            // Close Settings first, as the mirror's folder pick does: the save picker is a native
            // dialog, and two dialogs fight over focus and Escape.
            closeGraphSettings();
            let handle: FileSystemFileHandle;
            try {
                handle = await pickExportFile(fileName);
            } catch (err) {
                release();
                // Closing the picker without choosing is a decision, not a failure to report.
                if ((err as Error).name === "AbortError") return;
                notify(`Could not choose where to export: ${(err as Error).message}`);
                return;
            }
            sink = createSaveFileSink(() => handle.createWritable());
        } else {
            if (!scratchAvailable()) {
                release();
                notify(
                    "This browser has nowhere to build the archive: neither a save picker nor private storage.",
                );
                return;
            }
            try {
                const scratch = opfsScratchStore();
                await sweepExportScratch({ store: scratch }).catch(() => []);
                await scratch.remove(scratchFileName(graphId)).catch(() => {});
                // The archive lives in the origin's storage until it is downloaded, so it has to
                // fit there; the estimate is the attachments, which are nearly all of it.
                const needed =
                    exportEstimate && exportEstimate !== "offline"
                        ? exportEstimate.bytes
                        : 0;
                const device = await describeDeviceStorage();
                const spare =
                    device.quota !== null && device.usage !== null
                        ? device.quota - device.usage
                        : null;
                if (spare !== null && spare < needed) {
                    release();
                    notify(
                        `This graph's attachments come to about ${formatBytes(needed)}, and this browser has about ${formatBytes(Math.max(0, spare))} of storage to build the archive in. Export it from a desktop browser instead.`,
                    );
                    return;
                }
            } catch (err) {
                release();
                notify(`Could not start the export: ${(err as Error).message}`);
                return;
            }
            sink = createScratchFileSink({ name: scratchFileName(graphId) });
        }
        exportRunning = true;
        const graphName = serverGraph?.getMeta().name || graphDisplayName || "this graph";
        try {
            await runActivity({
                kind: "export",
                title: `Exporting “${graphName}”`,
                failureTitle: `Export of “${graphName}” did not finish`,
                phases: EXPORT_ACTIVITY_PHASES,
                cancellable: true,
                run: async (activity) => {
                    const run = runGraphExport({
                        source: createMirrorSource(mirrorSourceDeps(s)),
                        sink,
                        rootName: stem,
                        onProgress: (status) => {
                            const progress = status.pass?.progress;
                            if (!progress) return;
                            activity.report({
                                phase: MIRROR_ACTIVITY_PHASES.indexOf(progress.phase),
                                done: progress.done,
                                total: progress.total,
                            });
                        },
                    });
                    activity.signal.addEventListener("abort", () => run.cancel(), {
                        once: true,
                    });
                    let report: ExportReport;
                    try {
                        report = await run.done; // a failure or a cancel has already discarded the sink
                    } catch (err) {
                        release();
                        throw err;
                    } finally {
                        exportRunning = false;
                    }
                    const summary = `${report.documents} ${report.documents === 1 ? "document" : "documents"} and ${report.assets} ${report.assets === 1 ? "attachment" : "attachments"}, ${formatBytes(report.bytes)}.`;
                    if (report.complete) {
                        try {
                            await sink.handOver(fileName);
                        } finally {
                            release();
                            void refreshExportLeftover();
                        }
                        return { title: `Exported “${graphName}”`, detail: summary };
                    }
                    pendingExport = {
                        report,
                        sink,
                        fileName: `${stem} ${todayISO()} (incomplete).zip`,
                        release,
                    };
                    const left = report.skipped.length + report.missingAssets.length;
                    return {
                        state: "partial",
                        title: `Export of “${graphName}” is incomplete`,
                        detail: `${left} ${left === 1 ? "item was" : "items were"} left out. Keep or discard it under Settings > Mirror and Export.`,
                        action: {
                            label: "Review",
                            run: () => openGraphSettings("mirror"),
                        },
                        dismissal: "manual",
                    };
                },
            });
        } catch (err) {
            // Only a conflict lands here; the run's own failures are the toast's to report.
            exportRunning = false;
            release();
            await sink.discard().catch(() => {});
            notify(`Could not start the export: ${(err as Error).message}`);
        }
    }

    async function keepPendingExport(): Promise<void> {
        const pending = pendingExport;
        if (!pending) return;
        pendingExport = null;
        try {
            await pending.sink.handOver(pending.fileName);
        } catch (err) {
            notify(`Could not hand the export over: ${(err as Error).message}`);
        } finally {
            pending.release();
            void refreshExportLeftover();
        }
    }

    async function discardPendingExport(): Promise<void> {
        const pending = pendingExport;
        if (!pending) return;
        pendingExport = null;
        try {
            await pending.sink.discard();
        } finally {
            pending.release();
            void refreshExportLeftover();
        }
    }

    async function removeExportLeftover(): Promise<void> {
        if (!scratchAvailable()) return;
        await opfsScratchStore()
            .remove(scratchFileName(graphId))
            .catch((err: Error) => notify(`Could not remove the file: ${err.message}`));
        await refreshExportLeftover();
    }

    async function stopMirror() {
        const own = mirror;
        own?.stop();
        own?.dispose();
        if (own) settleMirrorActivity(own);
        mirror = undefined;
        mirrorStatus = null;
        mirrorNeedsPermission = null;
        mirrorHandleInUse = undefined;
        releaseMirrorFolder();
        await forgetMirrorFolder(graphId).catch(() => {});
        notify("Stopped mirroring. The folder and contents remain in place.");
    }

    /**
     * What the Mirror tab shows for a folder this device remembers but cannot write to yet. The
     * mirror itself does not exist in that state, so there is nothing for it to report - and
     * saying nothing would leave the tab offering to set up a mirror that is already set up.
     */
    function rememberedMirrorStatus(): MirrorStatus | null {
        if (!mirrorNeedsPermission) return null;
        return {
            folder: mirrorNeedsPermission.folder,
            running: false,
            syncing: false,
            paused: {
                kind: "permission",
                message:
                    "EtherPK needs your permission again before it can write to this folder.",
            },
            documents: 0,
            assets: 0,
            skipped: [],
            collisions: [],
            missingAssets: [],
            danglingLinks: [],
            changesElsewhereUnchecked: false,
        };
    }

    /**
     * The orphan tools, with the mirror told afterwards. Deleting an asset changes no document
     * and no registry entry, so nothing else would ever mention it - and the folder would keep
     * the copy until something unrelated happened to trigger a full pass.
     */
    function mirrorAwareAssetTools(): GraphAssetTools | null {
        const tools = assetTools;
        if (!tools) return null;
        return {
            ...tools,
            async remove(ids) {
                const removed = await tools.remove(ids);
                if (removed > 0) void mirror?.sync();
                return removed;
            },
        };
    }

    /**
     * What the toolbar dot shows. Derived rather than stored: every input already exists, and a
     * second copy of "is the mirror all right" is a second thing to get wrong.
     */
    function mirrorIndicator(): MirrorIndicator {
        const status = mirrorStatus ?? rememberedMirrorStatus();
        if (mirrorHeldElsewhere && !status) {
            return {
                state: "waiting",
                title: "Another tab of this browser is mirroring this graph to its folder.",
                onclick: () => openGraphSettings("mirror"),
            };
        }
        if (!status) return { state: "hidden" };
        if (status.paused) {
            return {
                state: "paused",
                title: `Mirroring to “${status.folder}” has stopped. ${status.paused.message}`,
                onclick: () => openGraphSettings("mirror"),
            };
        }
        if (status.syncing) {
            const phase = status.pass?.progress;
            const detail =
                phase && phase.total > 0
                    ? ` ${MIRROR_PHASE_LABELS[phase.phase]}: ${phase.done} of ${phase.total}.`
                    : "";
            return {
                state: "writing",
                title: `Writing to “${status.folder}”.${detail}`,
                onclick: () => openGraphSettings("mirror"),
            };
        }
        const waiting = status.skipped.length + status.missingAssets.length;
        return {
            state: "current",
            title: waiting
                ? `Mirroring to “${status.folder}”. ${waiting} ${waiting === 1 ? "item is" : "items are"} still to be written.`
                : status.changesElsewhereUnchecked
                  ? `Mirroring to “${status.folder}”. Could not check the server for edits made on other devices, so some may not be in the folder yet.`
                  : `“${status.folder}” matches this graph.`,
            onclick: () => openGraphSettings("mirror"),
        };
    }

    /**
     * Clear a pause. A missing folder needs a new one; anything else needs the permission this
     * click is the gesture for, and then another attempt.
     */
    async function reconnectMirror() {
        closeGraphSettings();
        const pending = mirrorNeedsPermission;
        if (mirrorStatus?.paused?.kind === "folder") {
            void enableMirror();
            return;
        }
        const handle = pending?.handle ?? mirrorHandleInUse;
        if (!handle) {
            void enableMirror();
            return;
        }
        if (!(await ensurePermission(handle))) {
            notify("EtherPK still has no permission to write to that folder.");
            return;
        }
        if (pending) {
            await startMirror(handle, pending.folder, { persist: false });
            return;
        }
        mirror?.resume();
    }

    async function resolve(choice: "keep-mine" | "take-disk") {
        if (!store || !conflict) return;
        await store.resolveConflict(conflict.target, choice);
        conflict = null;
    }

    async function disposeWorkspaceResources() {
        window.removeEventListener("pagehide", flushPersistence);
        stopWatch?.();
        flushPersistence();
        clearPendingRestores();
        navEngine = undefined;
        detachReconcile?.();
        detachDocsBridge?.();
        detachDocRemoved?.();
        detachDocRenamed?.();
        detachActiveForProtection?.();
        detachActiveForBacklinks?.();
        identityIndex = null;
        detachKeybindings?.();
        detachEditorCommands?.();
        detachLinkCommands?.();
        detachRenderers?.();
        releasePreloadedDocument?.();
        releasePreloadedDocument = undefined;
        preloadedDocumentReady = undefined;
        renderer?.destroy?.();
        renderer = undefined;
        controller = undefined;
        mobileRenderer = undefined;
        detachMeta?.();
        if (metaSeedTimer) clearTimeout(metaSeedTimer);
        setActiveDocument(null);
        if (workspaceGeneration !== undefined) {
            clearWorkspaceServices(workspaceGeneration);
            workspaceGeneration = undefined;
        }
        assetTools = null;
        fetchGraphStorage = null;
        fsAdapter = undefined;
        fsFolderName = undefined;
        folderPathPrompt = null;
        // Nothing said about this graph may outlive it on the Graphs page or in the next one.
        for (const id of [STATUS_NOTICE, SAVE_FAILURE_NOTICE, INDEX_NOTICE, STORAGE_RECOVERY_NOTICE]) dismissNotice(id);
        clearGraphAccent(graphId);
        resetFavourites();
        resetQuickNotes();
        setGraphDictionary([], null);
        resetGraphThemes();
        recents = null;
        taskFilter = undefined;
        backlinksPreferences = undefined;
        detachDocumentCommands?.();
        detachDocumentCommands = undefined;
        detachQuickNotesCommands?.();
        detachQuickNotesCommands = undefined;
        detachSpellingCommands?.();
        detachSpellingCommands = undefined;
        detachProtectionCommands?.();
        detachProtectionCommands = undefined;
        // Order matters: the session locks (committing pending plaintext) before the store drops
        // its projections, so a graph switch never strands unwritten protected work.
        setActiveProtectionStatus(null);
        protection?.dispose();
        protection = undefined;
        protectedStore?.dispose();
        protectedStore = undefined;
        settingProtectionPassphrase = null;
        unlockingProtection = null;
        protectionPasskeyBound = false;
        detachAssetCommands?.();
        detachAssetCommands = undefined;
        detachTabCommands?.();
        detachTabCommands = undefined;
        detachAssetViewers?.();
        detachAssetViewers = undefined;
        // A dialog still waiting on an answer would leave its Command pending forever.
        deletingAsset?.decide("cancel");
    }

    onMount(() => {
        session = createGraphSession(graphId);
        if (dev) {
            (
                window as unknown as {
                    __etherpkWorkspaceLifecycle?: {
                        graphId: string;
                        disposed(): boolean;
                        publishedGraph(): string | null;
                    };
                }
            ).__etherpkWorkspaceLifecycle = {
                graphId,
                disposed: () => session.isDisposed(),
                publishedGraph: () =>
                    currentWorkspaceServices()?.graphId ?? null,
            };
        }
        window.addEventListener("pagehide", flushPersistence);
        session.own(disposeWorkspaceResources);
        // Spell Check (ADR 0095). One service for the tab, opened on this graph while the device
        // preference is on (closed, it neither downloads nor holds a dictionary); it hears the
        // Graph Dictionary's words, reports downloads on the activity rail, and tries a failed
        // download again when the connection returns.
        const spell = getBrowserSpellService();
        setActiveSpellService(spell);
        const followPreference = (enabled: boolean) => (enabled ? spell.open(graphId) : spell.close());
        followPreference(isSpellCheckEnabled());
        const stopSpellPreference = subscribeSpellCheck(followPreference);
        const stopSpellWords = subscribeGraphDictionary((words) => spell.setWords(words));
        const stopSpellNotices = bindSpellingNotices(spell);
        const retrySpelling = () => spell.retry();
        window.addEventListener("online", retrySpelling);
        session.own(() => {
            window.removeEventListener("online", retrySpelling);
            stopSpellPreference();
            stopSpellWords();
            stopSpellNotices();
            spell.close();
            setActiveSpellService(null);
        });
        const stopRecoveries = subscribeStorageRecoveries((all) => (storageRecovery = all));
        // Sign-out and Disconnect in any tab of this Client end this graph's sync too.
        const stopAccountSignals = onAccountSignal((signal) => {
            if (signal.type === "ended") endSyncFromElsewhere(signal.reason);
        });
        window.addEventListener("storage", watchSyncConfig);
        session.own(() => {
            stopAccountSignals();
            window.removeEventListener("storage", watchSyncConfig);
        });
        // The sync chip reads the browser's online flag; a refused write is tried again when the
        // connection returns and when the person comes back to the tab, which is when a plan
        // restarted in another tab usually shows.
        browserOnline = navigator.onLine;
        const followOnline = () => {
            browserOnline = navigator.onLine;
            refreshSyncIndicator();
            if (browserOnline) serverGraph?.retryRefused();
        };
        const retryWhenVisible = () => {
            if (document.visibilityState === "visible") serverGraph?.retryRefused();
        };
        window.addEventListener("online", followOnline);
        window.addEventListener("offline", followOnline);
        document.addEventListener("visibilitychange", retryWhenVisible);
        session.own(() => {
            window.removeEventListener("online", followOnline);
            window.removeEventListener("offline", followOnline);
            document.removeEventListener("visibilitychange", retryWhenVisible);
            syncIndicatorSettle?.dispose();
            syncIndicatorSettle = null;
        });
        (async () => {
            await tick();
            await runBuild();
        })();
        return () => {
            stopRecoveries();
            void session.dispose();
        };
    });
</script>

<svelte:head><title>EtherPK — graph</title></svelte:head>

<WorkspaceOpenState
    {phase}
    {loadingStep}
    {indexed}
    {message}
    {missing}
    {settingUp}
    {setupError}
    {shareWaiting}
    {shareLanded}
    accessLost={accessLostNotice}
    downloading={downloadingUnsent}
    downloadError={unsentDownloadError}
    ondownload={() => void downloadUnsentChanges()}
    ongrant={() => void grantAccess()}
    onback={() => void goto("/graphs")}
    onretry={() => void retryOpen()}
    onsetup={() => void setUpHere()}
/>

{#if phase === "needs-unlock"}
    <UnlockDialog onunlocked={afterUnlock} onclose={() => goto("/graphs")} />
{/if}

{#if pendingRecoveryCode}
    <RecoveryCodeDialog
        code={pendingRecoveryCode}
        arrival="first"
        onconfirm={() => (pendingRecoveryCode = null)}
    />
{/if}

<!-- The Context Menu is hosted once here so a right-click anywhere in the workspace — including
     dockview's tab DOM, which we do not render — can raise it without owning a popup. -->
<ContextMenu />

<!-- Said once per device, never on a timer: this is a fixed property of the browser, and
     there is nothing the user can do about it (ADR 0041 §4). -->

{#if searchController}
    <SearchModal controller={searchController} />
{/if}

{#if settingProtectionPassphrase}
    <SetProtectionPassphraseDialog
        concept={settingProtectionPassphrase.concept ?? undefined}
        onset={async (passphrase) => {
            const pending = settingProtectionPassphrase;
            await protection?.enable(passphrase);
            void refreshProtectionRecord();
            settingProtectionPassphrase = null;
            // Enabling leaves the graph unlocked, so the action that triggered this can run
            // straight away rather than making the user pick the menu item a second time.
            pending?.then?.();
        }}
        onclose={() => (settingProtectionPassphrase = null)}
    />
{/if}

{#if protectingDraft}
    <ConfirmDialog
        open={true}
        title="Nothing to protect yet"
        message={`“${protectingDraft}” isn’t a document yet. A page is created the moment you type something into it, and protection encrypts what the page holds - so until then there is nothing to protect. Add the content you want kept private, then choose Protect… again.`}
        confirmLabel="OK"
        hideCancel={true}
        onconfirm={() => (protectingDraft = null)}
        oncancel={() => (protectingDraft = null)}
    />
{/if}

{#if protectingPublic}
    <ConfirmDialog
        open={true}
        title="Withdraw from publishing and protect?"
        message={protectingPublicMessage(protectingPublic)}
        confirmLabel="Withdraw and protect"
        destructive={true}
        onconfirm={() => {
            const pending = protectingPublic;
            protectingPublic = null;
            if (!pending || !store) return;
            void setDocumentPublishing(store, pending.concept, { public: null, publications: null })
                .then(() => startProtect(pending.concept, { withdrawn: true }))
                .catch((error: unknown) => notify(`Could not withdraw ${pending.concept}: ${error instanceof Error ? error.message : String(error)}`));
        }}
        oncancel={() => (protectingPublic = null)}
    />
{/if}

{#if unlockingProtection}
    <UnlockProtectionDialog
        hasPasskey={unlockingProtection.hasPasskey}
        onpassphrase={async (passphrase) => {
            const pending = unlockingProtection;
            await protection?.unlock(passphrase);
            unlockingProtection = null;
            pending?.then?.();
        }}
        onpasskey={async () => {
            const pending = unlockingProtection;
            const key = await unlockWithPasskey(
                graphId,
                protection?.fingerprint ?? null,
            );
            protection?.unlockWithKey(key);
            unlockingProtection = null;
            pending?.then?.();
        }}
        onclose={() => (unlockingProtection = null)}
    />
{/if}

{#if renaming}
    <RenameDocumentDialog
        concept={renaming.concept}
        plan={renaming.plan}
        pageless={renaming.pageless}
        busy={renaming.busy}
        error={renaming.error}
        initialName={renaming.initialName}
        source={renaming.source}
        onpreview={(candidate) => {
            const current = renaming;
            if (current) void refreshRenamePlan(current.concept, candidate);
        }}
        onconfirm={(next, strategy) => void confirmRename(next, strategy)}
        oncancel={cancelRename}
    />
{/if}

{#if deleting}
    <ConfirmDialog
        open={true}
        title="Delete this document?"
        message={deleteDocumentMessage(deleting.concept, deleting.references)}
        confirmLabel="Delete"
        destructive={true}
        onconfirm={() => void confirmDelete()}
        oncancel={() => (deleting = null)}
    />
{/if}

{#if deletingIncluded}
    <ConfirmDialog
        open={true}
        title="Used as an include"
        message={deleteRefusedAsIncludeMessage(deletingIncluded.concept, deletingIncluded.publications)}
        confirmLabel="OK"
        hideCancel={true}
        onconfirm={() => (deletingIncluded = null)}
        oncancel={() => (deletingIncluded = null)}
    />
{/if}

{#if deletingAsset}
    <DeleteAssetDialog
        prompt={deletingAsset.prompt}
        onchoose={(choice) => deletingAsset?.decide(choice)}
        onopendocument={(concept) => {
            deletingAsset?.decide("cancel");
            void openConcept(concept);
        }}
    />
{/if}

{#if shortcutsDialogOpen}
    <KeyboardShortcutsDialog onclose={() => (shortcutsDialogOpen = false)} />
{/if}

{#if resetDialogOpen}
    <ConfirmDialog
        open={true}
        title="Reset workspace?"
        message="Closes every tab and restores the sidebars and their views as a new graph opens with."
        confirmLabel="Reset"
        onconfirm={() => void resetWorkspace()}
        oncancel={() => (resetDialogOpen = false)}
    />
{/if}

{#if folderPathPrompt && fsFolderName !== undefined}
    <GraphFolderPathDialog
        folderName={fsFolderName}
        onsave={(path) => {
            const { concept } = folderPathPrompt!;
            folderPathPrompt = null;
            writeGraphFolderPath(graphId, path);
            void copyDocumentFilePath(concept);
        }}
        onclose={() => (folderPathPrompt = null)}
    />
{/if}

{#if graphSettingsDialog}
    <GraphSettingsDialog
        {graphId}
        name={graphSettingsDialog.name}
        settings={graphSettingsDialog.settings}
        storageInfo={graphSettingsDialog.storage}
        {indexPersisted}
        {indexPersistenceBlocked}
        indexProgress={indexed}
        onrebuildindex={rebuildIndex}
        assetTools={mirrorAwareAssetTools()}
        tab={graphSettingsDialog.tab}
        nameHelp={isServerStore
            ? "Changes the graph name for all members."
            : "Changes the display name only; the folder on disk keeps its name."}
        folderPath={!isServerStore && fsFolderName !== undefined
            ? {
                  path: readGraphFolderPath(graphId) ?? "",
                  folderName: fsFolderName,
              }
            : null}
        mirror={isServerStore
            ? {
                  status: mirrorStatus ?? rememberedMirrorStatus(),
                  heldElsewhere: mirrorHeldElsewhere,
                  supported: "showDirectoryPicker" in window,
                  onenable: () => {
                      // Close Settings first, as protection setup does: the folder picker is a
                      // native dialog, and a non-empty folder asks for confirmation in a modal of
                      // its own - two stacked modals fight over focus and Escape.
                      closeGraphSettings();
                      void enableMirror();
                  },
                  onsync: () => void mirror?.sync(),
                  onstop: () => {
                      closeGraphSettings();
                      void stopMirror();
                  },
                  onresume: () => void reconnectMirror(),
                  exportGraph: {
                      estimate: exportEstimate,
                      running: exportRunning,
                      pending: pendingExport
                          ? {
                                skipped: pendingExport.report.skipped,
                                missingAssets: pendingExport.report.missingAssets,
                                onkeep: () => void keepPendingExport(),
                                ondiscard: () => void discardPendingExport(),
                            }
                          : null,
                      leftover: exportLeftover
                          ? {
                                size: exportLeftover.size,
                                onremove: () => void removeExportLeftover(),
                            }
                          : null,
                      savePicker: saveFilePickerAvailable(),
                      onexport: () => void startExport(),
                  },
              }
            : null}
        agents={agentsTabProps()}
        publish={publishTabProps()}
        spelling={{
            service: getBrowserSpellService(),
            dictionaryHost: dictionaryHostLabel(dictionaryBaseUrl()),
        }}
        protection={protection
            ? {
                  isConfigured: protection.isConfigured,
                  isUnlocked: protection.isUnlocked,
                  lockSettings: readLockSettings(),
                  canBindPasskey: passkeysAvailable(),
                  hasPasskey: protectionPasskeyBound,
                  onsettings: (next) => writeLockSettings(next),
                  onsetup: () => {
                      // Close Settings first: the set-passphrase dialog is a modal of its own, and
                      // two stacked modals fight over focus and Escape.
                      closeGraphSettings();
                      settingProtectionPassphrase = {
                          concept: null,
                          then: null,
                      };
                  },
                  onbindpasskey: bindProtectionPasskey,
                  onchangepassphrase: async (current, next) => {
                      await protection?.changePassphrase(current, next);
                      void refreshProtectionRecord();
                  },
              }
            : null}
        onchangetab={(tab) => {
            writeSettingsTab(graphId, tab);
            moveSettingsTab(tab);
            if (tab === "mirror") void refreshExportTab();
        }}
        onsave={saveGraphSettings}
        onclose={closeGraphSettings}
    />
{/if}

{#if publishingDocument}
    <PublishDocumentDialog
        concept={publishingDocument.concept}
        isProtected={publishingDocument.isProtected}
        current={publishingDocument.current}
        loadPublications={loadPublications}
        onsave={async (next) => {
            if (!store || !publishingDocument) return;
            await setDocumentPublishing(store, publishingDocument.concept, {
                public: next.isPublic ? true : null,
                publications: next.publications,
            });
        }}
        onopensettings={() => {
            publishingDocument = null;
            openGraphSettings("publish");
        }}
        onclose={() => (publishingDocument = null)}
    />
{/if}

{#if mirrorTakeover?.kind === "confirm"}
    {@const takeover = mirrorTakeover}
    <ConfirmDialog
        open={true}
        title={takeover.title}
        message={takeover.message}
        confirmLabel={takeover.confirmLabel}
        destructive={takeover.destructive}
        onconfirm={() =>
            void startMirror(takeover.handle, takeover.folder, {
                announce: true,
            })}
        oncancel={() => (mirrorTakeover = null)}
    />
{:else if mirrorTakeover?.kind === "refuse"}
    <!-- A folder that already belongs to a local graph or another graph's mirror is never taken
         over: confirming would delete that graph's files. The way forward is another folder. -->
    <ConfirmDialog
        open={true}
        title={mirrorTakeover.title}
        message={mirrorTakeover.message}
        confirmLabel="Choose another folder"
        onconfirm={() => {
            mirrorTakeover = null;
            void enableMirror();
        }}
        oncancel={() => (mirrorTakeover = null)}
    />
{/if}

<!-- The phone's sync chip, in the top bar the mobile presenter draws. -->
{#snippet syncStatus()}
    <SyncStateChip compact indicator={syncIndicator} actions={syncChipActions} />
{/snippet}

<!-- The presenter is chosen by viewport. Desktop: a toolbar + the dockview host
     (which must exist whenever ready & desktop). Mobile: the self-contained
     MobilePresenter, which carries its own chrome (drawer toggles + tab strip),
     so the desktop toolbar is not rendered. -->
<div class="workspace" class:hidden={phase !== "ready"} style={toolbarStyle}>
    {#if !useMobile}
        <WorkspaceToolbar
            ontoggleleft={() => toggleSidebar("left")}
            ontoggleright={() => toggleSidebar("right")}
            onshortcuts={() =>
                void commandRegistry?.execute("help.openShortcuts")}
            onsettings={() => openGraphSettings()}
            ontasks={() => void commandRegistry?.execute("tasks.open")}
            onreset={() => void commandRegistry?.execute("workspace.reset")}
            mirror={mirrorIndicator()}
            sync={syncActivity ? { indicator: syncIndicator, actions: syncChipActions } : null}
        />
        <div
            bind:this={container}
            data-testid="workspace-layout"
            class="layout"
        ></div>
    {:else}
        <div class="layout" data-testid="workspace-mobile">
            {#if controller && mobileRenderer}
                <MobilePresenter
                    {controller}
                    renderer={mobileRenderer}
                    markFor={tabMarkFor}
                    status={syncActivity ? syncStatus : undefined}
                />
            {/if}
        </div>
    {/if}
</div>

{#if conflict}
    <div class="conflict-backdrop" data-testid="graph-conflict">
        <div class="conflict">
            <h2>External change</h2>
            <p>
                "{conflict.target}" changed on disk while you have unsaved
                edits. Keep your version, or take the version from disk?
            </p>
            <div class="actions">
                <button
                    data-testid="conflict-keep-mine"
                    onclick={() => resolve("keep-mine")}
                >
                    Keep mine
                </button>
                <button
                    data-testid="conflict-take-disk"
                    onclick={() => resolve("take-disk")}
                >
                    Take disk
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .workspace {
        position: fixed;
        /* The route layout sets the top: the app header, plus the Demo Graph bar when there is one. */
        inset: var(--workspace-top, 3.5rem) 0 0 0;
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-1);
    }
    .workspace.hidden {
        display: none;
    }
    .layout {
        position: relative;
        /* `clip`, NOT `hidden` — the shell is a viewport, never a scroller, and this is where
           that rule is written down (compass-theme.css and MobilePresenter's `.content` follow
           it for the boxes inside).

           An `overflow: hidden` box is still a scroll container: the user cannot scroll it, but
           anything that scrolls a descendant into view can. CodeMirror scrolls a caret into
           view by walking up from its own scroller, moving every box that has overflow to
           scroll and stopping only at the first fixed or sticky ancestor — which here is
           `.workspace`, and is why the page itself never moved. So ONE overhanging child
           anywhere in the dockview shell (a stale panel position, an open popover) was enough
           for landing the caret on a [[Task]] or [[Search]] result to drag the whole workspace
           up: tab strips and both sidebars scrolled off the top, and the shell's own background
           left as a gap at the bottom of the viewport.

           `clip` clips exactly as `hidden` did while leaving the box with no scrolling area to
           move, so the shell cannot be displaced by any path — a landing, a keystroke, or the
           browser revealing a focused element. It is also `visible`, not `hidden`, wherever it
           is unsupported, so a browser without it spills rather than silently clips.
           See tests-client/workspace-shell-clip.test.ts. */
        overflow: clip;
        flex: 1;
        min-height: 0;
    }
    .conflict button {
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        background: var(--gk-surface-1);
        color: inherit;
        cursor: pointer;
        font: inherit;
    }
    .conflict-backdrop {
        position: fixed;
        inset: 0;
        display: grid;
        place-content: center;
        background: rgba(0, 0, 0, 0.4);
        z-index: 50;
    }
    .conflict {
        max-width: 28rem;
        padding: 1rem 1.25rem;
        border-radius: 8px;
        background: var(--gk-surface-0, #fff);
        color: var(--gk-text-default);
    }
    .conflict h2 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
    }
    .conflict .actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 1rem;
    }
</style>
