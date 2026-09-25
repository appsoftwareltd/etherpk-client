/**
 * Public entry point for the pane / Layout system.
 *
 * Application code (editor commands, wikilink navigation, event handlers)
 * imports the {@link LayoutController} and the value types from here — never the
 * dockview adapter or the model internals directly.
 */

export type {
    LayoutController,
    LayoutModel,
    LayoutRenderer,
    OpenMode,
    OpenViewOptions,
    PaneHandle,
    PaneModel,
    Region,
    RegionModel,
    RenderedPane,
    SerializedLayout,
    SidebarSide,
    ViewInstance,
    ViewPlacement,
    ViewRef,
    ViewRegistry,
    ViewRegistryEntry,
} from './types'
export {
    KEY_SEPARATOR,
    KIND_NAMESPACE_SEPARATOR,
    isRegisterableViewKind,
    namespacedViewKind,
    parseViewKey,
    sameView,
    viewKey,
} from './view-ref'
export { createLayoutController, type LayoutControllerOptions } from './controller'
export { createViewRegistry } from './registry'
export {
    LAYOUT_VERSION,
    type DefaultLayoutOptions,
    defaultLayout,
    parseSerializedLayout,
} from './serialization'
export { REGIONS, SIDEBAR_REGIONS, createEmptyModel } from './model'
export { LOCAL_LAYOUT_KEY_PREFIX, createLocalLayoutStore } from './store'
export type { LayoutStore } from './types'
export { setActiveLayoutController, getActiveLayoutController } from './active-controller'
export {
    DESKTOP_MEDIA_QUERY,
    LAYOUT_BREAKPOINT_PX,
    prefersMobileLayout,
    watchMobileLayout,
} from './breakpoint'
