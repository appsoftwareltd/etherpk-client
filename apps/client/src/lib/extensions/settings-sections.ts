/**
 * Extensions' own sections in the Client's settings tabs (ADR 0134, amended 2026-10-15), mounted
 * with or without a graph open: on the Graphs page, and in a graph's settings. An [[Agent Chat]]'s
 * Model Connections are one, in the Agents tab.
 *
 * A section belongs to the person, so its context holds what is the person's (the extension's
 * settings and records kept with the person, signing in to another service, the theme) and nothing
 * from a graph. Only a switched-on extension compiled into the Client has sections here: the
 * Proposed part of the API is for the extensions that come with EtherPK, and a compiled-in one's
 * module is loaded with the Client, so a section draws without the extension host starting.
 */
import type { SettingsSection, SettingsSectionContext, SettingsSectionTab } from '@appsoftwareltd/etherpk-extension-api'

import type { Catalogue } from './catalogue'
import { type ContextLifecycle, extensionPersonStorage, extensionSettings } from './person-scoped'
import type { ClientServices } from './services'
import type { ExtensionSwitches } from './switches'

export interface ExtensionSettingsSection {
    extensionId: string
    /** The extension's name, which the tab shows above the section. */
    displayName: string
    section: SettingsSection
    context: SettingsSectionContext
    /** Take back the context's subscriptions; it writes nothing after. */
    dispose(): void
}

export interface SettingsSectionDeps {
    catalogue: Catalogue
    switches: Pick<ExtensionSwitches, 'isOn'>
    client: Pick<ClientServices, 'settings' | 'signIn' | 'isDark'>
    notify(text: string): void
}

/** The sections the switched-on, compiled-in extensions add to `tab`, in the catalogue's order. */
export function settingsSectionsFor(tab: SettingsSectionTab, deps: SettingsSectionDeps): ExtensionSettingsSection[] {
    const out: ExtensionSettingsSection[] = []
    for (const entry of deps.catalogue.extensions) {
        if (entry.source !== 'compiled-in' || !deps.switches.isOn(entry.id)) continue
        for (const section of entry.module.settingsSections ?? []) {
            if (section.tab !== tab) continue
            const disposers: (() => void)[] = []
            let disposed = false
            const life: ContextLifecycle = {
                keep(undo) {
                    if (disposed) {
                        undo()
                        return () => {}
                    }
                    disposers.push(undo)
                    return undo
                },
                disposed: () => disposed,
            }
            const manifest = entry.package.manifest
            out.push({
                extensionId: entry.id,
                displayName: manifest.displayName,
                section,
                context: {
                    extensionId: entry.id,
                    settings: extensionSettings(entry.id, manifest, deps.client, life),
                    personStorage: extensionPersonStorage(entry.id, deps.client, life),
                    auth: deps.client.signIn,
                    theme: { isDark: () => deps.client.isDark() },
                    notify: (text) => deps.notify(text),
                },
                dispose() {
                    if (disposed) return
                    disposed = true
                    for (const undo of disposers.splice(0)) undo()
                },
            })
        }
    }
    return out
}
