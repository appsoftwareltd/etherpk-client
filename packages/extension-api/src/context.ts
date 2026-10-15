/**
 * The context an extension is started with: one open graph, as far as an extension may reach it.
 *
 * Everything an extension adds through it sits under the extension's id and is removed when the
 * graph closes or the extension is switched off, so an extension never has to undo its own
 * registrations. It holds no document store, no keys and no sync: an extension reads documents
 * only through the index's answers and its own fences, and changes them only through its fences,
 * the blocks it puts at the caret and the Client's Commands.
 */
import type { ExtensionAssets } from './assets'
import type { ExtensionAuth } from './auth'
import type { ExtensionDialogs } from './dialogs'
import type { ExtensionDocuments } from './documents'
import type { ExtensionEditor } from './editor'
import type { ExtensionEmbeds } from './embeds'
import type { ExtensionEvents } from './events'
import type { ExtensionIndex } from './graph-index'
import type { ExtensionJournalPanels } from './journal'
import type { CommandBarButton, CommandMenuItem, ContextMenuItem, GraphSidebarButton } from './menus'
import type { ExtensionGraphRecords } from './records'
import type { SettingsSection } from './settings-sections'
import type { ViewContribution, ViewRef } from './views'

/**
 * A Command's handler. What it returns, or resolves to, is what `execute` resolves to.
 *
 * @public
 */
export type CommandHandler = (arg?: unknown) => unknown

/**
 * Running and adding Commands.
 *
 * @public
 */
export interface ExtensionCommands {
    /** Add a Command, its id under the extension's id. Throws if the id is taken or outside it. */
    register(id: string, handler: CommandHandler): () => void
    /**
     * Run any Command, the Client's or an extension's. Rejects if no Command has the id.
     *
     * @beta
     */
    execute(id: string, arg?: unknown): Promise<unknown>
    /**
     * Whether any Command has the id.
     *
     * @beta
     */
    has(id: string): boolean
}

/**
 * Supplying the Views the manifest declares.
 *
 * @public
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
 * @public
 */
export interface ExtensionCommandMenu {
    /** Add a row, its id under the extension's id. */
    register(item: CommandMenuItem): () => void
}

/**
 * Adding buttons to the Command Bar, the row of buttons across the bottom of a phone's screen:
 * after the editing buttons that scroll, or in the pinned group at its right end.
 *
 * @beta
 */
export interface ExtensionCommandBar {
    /** Add a button, its id under the extension's id. */
    register(button: CommandBarButton): () => void
}

/**
 * Adding buttons to the Graph Sidebar's group of action buttons, after Search and today's date.
 *
 * @public
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
 * @public
 */
