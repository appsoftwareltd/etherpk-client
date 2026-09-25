/**
 * The Backlinks [[View]]'s own state, per device and per [[Knowledge Graph]]: whether a quoted
 * line **highlights** the reference by dimming everything else, which document the panel is
 * **pinned** to, and what **Show backlinks** asked it to show while it follows the editor.
 *
 * Per-device presentation state, exactly like the [[Tasks View]]'s filter — never synced, never in
 * an [[Export]] (ADR 0013), and deliberately NOT in the Layout model, where a per-View state slot
 * would bump `LAYOUT_VERSION` and discard everyone's saved pane arrangement to remember a toggle.
 *
 * Only `highlight` is written to storage. The pin is held for the graph session and no longer:
 * a panel that came back after a reload silently stuck on last week's document would read as
 * broken, whereas one that has gone back to following the editor reads as a fresh start. It lives
 * here rather than in the component because the mobile presenter unmounts a drawer's View every
 * time the drawer closes, and a pin that did not survive that would be no pin at all.
 *
 * **Show backlinks** on a wikilink or a tab (`commands/document-commands.ts`, ADR 0088) changes
 * what the panel shows and leaves the pin as it is: pinned, the pin moves to the concept asked
 * for; following the editor, the concept stands in for the editor's document until the editor
 * moves on, at which point the panel is following again. That policy is {@link show} and
 * {@link activeDocumentChanged} here rather than in the View, and the store is observable,
 * because the View is not always there to run it: the mobile presenter unmounts a drawer's View
 * whenever the drawer closes, and the workspace feeds the editor's moves to the store meanwhile.
 * A mounted View hears every change through `subscribe`; one the reveal mounts reads the state
 * at mount.
 *
 * Zod-validated; a corrupt or incompatible payload degrades to the defaults, never throws.
 */

import { z } from 'zod'

export const BACKLINKS_PREFERENCES_KEY_PREFIX = 'etherpk-backlinks:'
const VERSION = 1
const SAVE_DEBOUNCE_MS = 300

/**
 * What Show backlinks asked for while the panel was following the editor: shown in place of the
 * editor's document for as long as the editor stays on `activeDocument`.
 */
export interface ShownConcept {
    concept: string
    activeDocument: string | null
}

export interface BacklinksPreferences {
    /** Dim everything in a quoted line except the link to the document being viewed. */
    highlight: boolean
    /** The document the panel is held on, or `null` when it follows the active editor. */
    pinned: string | null
    /** Standing in for the editor's document while it stays put; never set while pinned. */
    shown: ShownConcept | null
}

/** The part that is remembered across sessions. */
const persistedSchema = z.object({ highlight: z.boolean() })
const payloadSchema = z.object({ version: z.number(), preferences: persistedSchema })

/** Standard colours and nothing pinned: the panel follows the editor and reads like the document. */
export function defaultBacklinksPreferences(): BacklinksPreferences {
    return { highlight: false, pinned: null, shown: null }
}

export interface BacklinksPreferencesStore {
    get(): BacklinksPreferences
    /** Change some of it; subscribers hear it at once, the persisted part is saved shortly after. */
    set(next: Partial<BacklinksPreferences>): void
    /** Hear the current state now and every change after it; returns an unsubscribe. */
    subscribe(listener: (preferences: BacklinksPreferences) => void): () => void
    /**
     * Show `concept`'s backlinks without touching the pin: pinned, the pin moves to it; following
     * the editor, it stands in for the editor's document (`activeDocument`) until the editor moves
     * on. Asked for the editor's own document while following, there is nothing to stand in for.
     */
    show(concept: string, activeDocument: string | null): void
    /** The editor is on `documentId`: what stood in for another document is dropped. */
    activeDocumentChanged(documentId: string | null): void
    /** Write any pending debounced save now (teardown). */
    flush(): void
}

export function createBacklinksPreferencesStore(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): BacklinksPreferencesStore {
    const key = `${BACKLINKS_PREFERENCES_KEY_PREFIX}${graphId}`
    let current = load()
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const listeners = new Set<(preferences: BacklinksPreferences) => void>()

    function load(): BacklinksPreferences {
        const defaults = defaultBacklinksPreferences()
        const raw = storage?.getItem(key)
        if (!raw) return defaults
        try {
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            if (!parsed.success || parsed.data.version !== VERSION) return defaults
            return { ...defaults, ...parsed.data.preferences }
        } catch {
            return defaults
        }
    }

    function save(): void {
        saveTimer = undefined
        try {
            storage?.setItem(key, JSON.stringify({ version: VERSION, preferences: { highlight: current.highlight } }))
        } catch {
            // A full or blocked quota costs a remembered toggle, never the View.
        }
    }

    function set(next: Partial<BacklinksPreferences>): void {
        current = { ...current, ...next }
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
        for (const listener of listeners) listener(current)
    }

    return {
        get: () => current,
        set,
        subscribe(listener) {
            listeners.add(listener)
            listener(current)
            return () => listeners.delete(listener)
        },
        show(concept, activeDocument) {
            if (current.pinned !== null) set({ pinned: concept })
            else set({ shown: concept === activeDocument ? null : { concept, activeDocument } })
        },
        activeDocumentChanged(documentId) {
            if (current.shown && current.shown.activeDocument !== documentId) set({ shown: null })
        },
        flush() {
            if (saveTimer) {
                clearTimeout(saveTimer)
                save()
            }
        },
    }
}
