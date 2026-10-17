/**
 * The API an EtherPK extension is written against.
 *
 * An extension is an npm package whose package.json carries an `etherpk` manifest and whose main
 * module exports `activate(context)`. The Client starts it as each graph opens, with an
 * {@link ExtensionContext} for that graph. This package holds the types of that context, of the
 * manifest and of the contract a View follows, and {@link readExtensionPackage}, which checks a
 * manifest the way the Client does. It holds none of the Client's implementation.
 *
 * A declaration, or a member of one, is Stable (`@public`) or Proposed (`@beta`). A Stable one never
 * breaks: it is deprecated and kept. A Proposed one may change in any release, and only the
 * extensions that come with EtherPK may use it. Since 0.14.0 everything is Stable but
 * `contributions`, the Client's own registries. An extension from the Extension Directory uses the
 * Stable part alone, which `etc/etherpk-extension-api.public.api.md` lists.
 *
 * @packageDocumentation
 */

export type {
    CommandHandler,
    ExtensionCommandBar,
    ExtensionCommandMenu,
    ExtensionCommands,
    ExtensionConcepts,
    ExtensionContext,
    ExtensionContextMenu,
    ExtensionContributions,
    ExtensionGraphSidebar,
    ExtensionIcons,
    ExtensionKeybindings,
    ExtensionLayout,
    ExtensionModule,
    ExtensionPersonStorage,
    ExtensionSettings,
    ExtensionStorage,
    ExtensionTheme,
    ExtensionViews,
    IconMarkup,
    Keybinding,
} from './context'
export type { ExtensionAssets } from './assets'
export type { AuthorizeOptions, ExtensionAuth } from './auth'
export type { ExtensionDialogs, PromptOptions } from './dialogs'
export type { DocumentBacklink, DocumentSearchResult, DocumentSummary, DocumentTask, DocumentText, ExtensionDocuments } from './documents'
export type {
    ExtensionEditor,
    FenceContext,
    FenceEdit,
    FenceInfo,
    FenceOptions,
    FencePresentation,
    FenceWidget,
    InlinePanel,
    InlinePanelOptions,
    MountedFence,
    PublishedFence,
    PublishFenceRequest,
    QuoteFenceRequest,
} from './editor'
export type { ExtensionEmbeds, FrameOptions } from './embeds'
export type { ExtensionEventName, ExtensionEventPayloads, ExtensionEvents } from './events'
export type { ConceptCandidate, ConceptKind, ExtensionIndex, IndexUpdate, LinkGraph, LinkGraphConcept, LinkGraphLink } from './graph-index'
export type { ExtensionJournalPanels, JournalPanel, JournalPanelProps, MountedJournalPanel } from './journal'
export type {
    ExtensionIsolation,
    ExtensionManifest,
    ExtensionPackage,
    ReadExtensionPackageResult,
    SettingDeclaration,
    ViewDeclaration,
    ViewRegion,
} from './manifest'
export { readExtensionPackage } from './manifest'
export { CLIENT_COMMANDS } from './client-commands'
export type {
    CommandBarButton,
    CommandMenuContext,
    CommandMenuItem,
    ContextMenuItem,
    DocumentMenuTarget,
    ExtensionMenuTarget,
    GraphSidebarButton,
    MenuTarget,
    TabMenuTarget,
    WikilinkMenuTarget,
} from './menus'
export type { ExtensionGraphRecords } from './records'
export type { MountedSettingsSection, SettingsSection, SettingsSectionContext, SettingsSectionTab } from './settings-sections'
export type { MountedView, ViewContribution, ViewMountProps, ViewRef, ViewVisibility } from './views'
