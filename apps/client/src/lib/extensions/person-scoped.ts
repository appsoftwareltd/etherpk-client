/**
 * The parts of an extension's context that belong to the person rather than a graph: its
 * settings (ADR 0134) and its records kept with the person (ADR 0140). Built here once, so the
 * context an extension gets in a graph (`scoped-context.ts`) and the one its settings section gets
 * with no graph open (`settings-sections.ts`, ADR 0147) read and write them the same way.
 */
import type { ExtensionManifest, ExtensionPersonStorage, ExtensionSettings } from '@appsoftwareltd/etherpk-extension-api'

import { extensionDataKey, extensionSettingKey } from '$lib/person-settings/person-settings'

import type { ClientServices } from './services'

/** A key a record kept with the person may have (`personStorage`). */
const RECORD_KEY = /^[A-Za-z0-9._-]{1,100}$/

/** The most JSON one record kept with the person may hold, so no extension fills the account's Settings Vault. */
export const RECORD_LIMIT = 64 * 1024

/** How a context keeps a subscription's undo for its own clean-up, and whether it has stopped. */
export interface ContextLifecycle {
    /** Keep `undo` to run at clean-up; answer what undoes it sooner. */
    keep(undo: () => void): () => void
    /** True once the context was disposed: it then writes nothing. */
    disposed(): boolean
}

const noop = () => {}

/** `context.settings` for one extension. */
export function extensionSettings(id: string, manifest: ExtensionManifest, client: Pick<ClientServices, 'settings'>, life: ContextLifecycle): ExtensionSettings {
    return {
        get: (setting) => {
            const value = client.settings.get(extensionSettingKey(id, setting))
            const declared = manifest.settings?.find((candidate) => candidate.id === setting)
            if (declared?.type !== 'boolean') return value
            // A switch reads as on or off, whatever was stored: its default until it is set.
            return value === 'true' || value === 'false' ? value : String(declared.default ?? false)
        },
        subscribe: (listener) => (life.disposed() ? noop : life.keep(client.settings.subscribe(listener))),
        set(setting, value) {
            const declared = manifest.settings?.find((candidate) => candidate.id === setting)
            if (!declared) throw new Error(`The setting "${setting}" is not declared in the manifest of ${id}.`)
            if (declared.type === 'boolean' && value !== null && value !== 'true' && value !== 'false') {
                throw new Error(`The setting "${setting}" is a switch: set it to "true" or "false".`)
            }
            if (life.disposed()) return
            client.settings.set(extensionSettingKey(id, setting), value)
        },
    }
}

/** `context.personStorage` for one extension. */
export function extensionPersonStorage(id: string, client: Pick<ClientServices, 'settings'>, life: ContextLifecycle): ExtensionPersonStorage {
    /** The extension's own records kept with the person, by key, as last read: for `subscribe`. */
    const dataPrefix = extensionDataKey(id, '')
    const recordsNow = () => JSON.stringify(client.settings.keys(dataPrefix).map((key) => [key, client.settings.get(key)]))
    return {
        get<T>(key: string): T | undefined {
            const raw = client.settings.get(extensionDataKey(id, key))
            if (raw === undefined) return undefined
            try {
                return JSON.parse(raw) as T
            } catch {
                return undefined
            }
        },
        set(key, value) {
            if (!RECORD_KEY.test(key)) throw new Error(`A record's key is letters, digits, ".", "_" and "-", at most 100 of them, not "${key}".`)
            if (life.disposed()) return
            if (value === undefined || value === null) {
                client.settings.set(extensionDataKey(id, key), null)
                return
            }
            const json = JSON.stringify(value)
            if (json.length > RECORD_LIMIT) throw new Error(`The record "${key}" is longer than 64 KB as JSON.`)
            client.settings.set(extensionDataKey(id, key), json)
        },
        remove(key) {
            if (life.disposed() || !RECORD_KEY.test(key)) return
            client.settings.set(extensionDataKey(id, key), null)
        },
        subscribe(listener) {
            if (life.disposed()) return noop
            // The person's settings change for every extension and every setting: tell this
            // listener only when one of the extension's own records did.
            let last = recordsNow()
            return life.keep(
                client.settings.subscribe(() => {
                    const now = recordsNow()
                    if (now === last) return
                    last = now
                    listener()
                }),
            )
        },
    }
}
