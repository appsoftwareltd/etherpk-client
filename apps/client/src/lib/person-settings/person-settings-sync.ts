/**
 * Keeps the person's settings (person-settings.ts) in step with their account (ADR 0134). They go
 * into the account's vault, which only the account's own devices can open, so they follow the
 * person to every device where they sync, and the Sync Server holds them unreadable.
 *
 * The account is the one that stands for this device (`primarySyncConnection`): the EtherPK account
 * when the device holds it, else the first server added. Settings sync once that account has a
 * vault, which it has from its first synced graph, and only while its Encryption Keys are unlocked
 * here. Until then they stay on the device, and what was changed here waits to be sent.
 *
 * A sync reads the vault, merges (person-settings.ts says how) and writes back only when the vault
 * lacks something of this device's. It runs as the Client starts, a moment after a change here,
 * when the window is focused again (at most once a minute), when the device comes back online and
 * when its Sync connections change. When the account ends here its settings leave the device.
 */
import { onAccountSignal } from '$lib/sync/account-signal'
import { readSyncAccount } from '$lib/sync/account-scope'
import { NoVaultError } from '$lib/sync/recovery-unlock'
import type { SyncApi } from '$lib/sync/sync-api'
import { primarySyncConnection, syncApiFor } from '$lib/sync/sync-connection'
import { SYNC_CONNECTIONS_CHANGED_EVENT, SYNC_CONNECTIONS_STORAGE_KEY } from '$lib/sync/sync-connections'
import { getVaultWrapKey } from '$lib/sync/vault-session'
import { updateVault } from '$lib/sync/vault-update'

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
    api: Pick<SyncApi, 'getVault' | 'putKeys'>
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
        let give: PersonSettingsRecord = {}
        try {
            // `apply` runs again on a newer vault when another device wrote first, so `give` is
            // always what the vault written was given.
            await updateVault(target.api, heldKey, {
                apply: (vault) => {
                    give = settings.merge(target.id, readPersonSettings(vault.settings))
                    return Object.keys(give).length === 0 ? null : { ...vault, settings: { ...vault.settings, ...give } }
                },
            })
            settings.delivered(target.id, give)
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
