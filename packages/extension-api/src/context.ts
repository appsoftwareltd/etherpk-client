/**
 * The context an extension is started with: one open graph, as far as an extension may reach it.
 *
 * Everything an extension adds through it sits under the extension's id and is removed when the
 * graph closes or the extension is switched off, so an extension never has to undo its own
 * registrations. It holds no document store, no keys and no sync: an extension reads documents
 * only through the index's answers, and changes them only by running the Client's Commands.
 */
import type { ExtensionEvents } from './events'
import type { ExtensionIndex } from './graph-index'
import type { CommandMenuItem, ContextMenuItem, GraphSidebarButton } from './menus'
import type { ViewContribution, ViewRef } from './views'

/**
 * A Command's handler. What it returns, or resolves to, is what `execute` resolves to.
 *
 * @beta
 */
export type CommandHandler = (arg?: unknown) => unknown

/**
 * Running and adding Commands.
 *
 * @beta
 */
export interface ExtensionCommands {
    /** Add a Command, its id under the extension's id. Throws if the id is taken or outside it. */
    register(id: string, handler: CommandHandler): () => void
    /** Run any Command, the Client's or an extension's. Rejects if no Command has the id. */
    execute(id: string, arg?: unknown): Promise<unknown>
    /** Whether any Command has the id. */
    has(id: string): boolean
}

/**
 * Supplying the Views the manifest declares.
 *
 * @beta
 */
export interface ExtensionViews {
    /**
     * Supply the View for a kind the manifest declares, so its tabs draw. Throws for a kind the
     * manifest does not declare.
     */
    register(kind: string, view: ViewContribution): () => void
}

/**
 * Adding Context Menu rows.
 *
 * @beta
 */
export interface ExtensionContextMenu {
    /** Add a row, its id under the extension's id. */
    register(item: ContextMenuItem): () => void
}

/**
 * Adding Command Menu rows.
 *
 * @beta
 */
export interface ExtensionCommandMenu {
    /** Add a row, its id under the extension's id. */
    register(item: CommandMenuItem): () => void
}

/**
 * Adding buttons to the Graph Sidebar, under Today's journal.
 *
 * @beta
 */
export interface ExtensionGraphSidebar {
    /** Add a button, its id under the extension's id. */
    register(button: GraphSidebarButton): () => void
}

/**
 * A key chord that runs a Command.
 *
 * @beta
 */
export interface Keybinding {
    /** `Alt+M`, `Mod+Shift+K`: `Mod` is Cmd on Apple devices and Ctrl elsewhere. */
    key: string
    /** The Command it runs. */
    command: string
    /** What the keyboard shortcuts card lists it as. */
    label: string
    /** The card's heading it is listed under. */
    group?: string
}

/**
 * Adding key chords.
 *
 * @beta
 */
export interface ExtensionKeybindings {
    /** Add a chord. Throws if the Client or another extension already binds it. */
    register(binding: Keybinding): () => void
}

/**
 * Opening Views and documents in the open graph's Layout.
 *
 * @beta
 */
export interface ExtensionLayout {
    /**
     * Open a View. With `inPaneOf`, a panel id, it opens as a tab in that panel's Pane. With
     * `beside`, it opens in another Pane beside that panel, so both show at once. Otherwise it
     * opens where its kind belongs, or comes to the front if it is open already.
     */
    openView(view: ViewRef, options?: { inPaneOf?: string; beside?: string }): void
    /** Bring a Sidebar resident to the front of its expanded Sidebar. */
    reveal(kind: string): void
    /**
     * Open the document of a concept, under the name it resolves to, as following a wikilink
     * does. `line` scrolls to and selects that line, `inPaneOf` and `beside` place it as for
     * {@link ExtensionLayout.openView}.
     */
    openDocument(concept: string, options?: { line?: number; inPaneOf?: string; beside?: string }): void
    /** The document the user is working in, or null. */
    activeDocument(): string | null
    /** True while the desktop presenter is showing, 1024 pixels wide and more. */
    isDesktop(): boolean
}

/**
 * The rules for naming a concept, which every index answer follows.
 *
 * @beta
 */
export interface ExtensionConcepts {
    /** The case-insensitive key of a name. */
    key(name: string): string
    /** The name a concept resolves to: an alias's page, a page's own title, or the name itself. */
    canonicalName(name: string): string
}

/**
 * The extension's own storage on this device, under `etherpk-<extension id>:` in the browser's
 * localStorage. Values are stored as JSON.
 *
 * @beta
 */
export interface ExtensionStorage {
    /** The value stored under `key`, or undefined when there is none or it cannot be read. */
    get<T>(key: string): T | undefined
    /** Store a value. A browser that refuses storage (a private window) keeps nothing, silently. */
    set(key: string, value: unknown): void
    /** Forget the value under `key`. */
    remove(key: string): void
}

