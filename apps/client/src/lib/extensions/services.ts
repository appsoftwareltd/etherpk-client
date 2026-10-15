/**
 * What the extension host is given to build each extension's context (ADR 0121): the open graph's
 * registries and questions, and what holds for the Client's whole run. The workspace supplies
 * them; the host never reaches into the workspace itself.
 */
import type {
    ExtensionAssets,
    ExtensionAuth,
    ExtensionConcepts,
    ExtensionDocuments,
    ExtensionGraphRecords,
    ExtensionIndex,
    ExtensionLayout,
    InlinePanel,
    InlinePanelOptions,
    Keybinding,
} from '@appsoftwareltd/etherpk-extension-api'

import type { CommandRegistry, ContributionRegistry, EventBus } from '$lib/surface'
import type { ClientDialogs } from './dialogs'
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
    /** The graph's documents as a language model may read them, protected ones left out (`agent-read`). */
    documents: ExtensionDocuments
    /** One extension's records for this graph on this device (`graph-records.ts`). */
    records(extensionId: string): ExtensionGraphRecords
    /** Images kept as this graph's assets (`extension-assets.ts`). */
    assets: ExtensionAssets
    /** The editor the person is working in, as far as an extension may reach it. */
    editor: {
        /** Put a block at the caret (`block-insert.ts`). False where nothing was put in. */
        insertBlock(text: string, options?: { focus?: boolean }): boolean
        /** Draw a panel beneath the caret's line or the last line (`inline-panels.ts`). Null where none can go. */
        openPanel(options: InlinePanelOptions & { at?: 'caret' | 'end' | 'caret-or-end' }): InlinePanel | null
    }
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
    /**
     * The person's settings, Extension Settings among them (ADR 0134), and the records extensions
     * keep with the person (ADR 0140).
     */
    settings: Pick<PersonSettings, 'get' | 'keys' | 'set' | 'subscribe'>
    /** The dialogs the Client draws for an extension (`dialogs.ts`), each naming the extension that asks. */
    dialogs: ClientDialogs
    /** Signing in to another service in a popup, through the Client's one return page (`sign-in.ts`). */
    signIn: ExtensionAuth
}
