/**
 * Import to Sync+: the header button, shown while a folder graph is open on a Client that offers
 * Managed Sync, that copies the graph into a new synced graph. The button opens the Graphs page,
 * which holds the account, its keys and the import run, and the page opens the Import to Sync+
 * dialog for the graph. This module is what the dialog decides, apart from the markup:
 *
 * - {@link importToSyncPlusStep}: whether the graph can be imported now, and to which server, or
 *   whether the person first needs an account with Sync+.
 * - {@link createSyncPlusImportStore}: the import waiting while the person is away signing in or
 *   at Billing, and which folder graphs have already been copied from this browser, so the button
 *   is not offered for them again.
 */
import type { ServerAuthState } from '#lib/workspace/graph-picker-helpers.js'

/** The Graphs page address parameter that opens the dialog for a folder graph: `?import-to-sync-plus=<graph id>`. */
export const SYNC_PLUS_IMPORT_PARAM = 'import-to-sync-plus'

/** One Sync Server this device holds, as far as the step needs it. */
export interface SyncPlusServer {
    origin: string
    kind: 'managed' | 'custom'
    authState: ServerAuthState
    /** Why a new synced graph cannot go on this server now, or null when it can. */
    createBlockedReason: string | null
    /** The plan is still being confirmed, as after a return from Checkout. */
    planPending: boolean
    /** The account's Encryption Keys are unlocked on this device. */
    keysHeld: boolean
}

/**
 * - `import`: a server can take the graph now. `unlock` when its keys are locked here, so the
 *   button says so; the unlock itself runs from the press.
 * - `wait`: an account check or a plan's confirmation is still out.
 * - `offer`: nothing can take the graph, so the dialog offers the way to an account with Sync+
 *   (the Synced Graph panel's own buttons) or says what stands in the way.
 */
export type ImportToSyncPlusStep =
    | { kind: 'import'; origin: string; managed: boolean; unlock: boolean }
    | { kind: 'wait' }
    | { kind: 'offer' }

function canTake(server: SyncPlusServer): boolean {
    return server.authState === 'authenticated' && server.createBlockedReason === null
}

/**
 * The step for the servers this device holds. Managed Sync is the destination whenever it can
 * take the graph; a custom server is used only when Managed Sync cannot, so a device that holds
 * one is not sent to Billing for a graph it can already store.
 */
export function importToSyncPlusStep(servers: readonly SyncPlusServer[]): ImportToSyncPlusStep {
    const target = servers.find((server) => server.kind === 'managed' && canTake(server)) ?? servers.find(canTake)
    if (target) return { kind: 'import', origin: target.origin, managed: target.kind === 'managed', unlock: !target.keysHeld }
    if (servers.some((server) => server.authState === 'checking' || server.planPending)) return { kind: 'wait' }
    return { kind: 'offer' }
}

/** A refusal whose message is already written for the person: the dialog shows it as it is. */
export class SyncPlusImportRefusal extends Error {
    override name = 'SyncPlusImportRefusal'
}

/** An import the person started before leaving to sign in, register or start Sync+. */
export interface PendingSyncPlusImport {
    graphId: string
    name: string
    /** Epoch ms it was written. */
    at: number
}

/** A day: long enough for a sign-up with an email to verify, short enough not to surprise later. */
export const PENDING_SYNC_PLUS_IMPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000

const PENDING_KEY = 'etherpk:sync-plus-import-pending'
const COPIES_KEY = 'etherpk:sync-plus-copies'

interface KeyValueStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

function isPending(value: unknown): value is PendingSyncPlusImport {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    return typeof record.graphId === 'string' && typeof record.name === 'string' && typeof record.at === 'number'
}

/**
 * The two records, over localStorage in the app. Storage that refuses (private mode, quota) reads
 * as empty and drops writes: the button is then offered again, and a return from Billing opens the
 * Graphs page as any visit does, which is the worst either can do.
 */
export function createSyncPlusImportStore(storage: KeyValueStorage, now: () => number = Date.now) {
    function read(key: string): unknown {
        try {
            const raw = storage.getItem(key)
            return raw === null ? null : JSON.parse(raw)
        } catch {
            return null
        }
    }
    function write(key: string, value: unknown): void {
        try {
            storage.setItem(key, JSON.stringify(value))
        } catch {
            // Refused: see above.
        }
    }
    function remove(key: string): void {
        try {
            storage.removeItem(key)
        } catch {
            // Refused: see above.
        }
    }
    function copies(): Record<string, string> {
        const value = read(COPIES_KEY)
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, string>) : {}
    }

    return {
        pending(): PendingSyncPlusImport | null {
            const value = read(PENDING_KEY)
            if (!isPending(value)) return null
            if (now() - value.at > PENDING_SYNC_PLUS_IMPORT_MAX_AGE_MS) {
                remove(PENDING_KEY)
                return null
            }
            return value
        },
        setPending(pending: Omit<PendingSyncPlusImport, 'at'>): void {
            write(PENDING_KEY, { ...pending, at: now() })
        },
        clearPending(): void {
            remove(PENDING_KEY)
        },
        /** This folder graph has been imported to a synced graph from this browser. */
        copied(graphId: string): boolean {
            return typeof copies()[graphId] === 'string'
        },
        recordCopy(sourceGraphId: string, syncedGraphId: string): void {
            write(COPIES_KEY, { ...copies(), [sourceGraphId]: syncedGraphId })
        },
    }
}
