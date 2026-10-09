/**
 * Which extensions are switched off on this device (ADR 0121, Settings and Extensions →
 * Extensions). Every extension is on until someone switches it off, so only the exceptions are
 * stored. The list is
 * per device, like the spell check switch, until a per-user channel can carry it (ADR 0123).
 */

/** The localStorage key holding the ids switched off, as a JSON list. */
export const EXTENSION_SWITCHES_KEY = 'etherpk:extensions-off'

export interface ExtensionSwitches {
    isOn(id: string): boolean
    set(id: string, on: boolean): void
    /** Called after each change. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
}

export function createExtensionSwitches(storage: Storage | undefined = safeLocalStorage()): ExtensionSwitches {
    const off = new Set<string>(read(storage))
    const listeners = new Set<() => void>()
    return {
        isOn: (id) => !off.has(id),
        set(id, on) {
            if (on === !off.has(id)) return
            if (on) off.delete(id)
            else off.add(id)
            try {
                storage?.setItem(EXTENSION_SWITCHES_KEY, JSON.stringify([...off].sort()))
            } catch {
                // A browser refusing storage keeps the switch for this session only.
            }
            for (const listener of listeners) listener()
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

function read(storage: Storage | undefined): string[] {
    try {
        const parsed: unknown = JSON.parse(storage?.getItem(EXTENSION_SWITCHES_KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
        return []
    }
}

/** The browser's localStorage, or none where reading it throws (a sandboxed frame, Node). */
function safeLocalStorage(): Storage | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
        return undefined
    }
}
