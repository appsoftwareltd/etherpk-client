/**
 * The spell service the editors ask, like the active editor and document accessors: set once
 * by the workspace when it mounts (`spell-service-host.ts` builds the real one), read by every
 * editor's spelling augmentation. Null outside a workspace (the dev harness, the Node tests
 * until one sets a fake), and then nothing is underlined.
 */

import type { SpellService } from './spell-service'

let active: SpellService | null = null
const listeners = new Set<() => void>()

export function setActiveSpellService(service: SpellService | null): void {
    active = service
    for (const listener of listeners) listener()
}

export function getActiveSpellService(): SpellService | null {
    return active
}

/** Told when the active service is replaced (not about its own changes). Returns an unsubscribe. */
export function onActiveSpellServiceChanged(listener: () => void): () => void {
    listeners.add(listener)
    return () => void listeners.delete(listener)
}
