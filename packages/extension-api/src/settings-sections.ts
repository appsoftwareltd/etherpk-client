/**
 * An extension's own section in the Client's settings (ADR 0134, amended 2026-10-15 and
 * 2026-10-17), for settings that belong to the person and need more than the fields a manifest
 * can declare, such as a list of accounts with a button that connects one. The main module exports
 * them as `settingsSections`.
 *
 * The Client draws an extension's sections in a graph's Settings and Extensions while the extension
 * runs there. An extension that comes with EtherPK is loaded with the Client, so its sections are
 * drawn on the Graphs page too, with no graph open. Any other extension's code is loaded only once
 * a graph opens, so its sections are not drawn on the Graphs page.
 */
import type { ExtensionAuth } from './auth'
import type { ExtensionPersonStorage, ExtensionSettings, ExtensionTheme } from './context'

/**
 * Where an extension's settings section is drawn: `extension`, under the extension's own entry in
 * the Extensions area, beside the settings its manifest declares; or `agents`, in the Agents tab.
 *
 * @public
 */
export type SettingsSectionTab = 'extension' | 'agents'

/**
 * What a settings section is mounted with: what belongs to the person, and nothing from a graph,
 * since there may be no graph open.
 *
 * @public
 */
export interface SettingsSectionContext {
    /** The extension's id, from its manifest. */
    readonly extensionId: string
    /** The person's answers to the settings the manifest declares. */
    readonly settings: ExtensionSettings
    /** The extension's records kept with the person. */
    readonly personStorage: ExtensionPersonStorage
    /** Signing in to another service. */
    readonly auth: ExtensionAuth
    /** The Client's light or dark theme. */
    readonly theme: ExtensionTheme
    /** Say something in passing, as the Client's own notices do. */
    notify(text: string): void
}

/**
 * A section the section's host element shows, as the Client drives it.
 *
 * @public
 */
export interface MountedSettingsSection {
    /** The tab closed, or the extension was switched off. */
    destroy(): void
}

/**
 * One settings section an extension adds.
 *
 * @public
 */
export interface SettingsSection {
    /** Unique within the extension. */
    id: string
    /** The tab it goes in. */
    tab: SettingsSectionTab
    /** Draw the section into `element`, which is empty and is the extension's alone. */
    mount(element: HTMLElement, context: SettingsSectionContext): MountedSettingsSection
}
