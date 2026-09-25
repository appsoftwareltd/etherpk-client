/**
 * The [[Spell Check]] preference: whether this device checks spelling in documents (ADR 0095). Per
 * device, like the editor font size (`editor-font.ts`) and the [[Layout]]: never synced, never in
 * an [[Export]], the same in every graph. On by default. Off, the spell service closes, so no
 * dictionary is downloaded or held. Which languages a graph is checked in is a separate,
 * per-graph choice (`spelling/languages.ts`).
 *
 * `localStorage`, not a cookie: purely client-side and never needed at SSR. Every read and write
 * tolerates a storage that throws (private windows, blocked site data), falling back to the
 * in-memory value for the session. A `storage` event keeps a second tab on this device in step,
 * because the preference belongs to the device rather than to the tab that changed it.
 */

export const SPELL_CHECK_STORAGE_KEY = 'etherpk:spell-check'

/** The one stored value that turns checking off; anything else, or nothing, is on. */
const OFF = 'off'

export interface SpellCheckPreference {
    enabled(): boolean
    set(enabled: boolean): void
    /** Flip the preference; returns the new state. */
    toggle(): boolean
    /** Called with the new state whenever it changes. Returns an unsubscribe. */
    subscribe(listener: (enabled: boolean) => void): () => void
    /** Another tab wrote to storage: re-read when the key is ours (or `null`, a whole clear). */
    storageChanged(key: string | null): void
}

export function createSpellCheckPreference(storage: () => Storage | null): SpellCheckPreference {
    let current: boolean | null = null
    const listeners = new Set<(enabled: boolean) => void>()

    function read(): boolean {
        try {
            return storage()?.getItem(SPELL_CHECK_STORAGE_KEY) !== OFF
        } catch {
            return true
        }
    }

    function update(next: boolean): void {
        if (next === current) return
        current = next
        for (const listener of listeners) listener(next)
    }

    function enabled(): boolean {
        current ??= read()
        return current
    }

    function set(next: boolean): void {
        current ??= read()
        try {
            storage()?.setItem(SPELL_CHECK_STORAGE_KEY, next ? 'on' : OFF)
        } catch {
            // Refused: the in-memory value still applies for the rest of the session.
        }
        update(next)
    }

    return {
        enabled,
        set,
        toggle() {
            set(!enabled())
            return enabled()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        storageChanged(key) {
            if (key !== null && key !== SPELL_CHECK_STORAGE_KEY) return
            current ??= read()
            update(read())
        },
    }
}

const preference = createSpellCheckPreference(() => (typeof localStorage === 'undefined' ? null : localStorage))

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        // `storageArea` is null for a clear in some browsers; only localStorage is ours.
        if (event.storageArea === null || event.storageArea === localStorage) preference.storageChanged(event.key)
    })
}

export function isSpellCheckEnabled(): boolean {
    return preference.enabled()
}

export function setSpellCheckEnabled(enabled: boolean): void {
    preference.set(enabled)
}

export function toggleSpellCheck(): boolean {
    return preference.toggle()
}

export function subscribeSpellCheck(listener: (enabled: boolean) => void): () => void {
    return preference.subscribe(listener)
}
