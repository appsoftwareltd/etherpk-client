/**
 * Keeps the person's settings (person-settings.ts) in step with their account (ADR 0134). They go
 * into the account's Settings Vault (ADR 0148), sealed under the vault key that only the account's
 * own devices hold, so they follow the person to every device where they sync, and the Sync
 * Server holds them unreadable. They stay out of the Key Vault: an agent the person signs in with
 * the Headless Client reads the Key Vault, and the Sync Server never gives it the Settings Vault,
 * so the API keys among the person's settings never reach an agent.
 *
 * The account is the one that stands for this device (`primarySyncConnection`): the EtherPK account
 * when the device holds it, else the first server added. Settings sync once that account has a
 * vault, which it has from its first synced graph, and only while its Encryption Keys are unlocked
 * here. Until then they stay on the device, and what was changed here waits to be sent.
 *
 * A sync opens the Key Vault for the keys, reads the Settings Vault, merges (person-settings.ts
 * says how) and writes back only when the Settings Vault lacks something of this device's. One the
 * account has not got, or that this device cannot open, is written again from everything this
 * device holds. Settings an earlier version kept in the Key Vault are merged in, written to the
 * Settings Vault, and then taken out of the Key Vault. It runs as the Client starts, a moment after a change here,
 * when the window is focused again (at most once a minute), when the device comes back online and
 * when its Sync connections change. When the account ends here its settings leave the device.
 */
import { onAccountSignal } from '$lib/sync/account-signal'
import { readSyncAccount } from '$lib/sync/account-scope'
import { NoVaultError } from '$lib/sync/recovery-unlock'
import { updateSettingsVault } from '$lib/sync/settings-vault-update'
import type { SyncApi } from '$lib/sync/sync-api'
import { primarySyncConnection, syncApiFor } from '$lib/sync/sync-connection'
import { SYNC_CONNECTIONS_CHANGED_EVENT, SYNC_CONNECTIONS_STORAGE_KEY } from '$lib/sync/sync-connections'
import { getVaultWrapKey } from '$lib/sync/vault-session'
import { readVault, updateVault } from '$lib/sync/vault-update'

import { personSettings, readPersonSettings, type PersonSettings, type PersonSettingsRecord } from './person-settings'

/** Where the person's settings stand, for the note beside them. */
export type PersonSettingsSyncState =
    /** No account to sync with, or one with no vault yet: the settings stay on this device. */
    | 'device'
    /** The account's Encryption Keys are locked on this device, so its vault cannot be opened. */
    | 'locked'
    /** The first sync since the Client started has not finished. */
    | 'syncing'
    /** In step with the account as of the last sync. */
    | 'synced'
    /** The account could not be reached at the last try: changes made here wait. */
    | 'waiting'

/** The account the settings sync with. */
export interface PersonSettingsAccount {
    /** `<server origin> <account id>`: another account is another person's settings. */
    id: string
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'getSettingsVault' | 'putSettingsVault'>
    /** The key this device holds for the account's vault, or null while it is locked here. */
    heldKey: Uint8Array | null
}

export interface PersonSettingsSync {
    state(): PersonSettingsSyncState
    subscribe(listener: () => void): () => void
    /** Sync now. Resolves once this sync, and any asked for meanwhile, are done. Never rejects. */
    sync(): Promise<void>
}

