/**
 * The API an EtherPK extension is written against.
 *
 * An extension is an npm package whose package.json carries an `etherpk` manifest and whose main
 * module exports `activate(context)`. The Client starts it as each graph opens, with an
 * {@link ExtensionContext} for that graph. This package holds the types of that context, of the
 * manifest and of the contract a View follows, and {@link readExtensionPackage}, which checks a
 * manifest the way the Client does. It holds none of the Client's implementation.
 *
 * Every declaration is Proposed (`@beta`) until extensions from other publishers can be installed:
 * until then it may change in any release. Stable declarations (`@public`) will never break.
 *
 * @packageDocumentation
 */

export type {
    CommandHandler,
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
    ExtensionSettings,
    ExtensionStorage,
    ExtensionTheme,
    ExtensionViews,
    IconMarkup,
    Keybinding,
} from './context'
export type { ExtensionEventName, ExtensionEventPayloads, ExtensionEvents } from './events'
export type { ConceptCandidate, ConceptKind, ExtensionIndex, IndexUpdate, LinkGraph, LinkGraphConcept, LinkGraphLink } from './graph-index'
export type {
    ExtensionManifest,
    ExtensionPackage,
    ReadExtensionPackageResult,
    SettingDeclaration,
    ViewDeclaration,
    ViewRegion,
} from './manifest'
export { readExtensionPackage } from './manifest'
export type {
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
export type { MountedView, ViewContribution, ViewMountProps, ViewRef, ViewVisibility } from './views'
