/**
 * The open graph's [[Theme]]s (ADR 0082), as an observable the Theme editor View and the
 * Publish tab read. **Shared graph content, not per-device state**: the list rides the graph's
 * theme container - the root doc's `themes` Y.Map on a [[Server Backend]], `etherpk/theme-<id>.jsonc`
 * files on a [[Filesystem Backend]] - so it syncs, survives a cleared browser and travels in an
 * [[Export]]. A plain observable with injected persistence, matching `favourites.ts`: the
 * callers are Views mounted outside Svelte context, and the two backends persist differently.
 * The workspace wires `persist` when it opens a graph.
 */

import type { GraphTheme } from './graph-theme'

export interface GraphThemePersist {
    put(theme: GraphTheme): Promise<void>
    putFile(id: string, path: string, text: string): Promise<void>
    removeFile(id: string, path: string): Promise<void>
    remove(id: string): Promise<void>
}

let list: GraphTheme[] = []
let persist: GraphThemePersist | null = null
const listeners = new Set<(themes: GraphTheme[]) => void>()

function emit(): void {
    const snapshot = list.map((t) => ({ ...t, files: { ...t.files } }))
    for (const listener of listeners) listener(snapshot)
}

function sorted(themes: readonly GraphTheme[]): GraphTheme[] {
    return [...themes].sort((a, b) => a.id.localeCompare(b.id))
}

/** Seed the list for a newly opened graph and wire how it is written. */
export function setGraphThemes(themes: readonly GraphTheme[], persistence: GraphThemePersist | null): void {
    list = sorted(themes)
    persist = persistence
    emit()
}

/** Replace the list with what arrived from elsewhere (a peer, a folder rescan). */
export function adoptGraphThemes(themes: readonly GraphTheme[]): void {
    list = sorted(themes)
    emit()
}

export function resetGraphThemes(): void {
    list = []
    persist = null
    emit()
}

export function getGraphThemes(): GraphTheme[] {
    return list.map((t) => ({ ...t, files: { ...t.files } }))
}

export function getGraphTheme(id: string): GraphTheme | null {
    const theme = list.find((t) => t.id === id)
    return theme ? { ...theme, files: { ...theme.files } } : null
}

export function subscribeGraphThemes(listener: (themes: GraphTheme[]) => void): () => void {
    listeners.add(listener)
    listener(getGraphThemes())
    return () => listeners.delete(listener)
}

function requirePersist(): GraphThemePersist {
    if (!persist) throw new Error('No graph is open, so a theme cannot be saved.')
    return persist
}

/** Save a whole theme (new or replaced). Rolls the list back if the write is refused. */
export async function saveGraphTheme(theme: GraphTheme): Promise<void> {
    const before = list
    const next = { ...theme, updatedAt: new Date().toISOString() }
    list = sorted([...list.filter((t) => t.id !== theme.id), next])
    emit()
    try {
        await requirePersist().put(next)
    } catch (error) {
        list = before
        emit()
        throw error
    }
}

/** Save one file of a theme. */
export async function saveGraphThemeFile(id: string, path: string, text: string): Promise<void> {
    const before = list
    list = list.map((t) => (t.id === id ? { ...t, files: { ...t.files, [path]: text }, updatedAt: new Date().toISOString() } : t))
    emit()
    try {
        await requirePersist().putFile(id, path, text)
    } catch (error) {
        list = before
        emit()
        throw error
    }
}

export async function removeGraphThemeFile(id: string, path: string): Promise<void> {
    const before = list
    list = list.map((t) => {
        if (t.id !== id) return t
        const files = { ...t.files }
        delete files[path]
        return { ...t, files, updatedAt: new Date().toISOString() }
    })
    emit()
    try {
        await requirePersist().removeFile(id, path)
    } catch (error) {
        list = before
        emit()
        throw error
    }
}

export async function removeGraphTheme(id: string): Promise<void> {
    const before = list
    list = list.filter((t) => t.id !== id)
    emit()
    try {
        await requirePersist().remove(id)
    } catch (error) {
        list = before
        emit()
        throw error
    }
}
