/**
 * What the Spelling tab of the Settings modal needs (ADR 0095).
 *
 * A module rather than a type inside the component, because both the Settings modal and the
 * workspace that fills it need to name the shape, and a Svelte instance script cannot export a
 * type. The preference and the [[Graph Dictionary]] are module-level stores the tab reads
 * directly; the spell service is passed in because it belongs to the workspace.
 */

import type { SpellService } from '../spell-service'

export interface SpellingTabProps {
    service: SpellService
    /** The dictionary host, as the tab names it ("dictionaries.etherpk.com"); empty when none. */
    dictionaryHost: string
}

/** The host part of a dictionary address, for saying where downloads come from. */
export function dictionaryHostLabel(baseUrl: string): string {
    if (!baseUrl) return ''
    if (baseUrl.startsWith('/')) return 'this server' // served beside the Client (development)
    try {
        return new URL(baseUrl).host
    } catch {
        return baseUrl
    }
}
