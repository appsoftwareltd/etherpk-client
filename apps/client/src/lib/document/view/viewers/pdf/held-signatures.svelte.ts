import { SvelteMap } from 'svelte/reactivity'

import type { PlacedSignature } from './pdf-overlay'

/**
 * The signatures placed on each PDF, by graph and the PDF's hash. They are in no file until a copy is
 * saved, and a tab is rebuilt when the layout changes, as when a tablet turns, and on a phone whenever
 * another document comes in front. So they are kept here, for the life of the page and in memory only.
 */
export interface HeldSignatures {
    list: PlacedSignature[]
    /** Everything in `list` is in a saved copy. */
    saved: boolean
}

const held = new SvelteMap<string, HeldSignatures>()

const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()

export const signaturesKey = (graphId: string, hash: string): string => `${graphId}:${hash}`

export function heldSignatures(key: string): HeldSignatures | undefined {
    return held.get(key)
}

export function holdSignatures(key: string, signatures: HeldSignatures): void {
    if (signatures.list.length > 0) held.set(key, signatures)
    else held.delete(key)
    // Here and not in the tab, which a phone takes away while the signature waits.
    if ([...held.values()].some(({ saved }) => !saved)) window.addEventListener('beforeunload', warnBeforeUnload)
    else window.removeEventListener('beforeunload', warnBeforeUnload)
}

/** The person chose not to keep them, or a saved copy has them and their tab has closed. */
export function dropSignatures(key: string): void {
    for (const signature of held.get(key)?.list ?? []) URL.revokeObjectURL(signature.url)
    holdSignatures(key, { list: [], saved: true })
}