export interface ExtensionLayout {
    /**
     * Open a View. With `inPaneOf`, a panel id, it opens as a tab in that panel's Pane. With
     * `beside`, it opens in another Pane beside that panel, so both show at once. Otherwise it
     * opens where its kind belongs, or comes to the front if it is open already.
     */
    openView(view: ViewRef, options?: { inPaneOf?: string; beside?: string }): void
    /**
     * Bring a Sidebar resident to the front of its expanded Sidebar.
     *
     * @beta
     */
    reveal(kind: string): void
    /**
     * Open the document of a concept, under the name it resolves to, as following a wikilink
     * does. `line` scrolls to and selects that line, `inPaneOf` and `beside` place it as for
     * {@link ExtensionLayout.openView}. A day's name, `YYYY-MM-DD`, opens its Journal Entry, or a Draft
     * of it when nothing is written for that day yet.
     */
    openDocument(concept: string, options?: { line?: number; inPaneOf?: string; beside?: string }): void
    /**
     * The document the user is working in, or null.
     *
     * @beta
     */
    activeDocument(): string | null
    /** True while the desktop presenter is showing, 1024 pixels wide and more. */
    isDesktop(): boolean
    /**
     * Draw something over the whole EtherPK window, with a heading and a close button the Client
     * draws, as a fence's widget opens over the window. One at a time: opening another closes the
     * one before. The close button, Escape and `close` all close it, and `onClose` is told once.
     *
     * @beta
     */
    openWindow(options: {
        /** The heading the Client draws beside the close button. */
        title: string
        /** Draw into `host`, which fills the window under the heading. */
        mount(host: HTMLElement, window: { close(): void }): { destroy(): void }
        onClose?(): void
    }): { close(): void }
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
 * @public
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
 * follow the person to their other devices. The extension reads them, and may set them where it
 * explains them itself, such as a setup screen asking for a key.
 *
 * @public
 */
export interface ExtensionSettings {
    /**
     * A setting's value, by its id in the manifest, or undefined when the person has not set it. A
     * `boolean` setting is always `'true'` or `'false'`: its manifest's `default` until the person
     * changes it.
     */
    get(id: string): string | undefined
    /**
     * Hear every change to the person's settings, made on this device or arriving from another.
     * Returns the way to stop.
     */
    subscribe(listener: () => void): () => void
    /**
     * Set one of the settings the manifest declares, as the person would in Settings and Extensions,
     * or clear it with null or empty text. A `boolean` setting takes `'true'` or `'false'`. Throws
     * for a setting the manifest does not declare. Call it only for what the person typed or chose:
     * the setting is theirs.
     */
    set(id: string, value: string | null): void
}

/**
 * The extension's own records, kept with the person (ADR 0140): on this device, and where the
 * person's account syncs a graph, in that account's Settings Vault too, encrypted on the device so
 * only the person's own devices can read them. So a record follows the person to their other devices, as
 * Extension Settings do, such as what signing in to another service gave the extension. The person
 * never sees these records, and uninstalling the extension clears them on every device.
 *
 * Each record is kept as JSON, at most 64 KB of it. Between two devices the later change to a
 * record wins, record by record. A record is readable on the device by any code in the page, as
 * localStorage is. A Headless Client signed in to the same account cannot read it: the Sync Server
 * never gives an agent token the Settings Vault (ADR 0148).
 *
 * @public
 */
export interface ExtensionPersonStorage {
    /** The record under `key`, or undefined when there is none or it cannot be read. */
    get<T>(key: string): T | undefined
    /**
     * Keep a record under `key`: letters, digits, `.`, `_` and `-`, at most 100 of them. Setting
     * undefined or null removes it. Throws when the key is not one of those, or the record's JSON is
     * longer than 64 KB.
     */
    set(key: string, value: unknown): void
    /** Remove the record under `key`. */
    remove(key: string): void
    /**
     * Hear every change to the extension's records, made on this device or arriving from another.
     * Returns the way to stop.
     */
    subscribe(listener: () => void): () => void
}

/**
 * The Client's light or dark theme.
 *
 * @public
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
 * @public
 */
export interface ExtensionContext {
    /**
     * The extension's id, from its manifest.
     *
     * @beta
     */
    readonly extensionId: string
    /**
     * The open graph.
     *
     * @beta
     */
    readonly graphId: string
    /**
     * The Client's version, `x.y.z`.
     *
     * @beta
     */
    readonly clientVersion: string
    /**
     * True in a development build of the Client, where tests may reach in.
     *
     * @beta
     */
    readonly dev: boolean
    /** Supplying the Views the manifest declares. */
    readonly views: ExtensionViews
    /** Running and adding Commands. */
    readonly commands: ExtensionCommands
    /**
     * Adding Context Menu rows.
     *
     * @beta
     */
    readonly contextMenu: ExtensionContextMenu
    /** Adding Command Menu rows. */
    readonly commandMenu: ExtensionCommandMenu
    /** Adding buttons to the Graph Sidebar. */
    readonly graphSidebar: ExtensionGraphSidebar
    /**
     * Adding buttons to the phone's Command Bar.
     *
     * @beta
     */
    readonly commandBar: ExtensionCommandBar
    /** Adding panels beneath each Journal Entry. */
    readonly journalPanels: ExtensionJournalPanels
    /**
     * Adding key chords.
     *
     * @beta
     */
    readonly keybindings: ExtensionKeybindings
    /**
     * Every Contribution Point by kind, for the kinds the parts above do not cover.
     *
     * @beta
     */
    readonly contributions: ExtensionContributions
    /** Listening to Events. */
    readonly events: ExtensionEvents
    /**
     * Questions to the open graph's index.
     *
     * @beta
     */
    readonly index: ExtensionIndex
    /**
     * Reading the open graph's documents, with every Protected Document left out, name and all.
     *
     * @beta
     */
    readonly documents: ExtensionDocuments
    /**
     * The extension's records for the open graph, kept on this device only.
     *
     * @beta
     */
    readonly records: ExtensionGraphRecords
    /**
     * Images kept as the open graph's assets.
     *
     * @beta
     */
    readonly assets: ExtensionAssets
    /** Opening Views and documents. */
    readonly layout: ExtensionLayout
    /**
     * The rules for naming a concept.
     *
     * @beta
     */
    readonly concepts: ExtensionConcepts
    /** The extension's own storage on this device. */
    readonly storage: ExtensionStorage
    /** The person's answers to the settings the manifest declares. */
    readonly settings: ExtensionSettings
    /** The extension's own records, kept with the person and following them to their devices. */
    readonly personStorage: ExtensionPersonStorage
    /** Signing in to another service. */
    readonly auth: ExtensionAuth
    /** The Client's light or dark theme. */
    readonly theme: ExtensionTheme
    /**
     * The Client's icons and the extension's own.
     *
     * @beta
     */
    readonly icons: ExtensionIcons
    /** Widgets over the extension's own fences, and blocks put at the caret. */
    readonly editor: ExtensionEditor
    /** Dialogs the Client draws. */
    readonly dialogs: ExtensionDialogs
    /** Frames showing content from the hosts the Client allows. */
    readonly embeds: ExtensionEmbeds
    /** Say something in passing, as the Client's own notices do: "Coordinates copied." */
    notify(text: string): void
}

/**
 * What an extension's main module exports.
 *
 * @public
 */
export interface ExtensionModule {
    /**
     * Called as each graph opens, or when the extension is switched on with a graph open. What the
     * extension registered through the context is removed by the Client. A returned function is
     * called after that, for anything else the extension holds.
     */
    activate(context: ExtensionContext): void | (() => void)
    /**
     * Sections the extension adds to the Client's settings tabs, which the Client mounts while the
     * extension is switched on, whether or not a graph is open.
     *
     * @beta
     */
    settingsSections?: readonly SettingsSection[]
}
