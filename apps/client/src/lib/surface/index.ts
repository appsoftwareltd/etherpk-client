/**
 * The extension **surface** barrel. Phase 1: the Event bus, the Command registry +
 * app-level keybindings, and the generic kind-parameterised **Contribution registry**
 * (generalised from `ViewRegistry`, earned by its second kind — the Command Menu's
 * menu-item; see docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md).
 * This module is a leaf — it knows nothing of layout, documents, or graphs; the
 * composition root wires it.
 */

export type { EventBus, EventName, EventPayloads } from './types'
export { createEventBus } from './event-bus'
export { setActiveEventBus, getActiveEventBus, tryGetActiveEventBus } from './active-bus'
export {
    type CommandRegistry,
    type CommandHandler,
    createCommandRegistry,
    isRegisterableCommandId,
} from './command-registry'
export {
    setActiveCommandRegistry,
    getActiveCommandRegistry,
    tryGetActiveCommandRegistry,
} from './active-commands'
export {
    type ContributionRegistry,
    type ContributionEntry,
    createContributionRegistry,
    isRegisterableContributionId,
} from './contribution-registry'
export {
    setActiveContributionRegistry,
    getActiveContributionRegistry,
    tryGetActiveContributionRegistry,
} from './active-contributions'
export {
    type CommandMenuItem,
    type CommandMenuContext,
    COMMAND_MENU_KIND,
    registerCommandMenuItem,
    listCommandMenuItems,
} from './command-menu'
export {
    type CommandBarItem,
    COMMAND_BAR_KIND,
    registerCommandBarItem,
    listCommandBarItems,
} from './command-bar'
export {
    type AssetViewer,
    type AssetViewerProps,
    ASSET_VIEWER_KIND,
    assetExtension,
    assetViewerFor,
    canViewAsset,
    registerAssetViewer,
} from './asset-viewer'
export {
    type AssetContextMenuTarget,
    type ContextMenuItem,
    type ContextMenuTarget,
    type DocumentContextMenuTarget,
    type EditableAssetTarget,
    type TabContextMenuTarget,
    type WikilinkContextMenuTarget,
    type MisspellingContextMenuTarget,
    CONTEXT_MENU_KIND,
    isAssetTarget,
    isDocumentTarget,
    isEditableAssetTarget,
    isWikilinkTarget,
    isMisspellingTarget,
    tabPanelIdOf,
    registerContextMenuItem,
    listContextMenuItems,
} from './context-menu'
export {
    type ContextMenuState,
    attachContextMenu,
    closeContextMenu,
    getContextMenuState,
    openContextMenu,
    subscribeContextMenu,
} from './context-menu-store'
export {
    type Keybinding,
    type KeyEventLike,
    attachKeybindings,
    eventMatches,
    formatChord,
    isApplePlatform,
    parseChord,
    suppressBrowserChords,
} from './keybindings'