export function createPersonSettingsSync(settings: PersonSettings, account: () => PersonSettingsAccount | null): PersonSettingsSync {
    const listeners = new Set<() => void>()
    /** How the last sync ended; null before the first has. */
    let settled: PersonSettingsSyncState | null = null
    let running: Promise<void> | null = null
    let again = false

    function settle(next: PersonSettingsSyncState): void {
        if (settled === next) return
        settled = next
        for (const listener of listeners) listener()
    }

    async function once(): Promise<void> {
        const target = account()
        if (!target) return settle('device')
        const { heldKey } = target
        if (!heldKey) return settle('locked')
        let given: PersonSettingsRecord = {}
        try {
            const keys = await readVault(target.api, heldKey)
            const signingPrivateKey = keys.opened.vault.signingPrivateKey
            // Every unlock gives a vault from before signing keys one (`ensureAccountIdentity`),
            // so this waits only until then.
            if (!signingPrivateKey) throw new Error('The account has no signing key yet.')
            // What an earlier version kept in the Key Vault (ADR 0134), on its way out.
            const moving = readPersonSettings(keys.opened.vault.settings)
            // `apply` runs again on a newer Settings Vault when another device wrote first, so
            // `given` is always what the Settings Vault written was given.
            const held = await updateSettingsVault(
                target.api,
                { principalId: keys.principalId, vaultKey: keys.opened.vaultKey, signingPrivateKey },
                {
                    apply: (current) => {
                        const theirs = current ? readPersonSettings(current.settings) : {}
                        const remote = later(theirs, moving)
                        const give = settings.merge(target.id, remote)
                        // None the account can open: write it again from all this device holds,
                        // which the merge has just brought up to date.
                        const next = current ? { ...remote, ...give } : settings.all()
                        given = current ? give : next
                        const changed = current ? !sameSettings(next, theirs) : Object.keys(next).length > 0
                        return changed ? { ...current, settings: next } : null
                    },
                },
            )
            settings.delivered(target.id, given)
            if (Object.keys(moving).length > 0) await takeOutOfKeyVault(target.api, heldKey, readPersonSettings(held?.settings))
            settle('synced')
        } catch (error) {
            // An account with no vault syncs no graph yet, so its settings stay on the device.
            settle(error instanceof NoVaultError ? 'device' : 'waiting')
        }
    }

    return {
        state() {
            if (settled) return settled
            const target = account()
            return !target ? 'device' : target.heldKey ? 'syncing' : 'locked'
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
        sync() {
            if (running) {
                again = true
                return running
            }
            running = (async () => {
                try {
                    do {
                        again = false
                        await once()
                    } while (again)
                } finally {
                    running = null
                }
            })()
            return running
        },
    }
}

/** `ours` with each setting from `theirs` that it lacks or that changed later there. */
function later(ours: PersonSettingsRecord, theirs: PersonSettingsRecord): PersonSettingsRecord {
    const out = { ...ours }
    for (const [key, setting] of Object.entries(theirs)) if (!out[key] || setting.changedAt > out[key].changedAt) out[key] = setting
    return out
}

function sameSettings(a: PersonSettingsRecord, b: PersonSettingsRecord): boolean {
    const keys = Object.keys(a)
    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => b[key] !== undefined && b[key].value === a[key].value && b[key].changedAt === a[key].changedAt)
    )
}

/**
 * Take out of the Key Vault the settings an earlier version kept there that the Settings Vault now
 * holds (`held`), as recent or more so. One changed in the Key Vault since it was read, by that
 * earlier version still open somewhere, stays until the next sync moves it too, so a setting is
 * never in neither vault.
 */
async function takeOutOfKeyVault(api: PersonSettingsAccount['api'], heldKey: Uint8Array, held: PersonSettingsRecord): Promise<void> {
    await updateVault(api, heldKey, {
        apply: (vault) => {
            if (!vault.settings) return null
            const left = Object.fromEntries(
                Object.entries(readPersonSettings(vault.settings)).filter(([key, setting]) => !held[key] || held[key].changedAt < setting.changedAt),
            )
            if (Object.keys(left).length === Object.keys(vault.settings).length) return null
            // An empty record is left out of the sealed vault altogether.
            return { ...vault, settings: left }
        },
    })
}

/** The account that stands for this device, if it is confirmed here. */
function primaryAccount(): PersonSettingsAccount | null {
    const connection = primarySyncConnection()
    if (!connection) return null
    const scope = readSyncAccount(connection.origin)
    if (!scope) return null
    return { id: `${scope.serverOrigin} ${scope.principalId}`, api: syncApiFor(connection), heldKey: getVaultWrapKey(connection.origin) }
}

let shared: PersonSettingsSync | null = null

/** This page's sync of the person's settings. */
export function personSettingsSync(): PersonSettingsSync {
    shared ??= createPersonSettingsSync(personSettings(), primaryAccount)
    return shared
}

/** How long after a change here it is sent, so typing a key sends it once. */
const CHANGE_DELAY_MS = 1_000
/** A focused window looks for other devices' changes at most this often. */
const FOCUS_INTERVAL_MS = 60_000

/** Keep the person's settings in step with their account while the Client runs. Returns the stop. */
export function startPersonSettingsSync(sync: PersonSettingsSync = personSettingsSync(), settings: PersonSettings = personSettings()): () => void {
    let lastFocusSync = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const now = () => void sync.sync()
    const onFocus = () => {
        if (Date.now() - lastFocusSync < FOCUS_INTERVAL_MS) return
        lastFocusSync = Date.now()
        now()
    }
    const onStorage = (event: StorageEvent) => {
        if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) now()
    }
    const stopChanges = settings.subscribe(() => {
        // A change another tab made is that tab's to send.
        if (!settings.hasPending()) return
        clearTimeout(timer)
        timer = setTimeout(now, CHANGE_DELAY_MS)
    })
    const stopSignals = onAccountSignal((signal) => {
        if (signal.type !== 'ended') return
        settings.accountEnded(signal.serverOrigin)
        now()
    })
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', now)
    window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, now)
    window.addEventListener('storage', onStorage)
    now()
    return () => {
        clearTimeout(timer)
        stopChanges()
        stopSignals()
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('online', now)
        window.removeEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, now)
        window.removeEventListener('storage', onStorage)
    }
}
