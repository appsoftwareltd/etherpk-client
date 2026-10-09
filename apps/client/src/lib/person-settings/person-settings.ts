/**
 * A person's settings (ADR 0134): what they set that belongs to them rather than to a graph, the
 * first being [[Extension Settings]], kept under `extension.<extension id>.<setting id>`. They are
 * kept on this device, and where the person's account syncs a graph they also go into the account's
 * vault (`person-settings-sync.ts`), so they follow the person to their other devices.
 *
 * Each setting records when it was changed. Between two devices the later change wins, setting by
 * setting. A cleared setting is kept as cleared, so the clearing reaches the other devices too.
 * What this device changed and the account has not had yet is pending, and goes up when the device
 * can reach the account. The first time a device syncs, the account's values win and the device
 * gives it only the settings it lacks. A device that synced with another account before takes the
 * new account's settings as they are and gives it nothing, and when the account it synced with
 * ends here (signed out, disconnected, refused) its settings leave the device. So a shared device
 * never carries one person's settings, a key they pay for among them, into another's account or
 * session.
 *
 * `localStorage`, not a cookie: purely client-side. Every read and write tolerates a storage that
 * throws (a private window, blocked site data), falling back to memory for the session. A `storage`
 * event keeps a second tab on this device in step.
 */

export const PERSON_SETTINGS_STORAGE_KEY = 'etherpk:person-settings'

/** One setting as it is kept: its value, or null once cleared, and when it was changed. */
export interface PersonSetting {
    value: string | null
    /** Milliseconds since 1970 when the person changed it, which decides between two devices. */
    changedAt: number
}

export type PersonSettingsRecord = Record<string, PersonSetting>

/** What this device keeps. */
interface Stored {
    settings: PersonSettingsRecord
    /** Changed here and not yet in the account's vault. */
    pending: string[]
    /** The account this device last synced with, `<origin> <account id>`; absent before its first sync. */
    syncedWith?: string
}

export interface PersonSettings {
    /** A setting's value, or undefined when it is not set. */
    get(key: string): string | undefined
    /** Set a setting, or clear it with null. Empty text clears it too. */
    set(key: string, value: string | null): void
    /** Called whenever any setting changes, here, in another tab or from the account. */
    subscribe(listener: () => void): () => void
    /** The account this device last synced with, if any. */
    syncedWith(): string | undefined
    /** True while a change made here has not reached the account's vault. */
    hasPending(): boolean
    /**
     * Take in the settings in an account's vault and say what the vault should be given: a later
     * change wins, setting by setting. On the device's first sync the account's values win and the
     * vault is given only what it lacks; after a sync with another account, nothing.
     */
    merge(account: string, vault: PersonSettingsRecord): PersonSettingsRecord
    /** The vault now holds these, as of their change times: they are no longer pending. */
    delivered(account: string, given: PersonSettingsRecord): void
    /**
     * The account on `serverOrigin` ended on this device: signed out, disconnected or refused. When
     * it is the account this device synced with, its settings leave the device, changes not yet
     * sent among them, and the next sync is the device's first. No origin means every account.
     */
    accountEnded(serverOrigin?: string): void
    /** Another tab wrote to storage: read again when the key is ours (or null, a whole clear). */
    storageChanged(key: string | null): void
}

const empty = (): Stored => ({ settings: {}, pending: [] })

function isSetting(value: unknown): value is PersonSetting {
    if (typeof value !== 'object' || value === null) return false
    const setting = value as Record<string, unknown>
    return (typeof setting.value === 'string' || setting.value === null) && typeof setting.changedAt === 'number' && Number.isFinite(setting.changedAt)
}

/** The settings in a record that read as settings, the rest dropped. */
export function readPersonSettings(value: unknown): PersonSettingsRecord {
    const settings: PersonSettingsRecord = {}
    if (typeof value !== 'object' || value === null) return settings
    for (const [key, setting] of Object.entries(value)) if (isSetting(setting)) settings[key] = { value: setting.value, changedAt: setting.changedAt }
    return settings
}

