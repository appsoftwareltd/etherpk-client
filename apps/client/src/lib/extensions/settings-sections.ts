/**
 * Extensions' own sections in the Client's settings (ADR 0134, amended 2026-10-15 and
 * 2026-10-17): in the Agents tab, or under an extension's own entry in the Extensions area. An
 * [[Agent Chat]]'s Model Connections are one, in the Agents tab.
 *
 * A section belongs to the person, so its context holds what is the person's (the extension's
 * settings and records kept with the person, signing in to another service, the theme) and nothing
 * from a graph. A switched-on extension compiled into the Client has its sections drawn with or
 * without a graph open, since its module is loaded with the Client. Any other extension's module is
 * imported as it starts in a graph, so its sections are drawn in that graph's settings while it
 * runs there (`loadedModule`), and not on the Graphs page.
 */
import type { ExtensionModule, SettingsSection, SettingsSectionContext, SettingsSectionTab } from '@appsoftwareltd/etherpk-extension-api'

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
    /**
     * The module of a loaded extension running in the open graph, or null: its sections are drawn
     * only then. Absent with no graph open.
     */
    loadedModule?: (id: string) => ExtensionModule | null
    /** Only this extension's sections, as its own entry in the Extensions area draws them. */
    extensionId?: string
}

/** Whether a loaded module's export is a section the Client can draw: it comes from outside the Client. */
function isSection(value: unknown): value is SettingsSection {
    const section = value as Partial<SettingsSection> | null
    return typeof section?.id === 'string' && (section.tab === 'agents' || section.tab === 'extension') && typeof section.mount === 'function'
}

/** The sections the switched-on extensions add to `tab`, in the catalogue's order. */
export function settingsSectionsFor(tab: SettingsSectionTab, deps: SettingsSectionDeps): ExtensionSettingsSection[] {
    const out: ExtensionSettingsSection[] = []
    for (const entry of deps.catalogue.extensions) {
        if ((deps.extensionId !== undefined && entry.id !== deps.extensionId) || !deps.switches.isOn(entry.id)) continue
        const module = entry.source === 'compiled-in' ? entry.module : (deps.loadedModule?.(entry.id) ?? null)
        const exported: unknown = module?.settingsSections ?? []
        if (!Array.isArray(exported)) continue
        for (const section of exported) {
            if (!isSection(section)) {
                console.error(`[extensions] ${entry.id}: one of its settingsSections is not a section the Client can draw`, section)
                continue
            }
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
