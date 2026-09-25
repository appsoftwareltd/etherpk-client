export type { DocumentRef, DocumentStore, EditorDocument, TextChange } from './types'
export { createInMemoryDocumentStore, type InMemoryDocumentStore } from './in-memory-store'
export { setActiveDocumentStore, getActiveDocumentStore } from './active-store'
export {
    setActiveAssetStore,
    getActiveAssetStore,
    tryGetActiveAssetStore,
} from './active-asset-store'
export { setActiveGraphSettings, getActiveGraphSettings } from './active-graph-settings'
export {
    parseDisplaySize,
    normalizeDisplaySize,
    parseImageDisplaySizeHint,
} from './view/augmentations/image-display-size'
export { parseBlocks, type Block, type BlockKind } from './block-model'
export { default as DocumentView } from './view/DocumentView.svelte'
export { default as BacklinksView } from './view/BacklinksView.svelte'
/**
 * `GraphSidebarView`, `AllDocumentsView` and `RenameDocumentDialog` are deliberately NOT
 * exported here — import them from their own paths.
 *
 * They import *from* this barrel (the active-store and active-settings accessors), so
 * exporting them *from* it closes a cycle. That is not a theoretical tidiness point: it
 * silently broke the editor's content clamp, which read a facet out of `cm-document`
 * during module init and got a half-initialised module instead — a code block's blank
 * line picked up a 16px margin where its neighbours had 12, notching the panel. Caught
 * only by a visual geometry e2e.
 */
export { setActiveDocument, getActiveDocument } from './active-document'
export { setActiveEditorView, getActiveEditorView, clearActiveEditorView } from './active-editor'
export { editorContext, refreshEditorContext } from './editor-context.svelte'
export {
    initEditorFont,
    getEditorFontSize,
    setEditorFontSize,
    zoomEditorFont,
    clampFontSize,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
} from './editor-font'
export { registerEditorCommands } from './commands/editor-commands'
export { registerLinkCommands } from './commands/link-commands'
export { clearAugmentationRenderCaches, registerAugmentationRenderers } from './view/augmentations/renderers/register'
export {
    type BacklinkGroup,
    type BacklinkIndex,
    type DbBacklinkGroup,
    type DbBacklinkRef,
    type GraphIndex,
    type IndexDoc,
    type IndexSource,
    backlinkCount,
    backlinksFor,
    conceptExists,
    createGraphIndex,
    createIndexResolver,
    getActiveGraphIndex,
    openInMemorySqlDb,
    setActiveGraphIndex,
} from './backlinks'

// The worker-hosted, OPFS-persisted index (ADR 0041). Exported directly rather than through
// `./backlinks`, which is about the query surface; this is where the index physically lives.
export type { IndexPersistenceStatus, IndexTransport, RemoteGraphIndex } from './index-worker/client'
export { IndexTransportOpenError, createRemoteGraphIndex } from './index-worker/client'
export { createIndexTransport, inlineTransport, memoryDbHost } from './index-worker/transport'
export { createSharedIndexTransport } from './index-worker/share'
export {
    INDEX_NOT_PERSISTED_MESSAGE,
    INDEX_POOL_HELD_MESSAGE,
    acknowledgeIndexNotice,
    indexNoticeAcknowledged,
} from './index-worker/not-persisted-notice'
