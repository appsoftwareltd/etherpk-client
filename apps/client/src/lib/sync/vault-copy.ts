/**
 * Opening a synced graph when its Sync Server cannot be reached (ADR 0141).
 *
 * The Local Cache holds every document's text on the device, but sealing an edit into the outbox
 * needs the graph's keyring, and the keyring lives in the account's vault on the server. So the
 * device keeps a copy of the vault as the server last sent it (`vault-session.ts`), and an open
 * that cannot reach the server reads the keyring from that copy instead.
 *
 * The server is always asked first. The copy is used only when the server gives no answer about
 * this account: the network failed, the server or the sign-in service failed (5xx), or, when a copy
 * is held, the server said nothing by the deadline. A refusal (401, 403, 404) is an answer that
 * access changed, and the copy never hides it. Nothing is written in that mode, so the copy can
 * open a graph whose key it holds and do nothing else.
 */
import { ManagedTokenError } from '$lib/auth/managed-token'
import { readSyncAccount } from './account-scope'
import { ensureGraphKeys, MissingGraphKeyError, type KeyBootstrapResult } from './keys'
import { SyncApiError, type SyncApi } from './sync-api'
import { forgetVaultCopy, keepVaultCopy, readVaultCopy } from './vault-session'

/** How long an open waits for the server's vault before it uses the copy, when one is held. */
export const VAULT_READ_DEADLINE_MS = 5_000

type VaultApi = Pick<SyncApi, 'getVault' | 'putKeys'>
type KeysApi = Pick<SyncApi, 'getVault' | 'putKeys' | 'me'>

/** The server had not answered by the deadline. The request carries on, and its answer is kept when it lands. */
export class SyncServerSilentError extends Error {
    constructor(readonly deadlineMs: number) {
        super(`the sync server did not answer within ${Math.round(deadlineMs / 1000)} seconds`)
        this.name = 'SyncServerSilentError'
    }
}

/**
 * True when `error` says the server gave no answer about this account, rather than an answer that
 * refused it. `fetch` rejects with a TypeError when the network fails, in every browser.
 */
export function isServerUnreachable(error: unknown): boolean {
    if (error instanceof SyncServerSilentError || error instanceof TypeError) return true
    if (error instanceof SyncApiError || error instanceof ManagedTokenError) return error.status >= 500
    return false
}

/**
 * `api`, keeping this device's copy of the vault current: every vault the server sends and every
 * vault this device writes is kept, and an answer that the account has no vault removes the copy.
 * Failures change nothing.
 */
export function keepingVaultCopy<T extends VaultApi>(api: T, origin: string): T {
    return {
        ...api,
        getVault: async () => {
            const stored = await api.getVault()
            if (!stored) forgetVaultCopy(origin)
            else keepVaultCopy(origin, { vault: stored.vault, version: stored.version, principalId: stored.principalId })
            return stored
        },
        putKeys: async (write: Parameters<SyncApi['putKeys']>[0]) => {
            const version = await api.putKeys(write)
            // The write is the vault this account now has: what the next read would send.
            const principalId = readSyncAccount(origin)?.principalId
            if (principalId) keepVaultCopy(origin, { vault: write.vault, version, principalId })
            return version
        },
    }
}

/**
 * `api`, reading this device's copy of the vault when the server cannot be reached, for a caller
 * that only reads what the vault holds, such as a graph's protection record (ADR 0057), so a
 * protected document unlocks with its passphrase offline. A refusal, or no copy, passes the
 * server's error on. Writes still go to the server, and fail there with no network.
 */
export function fallingBackToVaultCopy<T extends Pick<SyncApi, 'getVault'>>(api: T, origin: string): T {
    return {
        ...api,
        getVault: async () => {
            try {
                return await api.getVault()
            } catch (error) {
                const copy = isServerUnreachable(error) ? readVaultCopy(origin) : null
                if (!copy) throw error
                return copy
            }
        },
    }
}

export interface OpenedGraphKeys extends KeyBootstrapResult {
    /** True when the keyring came from the copy on this device, because the server could not be reached. */
    fromCopy: boolean
}

/**
 * `ensureGraphKeys` for opening an existing graph, falling back to this device's copy of the vault
 * when the server on `origin` cannot be reached. When the copy cannot open the graph (none is held,
 * it has no key for this graph, or it belongs to another account), the error is the server's, so
 * the person is told the server could not be reached, which is what they can act on.
 */
export async function openGraphKeys(
    api: KeysApi,
    graphId: string,
    origin: string,
    getWrapKey: () => Promise<Uint8Array>,
    options: { deadlineMs?: number } = {},
): Promise<OpenedGraphKeys> {
    const deadlineMs = options.deadlineMs ?? VAULT_READ_DEADLINE_MS
    // With no copy to fall back on, a slow server is still the only way in: wait for it, as before.
    const reading: KeysApi = readVaultCopy(origin) ? { ...api, getVault: () => withDeadline(api.getVault(), deadlineMs) } : api
    try {
        return { ...(await ensureGraphKeys(reading, graphId, getWrapKey)), fromCopy: false }
    } catch (error) {
        if (!isServerUnreachable(error)) throw error
        const copy = readVaultCopy(origin)
        if (!copy) throw error
        const fromCopy: KeysApi = {
            getVault: async () => copy,
            // Opening a graph whose key the vault holds writes nothing; anything else needs the server.
            putKeys: async () => {
                throw error
            },
            me: async () => {
                throw error
            },
        }
        try {
            return { ...(await ensureGraphKeys(fromCopy, graphId, getWrapKey)), fromCopy: true }
        } catch (copyError) {
            // The copy is older than the graph: only the server holds its key yet.
            if (copyError instanceof MissingGraphKeyError) throw error
            throw copyError
        }
    }
}

function withDeadline<T>(request: Promise<T>, deadlineMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SyncServerSilentError(deadlineMs)), deadlineMs)
    })
    return Promise.race([request, deadline]).finally(() => clearTimeout(timer))
}