/**
 * The person's answers to the settings the extension's manifest declares (`settings`, ADR 0134).
 * The Client draws them under the extension's entry in Settings and Extensions → Extensions, and
 * keeps them with the person: on this device, and in their account where it syncs a graph, so they
 * follow the person to their other devices. The extension only reads them.
 *
 * @beta
 */
export interface ExtensionSettings {
    /** A setting's value, by its id in the manifest, or undefined when the person has not set it. */
    get(id: string): string | undefined
    /**
     * Hear every change to the person's settings, made on this device or arriving from another.
     * Returns the way to stop.
     */
    subscribe(listener: () => void): () => void
}

/**
 * The Client's light or dark theme.
 *
 * @beta
 */
export interface ExtensionTheme {
    /** True while the dark theme shows. The `theme:changed` Event reports a switch. */
    isDark(): boolean
}

/**
 * SVG markup the Client made, for an HTML sink such as Svelte's `{@html}`. It is not a string, so a
 * string cannot stand in for it. The Client enforces Trusted Types, and this is trusted markup there:
 * it goes into the page as it is. A string built from it is a plain string again, which the
 * Client's default policy sanitizes.
 *
 * @beta
 */
export interface IconMarkup {
    /** Never present at run time. It marks the type, so a plain string is not one. */
    readonly __brand: 'IconMarkup'
}

/**
 * Drawing the Client's icons and the extension's own.
 *
 * @beta
 */
export interface ExtensionIcons {
    /**
     * An icon as SVG markup: the extension's own, by the name its manifest gives it, or one of the
     * Client's. An unknown name draws a small dot. The Client sanitizes an extension's own icon
     * before it draws it, so its markup can hold only SVG.
     */
    svg(name: string, options?: { size?: number; strokeWidth?: number; label?: string }): IconMarkup
}

/**
 * One registry of every Contribution Point, by kind, for the kinds the typed parts of the context
 * do not cover. Only a Built-in Extension uses it.
 *
 * @beta
 */
export interface ExtensionContributions {
    /** Add a contribution. Throws if the kind already holds the id. */
    register(kind: string, id: string, value: unknown): () => void
    /** Remove one of the extension's own contributions. */
    unregister(kind: string, id: string): void
    /** The contribution at (`kind`, `id`), anyone's, or undefined. */
    get(kind: string, id: string): unknown
    /** Whether anyone has a contribution at (`kind`, `id`). */
    has(kind: string, id: string): boolean
    /** Every contribution of a kind, the extension's and everyone else's, in the order added. */
    list(kind: string): { id: string; value: unknown }[]
}

/**
 * What an extension is started with, once for each graph that opens.
 *
 * @beta
 */
export interface ExtensionContext {
    /** The extension's id, from its manifest. */
    readonly extensionId: string
    /** The open graph. */
    readonly graphId: string
    /** The Client's version, `x.y.z`. */
    readonly clientVersion: string
    /** True in a development build of the Client, where tests may reach in. */
    readonly dev: boolean
    /** Supplying the Views the manifest declares. */
    readonly views: ExtensionViews
    /** Running and adding Commands. */
    readonly commands: ExtensionCommands
    /** Adding Context Menu rows. */
    readonly contextMenu: ExtensionContextMenu
    /** Adding Command Menu rows. */
    readonly commandMenu: ExtensionCommandMenu
    /** Adding buttons to the Graph Sidebar. */
    readonly graphSidebar: ExtensionGraphSidebar
    /** Adding key chords. */
    readonly keybindings: ExtensionKeybindings
    /** Every Contribution Point by kind, for the kinds the parts above do not cover. */
    readonly contributions: ExtensionContributions
    /** Listening to Events. */
    readonly events: ExtensionEvents
    /** Questions to the open graph's index. */
    readonly index: ExtensionIndex
    /** Opening Views and documents. */
    readonly layout: ExtensionLayout
    /** The rules for naming a concept. */
    readonly concepts: ExtensionConcepts
    /** The extension's own storage on this device. */
    readonly storage: ExtensionStorage
    /** The person's answers to the settings the manifest declares. */
    readonly settings: ExtensionSettings
    /** The Client's light or dark theme. */
    readonly theme: ExtensionTheme
    /** The Client's icons and the extension's own. */
    readonly icons: ExtensionIcons
    /** Say something in passing, as the Client's own notices do: "Coordinates copied." */
    notify(text: string): void
}

/**
 * What an extension's main module exports.
 *
 * @beta
 */
export interface ExtensionModule {
    /**
     * Called as each graph opens, or when the extension is switched on with a graph open. What the
     * extension registered through the context is removed by the Client. A returned function is
     * called after that, for anything else the extension holds.
     */
    activate(context: ExtensionContext): void | (() => void)
}
