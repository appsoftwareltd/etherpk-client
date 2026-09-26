/**
 * Public entry point for the storage subsystem — the Filesystem Backend and the
 * graph registry. Application code (routes, the workspace) imports from here, not
 * from the `fs/` internals.
 */

// The File-System seam + adapters.
export type { BinaryContent, DirectoryAdapter, DirEntry, FileContent, Subdir } from './fs/directory-adapter'
export { SUBDIRS } from './fs/directory-adapter'
export { createMemoryDirectoryAdapter } from './fs/memory-adapter'
export {
    AGENTS_MD_BEGIN,
    AGENTS_MD_END,
    AGENTS_MD_FILE,
    CLAUDE_MD_FILE,
    buildAgentsMdSection,
    buildClaudeMdSection,
    ensureAgentInstructions,
    ensureAgentsMd,
    ensureClaudeMd,
    mergeAgentsMdSection,
} from './fs/agents-md'
export type { EnsureAgentsMdOutcome } from './fs/agents-md'
export {
    createWebFsDirectoryAdapter,
    getOpfsRoot,
    isFsaSupported,
    isOnDisk,
    pickGraphDirectory,
} from './fs/web-fs-adapter'

// Identity + scan (pure).
export type { DocumentEntry } from './fs/scan'
export { scanGraph } from './fs/scan'
export {
    type DocumentKind,
    aliasesOf,
    conceptKey,
    conceptOf,
    documentKindOf,
    fileStem,
    journalConceptOf,
} from './fs/identity'

// The store.
export {
    type DocumentConflict,
    type FilesystemDocumentStore,
    type FilesystemDocumentStoreOptions,
    type IndexDocSnapshot,
    createFilesystemDocumentStore,
} from './fs/filesystem-store'

// Graph Settings (per-graph config persisted in etherpk/).
export {
    type GraphSettings,
    readGraphSettings,
    sanitizeGraphSettings,
    writeGraphSettings,
} from './fs/graph-settings'
export { QUICK_NOTES_FILE, quickNotesFileText, readQuickNotes, writeQuickNotes } from './fs/quick-notes-file'

// The Asset store (binary uploads under assets/).
export {
    type AssetStore,
    type SavedAsset,
    assetFileName,
    assetNameFromRef,
    buildAssetMarkdown,
    createAssetStore,
    isImageExt,
    splitNameExt,
} from './fs/asset-store'

// The graph registry.
export {
    type GraphBackend,
    type GraphRecord,
    type GraphRegistry,
    type ServerGraphScope,
    type GraphStoragePort,
    createGraphRegistry,
    newGraphId,
    withCachedToolbarColor,
} from './graph-registry'
export {
    createIdbGraphRegistry,
    createIdbGraphStoragePort,
    ensurePermission,
    hasPermission,
} from './graph-registry-idb'
export {
    forgetMirrorFolder,
    listMirrorFolders,
    readMirrorFolder,
    writeMirrorFolder,
    type MirrorFolderRecord,
} from './mirror-folder-idb'
export {
    PLACEHOLDER_SYNCED_GRAPH_NAME,
    type RegisterSyncedGraphDeps,
    registerSyncedGraphOnDevice,
} from './register-synced-graph'

// Eviction protection for everything above that lives in browser storage, and what survives
// when the browser drops it anyway.
export {
    type DeviceStorageReport,
    type StoragePersistence,
    describeDeviceStorage,
    ensurePersistentStorage,
} from './storage-persistence'
export {
    type AppInstallState,
    appInstallState,
    promptInstall,
    subscribeAppInstall,
    watchAppInstall,
} from './app-install'
export {
    type RecoveredStateKind,
    type StorageRecovery,
    STORAGE_RECOVERY_FOOTNOTE,
    STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH,
    STORAGE_RECOVERY_HEADLINE,
    STORAGE_RECOVERY_INTRO,
    acknowledgeStorageRecoveries,
    reportStorageRecovery,
    storageRecoveries,
    storageRecoveryItems,
    subscribeStorageRecoveries,
} from './storage-recovery'

// Device-local "resume here" pointer + the pure root (`/`) resolver decision.
export { clearLastGraphId, getLastGraphId, setLastGraphId } from './last-graph'
export { type GraphTarget, resolveGraphTarget } from './graph-routing'

// External-change reconciliation glue (focus + poll).
export { type ReconciliationOptions, attachReconciliation } from './fs/reconciliation-dom'
