/**
 * An extension's own section in one of the Client's settings tabs (ADR 0134, amended 2026-10-15),
 * which the Client mounts with or without a graph open: on the Graphs page, and in a graph's
 * settings. For settings that belong to the person and need more than the fields a manifest can
 * declare, such as a list of accounts with a button that connects one.
 */
import type { ExtensionAuth } from './auth'
import type { ExtensionPersonStorage, ExtensionSettings, ExtensionTheme } from './context'

/**
 * The tabs an extension's settings section can go in.
 *
 * @beta
 */
export type SettingsSectionTab = 'agents'

/**
 * What a settings section is mounted with: what belongs to the person, and nothing from a graph,
 * since there may be no graph open.
 *
 * @beta
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
 * @beta
 */
export interface MountedSettingsSection {
    /** The tab closed, or the extension was switched off. */
    destroy(): void
}

/**
 * One settings section an extension adds.
 *
 * @beta
 */
export interface SettingsSection {
    /** Unique within the extension. */
    id: string
    /** The tab it goes in. */
    tab: SettingsSectionTab
    /** Draw the section into `element`, which is empty and is the extension's alone. */
    mount(element: HTMLElement, context: SettingsSectionContext): MountedSettingsSection
}
