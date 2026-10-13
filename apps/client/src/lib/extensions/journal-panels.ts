/**
 * Mounting an extension's [[Journal Panel]] (`surface/journal-panels.ts`) beneath a journal tab's
 * entry, as `JournalPanels.svelte` does for each registered panel.
 *
 * Two things are added on the way, as for fence widgets (`fence-widgets.ts`):
 *
 * - **Where it mounts.** A loaded extension's panel mounts in a shadow root holding the extension's
 *   stylesheets, as its Views do (ADR 0121), so neither side's CSS reaches the other. The shadow
 *   root's base sheet makes a View fill its Pane; a panel is as tall as what it draws instead, so a
 *   panel that draws nothing takes no space.
 * - **Guards.** A panel whose mount throws shows a short note in its place, and one whose destroy
 *   throws is logged: an extension's mistake costs its own panel, never the journal tab.
 */
import type { JournalPanelProps, MountedJournalPanel } from '@appsoftwareltd/etherpk-extension-api'

import type { ClientJournalPanel } from '$lib/surface/journal-panels'

import { extensionStyleSheets } from './styles'

export interface MountedClientJournalPanel {
    destroy(): void
}

/** What a panel's shadow root adds after the base sheet: the height of what it draws. */
let panelSheet: CSSStyleSheet | undefined

function naturalHeightSheet(): CSSStyleSheet {
    if (!panelSheet) {
        panelSheet = new CSSStyleSheet()
        panelSheet.replaceSync(':host { height: auto; } .extension-journal-panel { height: auto; }')
    }
    return panelSheet
}

function failedNote(host: HTMLElement | ShadowRoot, extensionName: string): void {
    const note = document.createElement('p')
    note.setAttribute('role', 'alert')
    note.setAttribute('data-testid', 'journal-panel-failed')
    note.style.cssText = 'margin:0;padding:0.5rem 0;font-size:0.875rem;color:var(--gk-text-muted)'
    note.textContent = `${extensionName} couldn't draw its panel for this day.`
    host.append(note)
}

function guarded(extensionName: string, mounted: MountedJournalPanel): MountedClientJournalPanel {
    return {
        destroy() {
            try {
                mounted.destroy()
            } catch (error) {
                console.error(`[extensions] ${extensionName}: a Journal Panel's destroy threw`, error)
            }
        },
    }
}

const nothing: MountedClientJournalPanel = { destroy: () => {} }

function mountGuarded(panel: ClientJournalPanel, element: HTMLElement, props: JournalPanelProps): MountedClientJournalPanel {
    try {
        return guarded(panel.extensionName, panel.mount(element, props))
    } catch (error) {
        console.error(`[extensions] ${panel.extensionName}: a Journal Panel's mount threw`, error)
        failedNote(element, panel.extensionName)
        return nothing
    }
}

/** Draw `panel` into `host` for a journal tab's day. */
export function mountJournalPanel(host: HTMLElement, panel: ClientJournalPanel, props: JournalPanelProps): MountedClientJournalPanel {
    if (!panel.isolation) return mountGuarded(panel, host, props)
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    let mounted: MountedClientJournalPanel | null = null
    let destroyed = false
    // Mounted once the extension's stylesheets are in, so the panel never draws unstyled.
    extensionStyleSheets(panel.isolation.styles).then(
        ([base, ...own]) => {
            if (destroyed) return
            shadow.adoptedStyleSheets = [base, naturalHeightSheet(), ...own]
            const root = document.createElement('div')
            root.className = 'extension-journal-panel'
            shadow.append(root)
            mounted = mountGuarded(panel, root, props)
        },
        (error: unknown) => {
            if (destroyed) return
            console.error(`[extensions] ${panel.extensionName}: its stylesheets would not load`, error)
            failedNote(shadow, panel.extensionName)
        },
    )
    return {
        destroy() {
            destroyed = true
            mounted?.destroy()
            shadow.replaceChildren()
        },
    }
}