export function createPersonSettings(storage: () => Storage | null, now: () => number = Date.now): PersonSettings {
    let current: Stored | null = null
    const listeners = new Set<() => void>()

    function read(): Stored {
        try {
            const raw = storage()?.getItem(PERSON_SETTINGS_STORAGE_KEY)
            if (!raw) return empty()
            const parsed = JSON.parse(raw) as Partial<Stored>
            return {
                settings: readPersonSettings(parsed.settings),
                pending: Array.isArray(parsed.pending) ? parsed.pending.filter((key): key is string => typeof key === 'string') : [],
                ...(typeof parsed.syncedWith === 'string' ? { syncedWith: parsed.syncedWith } : {}),
            }
        } catch {
            return empty()
        }
    }

    function state(): Stored {
        current ??= read()
        return current
    }

    /** Keep `next`, telling the listeners when the settings themselves changed. */
    function write(next: Stored): void {
        const changed = JSON.stringify(next.settings) !== JSON.stringify(state().settings)
        current = next
        try {
            storage()?.setItem(PERSON_SETTINGS_STORAGE_KEY, JSON.stringify(next))
        } catch {
            // Refused: the in-memory settings still apply for the rest of the session.
        }
        if (changed) for (const listener of listeners) listener()
    }

    return {
        get(key) {
            return state().settings[key]?.value ?? undefined
        },
        set(key, value) {
            const was = state()
            const next = value === null || value.trim() === '' ? null : value.trim()
            if ((was.settings[key]?.value ?? null) === next) return
            // Never earlier than the change it replaces, whatever this device's clock says.
            const changedAt = Math.max(now(), (was.settings[key]?.changedAt ?? 0) + 1)
            write({ ...was, settings: { ...was.settings, [key]: { value: next, changedAt } }, pending: [...new Set([...was.pending, key])] })
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        syncedWith() {
            return state().syncedWith
        },
        hasPending() {
            return state().pending.length > 0
        },
        merge(account, vault) {
            const was = state()
            // Another account is another person, or the same person somewhere else: this device takes
            // that account's settings as they are, and gives it nothing of the last one's.
            if (was.syncedWith !== undefined && was.syncedWith !== account) {
                write({ settings: { ...vault }, pending: [], syncedWith: was.syncedWith })
                return {}
            }
            const first = was.syncedWith === undefined
            const settings: PersonSettingsRecord = { ...was.settings }
            const give: PersonSettingsRecord = {}
            const pending = new Set(was.pending)
            for (const [key, theirs] of Object.entries(vault)) {
                const ours = settings[key]
                if (!first && ours !== undefined && pending.has(key) && ours.changedAt > theirs.changedAt) give[key] = ours
                else {
                    settings[key] = theirs
                    pending.delete(key)
                }
            }
            // What the vault lacks: this device's pending changes, or on its first sync all it holds.
            for (const [key, ours] of Object.entries(settings)) {
                if (!(key in vault) && (first || pending.has(key))) give[key] = ours
            }
            write({ settings, pending: [...pending].filter((key) => key in give), syncedWith: was.syncedWith })
            return give
        },
        delivered(account, given) {
            const was = state()
            // A change made here while the vault was being written stays pending.
            const pending = was.pending.filter((key) => !(key in given) || was.settings[key]?.changedAt !== given[key].changedAt)
            write({ ...was, pending, syncedWith: account })
        },
        accountEnded(serverOrigin) {
            const synced = state().syncedWith
            if (synced === undefined) return
            if (serverOrigin !== undefined && synced.slice(0, synced.indexOf(' ')) !== serverOrigin) return
            write(empty())
        },
        storageChanged(key) {
            if (key !== null && key !== PERSON_SETTINGS_STORAGE_KEY) return
            // Compared with what this tab last held: one that never read anything has heard of no value.
            const before = current === null ? null : JSON.stringify(current.settings)
            current = read()
            if (JSON.stringify(current.settings) !== before) for (const listener of listeners) listener()
        },
    }
}

let shared: PersonSettings | null = null

/** This device's person settings, one store for the page. */
export function personSettings(): PersonSettings {
    if (shared) return shared
    const settings = createPersonSettings(() => (typeof localStorage === 'undefined' ? null : localStorage))
    shared = settings
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', (event) => {
            // `storageArea` is null for a clear in some browsers; only localStorage is ours.
            if (event.storageArea === null || event.storageArea === localStorage) settings.storageChanged(event.key)
        })
    }
    return settings
}

/** The key an extension's setting is kept under. */
export function extensionSettingKey(extensionId: string, settingId: string): string {
    return `extension.${extensionId}.${settingId}`
}
