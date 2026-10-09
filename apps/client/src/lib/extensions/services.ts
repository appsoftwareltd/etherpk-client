/**
 * What the extension host is given to build each extension's context (ADR 0121): the open graph's
 * registries and questions, and what holds for the Client's whole run. The workspace supplies
 * them; the host never reaches into the workspace itself.
 */
import type { ExtensionConcepts, ExtensionIndex, ExtensionLayout, Keybinding } from '@appsoftwareltd/etherpk-extension-api'

import type { CommandRegistry, ContributionRegistry, EventBus } from '$lib/surface'
import type { PersonSettings } from '$lib/person-settings/person-settings'
import type { TrustedMarkup } from '$lib/security/trusted-types'

/** The key chords the workspace listens for, which extensions add to. */
export interface KeybindingTable {
    /** Add a chord. Throws if the Client or an extension binds the same chord already. */
    add(binding: Keybinding): () => void
}

/** One open graph, as far as the extension host may reach it. */
export interface GraphServices {
    graphId: string
    commands: CommandRegistry
    contributions: ContributionRegistry
    events: EventBus
    index: ExtensionIndex
    layout: ExtensionLayout
    concepts: ExtensionConcepts
    keybindings: KeybindingTable
    notify(text: string): void
}

/** What holds for the Client's whole run, whichever graph is open. */
export interface ClientServices {
    /** The Client's version, `x.y.z`. */
    clientVersion: string
    /** A development build, where tests may reach into an extension. */
    dev: boolean
    /** True while the dark theme shows. */
    isDark(): boolean
    /**
     * One of the Client's icons, or one an extension's manifest added, as trusted SVG markup
     * (ADR 0130): an extension's own is sanitized first.
     */
    iconSvg(name: string, options?: { size?: number; strokeWidth?: number; label?: string }): TrustedMarkup
    /** Where extensions keep their own values on this device; none where storage is refused. */
    storage: Storage | undefined
    /** The person's settings, Extension Settings among them (ADR 0134). */
    settings: Pick<PersonSettings, 'get' | 'subscribe'>
}
