/**
 * Per-device passkey unlock for a graph's Protection Key (ADR 0057).
 *
 * A WebAuthn credential created with the **PRF extension** can derive a stable secret from a
 * caller-supplied salt, gated behind user verification (biometric or device PIN). We wrap the
 * Protection Key under that secret and keep the wrap in device-local IndexedDB.
 *
 * The crucial property, and the reason PRF is a *wrap* rather than the root: a synced passkey
 * replicates through iCloud Keychain or Google Password Manager, so the PRF secret replicates
 * with it. If that secret were the root, the confidentiality of protected documents would inherit the
 * security of a Google or Apple account and its recovery factors. Because the wrapped blob lives
 * only on the device that made it and is **never synced or exported**, those providers hold a
 * secret that unwraps nothing they possess.
 *
 * The salt is fixed and graph-scoped rather than random: the same credential must derive the same
 * secret on every unlock, and a per-graph salt keeps two graphs on one device from sharing a
 * derived secret.
 */
import type { DeviceProtectionWrap } from '$lib/crypto'
import { deviceWrapFromPrf, unlockWithDeviceWrap } from '$lib/crypto'
import { createReopenableConnection, type ReopenableConnection } from '$lib/storage/idb-connection'
import { createSafetyCopy, type SafetyCopy } from '$lib/storage/safety-copy'
import { reportStorageRecovery } from '$lib/storage/storage-recovery'

const DB_NAME = 'etherpk-protection'
const DB_VERSION = 1
const STORE = 'device-wraps'

/** The PRF salt for one graph. Fixed, so the derived secret is stable across unlocks. */
export function prfSalt(graphId: string): Uint8Array {
    return new TextEncoder().encode(`etherpk:protection-prf:v1:${graphId}`)
}

/** Whether this browser can do WebAuthn at all. PRF support is only knowable after a create. */
export function passkeysAvailable(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.credentials && typeof PublicKeyCredential !== 'undefined'
}

export class PasskeyUnsupportedError extends Error {
    constructor(message = 'this device cannot bind a passkey to your protected documents') {
        super(message)
        this.name = 'PasskeyUnsupportedError'
    }
}

interface PrfExtensionResults {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

/**
 * Read the PRF output from a WebAuthn assertion. Returns null when the authenticator did not
 * produce one, which is how an unsupported platform announces itself - there is no capability
 * query that answers this before the ceremony.
 */
export function prfSecretOf(credential: PublicKeyCredential | null): Uint8Array | null {
    const results = credential?.getClientExtensionResults() as PrfExtensionResults | undefined
    const first = results?.prf?.results?.first
    return first ? new Uint8Array(first) : null
}

/** Whether a freshly created credential reported PRF as available. */
export function prfEnabledOn(credential: PublicKeyCredential | null): boolean {
    const results = credential?.getClientExtensionResults() as PrfExtensionResults | undefined
    return results?.prf?.enabled === true
}

export interface PasskeyCeremony {
    /** Create a credential for this graph, returning it so PRF availability can be read. */
    create(graphId: string): Promise<PublicKeyCredential | null>
    /** Assert an existing credential, evaluating PRF against the graph's salt. */
    assert(graphId: string, credentialId: string): Promise<PublicKeyCredential | null>
}

/**
 * The real WebAuthn ceremonies. Split out so the enrol / unlock logic is testable without them.
 *
 * The availability check lives here rather than in {@link enrolPasskey}: supplying a ceremony is
 * itself the assertion that one works, and hoisting the check would make every injected ceremony
 * fail on a platform without `navigator.credentials` — including Node, where the logic is tested.
 */
export const webAuthnCeremony: PasskeyCeremony = {
    async create(graphId) {
        if (!passkeysAvailable()) throw new PasskeyUnsupportedError()
        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const userId = crypto.getRandomValues(new Uint8Array(16))
        return (await navigator.credentials.create({
            publicKey: {
                challenge: challenge as BufferSource,
                rp: { name: 'EtherPK', id: location.hostname },
                user: { id: userId as BufferSource, name: `protection:${graphId}`, displayName: 'Protected documents' },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 },
                ],
                authenticatorSelection: {
                    // The whole point is a biometric or PIN gate; without user verification a
                    // stolen unlocked device would unwrap the key by itself.
                    userVerification: 'required',
                    residentKey: 'preferred',
                },
                // `eval` at creation is honoured by some platforms and ignored by others; the
                // enrol flow asserts afterwards regardless, so this is an optimisation only.
                extensions: { prf: { eval: { first: prfSalt(graphId) as BufferSource } } },
            },
        })) as PublicKeyCredential | null
    },

    async assert(graphId, credentialId) {
        if (!passkeysAvailable()) throw new PasskeyUnsupportedError()
        const challenge = crypto.getRandomValues(new Uint8Array(32))
        return (await navigator.credentials.get({
            publicKey: {
                challenge: challenge as BufferSource,
                userVerification: 'required',
                allowCredentials: [{ type: 'public-key', id: decodeCredentialId(credentialId) as BufferSource }],
                extensions: { prf: { eval: { first: prfSalt(graphId) as BufferSource } } },
            },
        })) as PublicKeyCredential | null
    },
}

export function encodeCredentialId(raw: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(raw)))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
}

export function decodeCredentialId(id: string): Uint8Array {
    const raw = atob(id.replaceAll('-', '+').replaceAll('_', '/'))
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
}

/** Device-local storage for the passkey wraps. Never synced, never exported. */
export interface DeviceWrapStore {
    read(graphId: string): Promise<DeviceProtectionWrap | null>
    write(graphId: string, wrap: DeviceProtectionWrap): Promise<void>
    clear(graphId: string): Promise<void>
}

let connection: ReopenableConnection | null = null

async function db(): Promise<ReopenableConnection> {
    connection ??= await createReopenableConnection(
        () =>
            new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION)
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
                }
                request.onsuccess = () => resolve(request.result)
                request.onerror = () => reject(request.error ?? new Error('could not open the protection database'))
            }),
    )
    return connection
}

/**
 * Settle once a transaction has committed, or reject with why it did not. A request's own
 * `onsuccess` fires before the transaction is durable: a put can succeed and its transaction
 * still abort - quota, a connection the browser is closing - and nothing would have said so.
 */
function committed(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('the protection database could not be written'))
        tx.onabort = () => reject(tx.error ?? new Error('the protection database write was abandoned'))
    })
}

const rawIndexedDbWrapStore: DeviceWrapStore = {
    async read(graphId) {
        const tx = await (await db()).transaction(STORE, 'readonly')
        return new Promise((resolve) => {
            const request = tx.objectStore(STORE).get(graphId)
            request.onsuccess = () => resolve((request.result as DeviceProtectionWrap | undefined) ?? null)
            // A missing or unreadable wrap is not an error the user can act on — it simply means
            // this device has no passkey bound, and the passphrase route is still there.
            request.onerror = () => resolve(null)
        })
    },
    async write(graphId, wrap) {
        const tx = await (await db()).transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(wrap, graphId)
        // Settled on commit, not on the request. The settings tab reports "this device can now
        // unlock with its passkey" on this promise, and a put whose transaction failed afterwards
        // made that a lie with no wrap behind it - the next unlock then offered no passkey at all.
        await committed(tx)
    },
    async clear(graphId) {
        const tx = await (await db()).transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(graphId)
        await committed(tx)
    },
}

/** A wrap as stored, or null for anything else - the copy is `localStorage`, so it is validated, not trusted. */
export function recoverableDeviceWrap(value: unknown): DeviceProtectionWrap | null {
    if (typeof value !== 'object' || value === null) return null
    const wrap = value as Partial<DeviceProtectionWrap>
    if (wrap.v !== 1) return null
    if (typeof wrap.fingerprint !== 'string' || typeof wrap.credentialId !== 'string' || typeof wrap.wrapped !== 'string') {
        return null
    }
    return { v: wrap.v, fingerprint: wrap.fingerprint, credentialId: wrap.credentialId, wrapped: wrap.wrapped }
}

/**
 * Keep every wrap in a `localStorage` safety copy as well, and heal the primary from it on a
 * miss. A phone that loses its IndexedDB (`$lib/storage/safety-copy.ts` says how) used to lose
 * every passkey binding with it, and the person had to enrol again on a device that had done
 * nothing wrong. The copy is the same ciphertext under the same PRF-derived key, on the same
 * device, so nothing ADR 0057 protects moves: what unwraps it still never leaves the
 * authenticator.
 */
export function withWrapSafetyCopy(
    primary: DeviceWrapStore,
    copy: SafetyCopy<DeviceProtectionWrap>,
    report: (graphId: string) => void,
): DeviceWrapStore {
    return {
        async read(graphId) {
            const held = await primary.read(graphId)
            if (held) {
                const kept = copy.read(graphId)
                if (!kept || JSON.stringify(kept) !== JSON.stringify(held)) copy.write(graphId, held)
                return held
            }
            const kept = copy.read(graphId)
            if (!kept) return null
            try {
                await primary.write(graphId, kept)
            } catch (error) {
                // The unlock still works from the copy; the next read tries the write again.
                console.warn('[protection] could not write a restored passkey wrap back to IndexedDB', error)
            }
            report(graphId)
            return kept
        },
        async write(graphId, wrap) {
            await primary.write(graphId, wrap)
            copy.write(graphId, wrap)
        },
        async clear(graphId) {
            // Copy first, so a failed primary delete cannot leave a copy to restore an unbound passkey.
            copy.remove(graphId)
            await primary.clear(graphId)
        },
    }
}

export const indexedDbWrapStore: DeviceWrapStore = withWrapSafetyCopy(
    rawIndexedDbWrapStore,
    createSafetyCopy('passkey-wraps', recoverableDeviceWrap),
    (graphId) => reportStorageRecovery({ kind: 'passkeys', restored: [graphId] }),
)

export interface PasskeyProtectionDeps {
    ceremony?: PasskeyCeremony
    store?: DeviceWrapStore
}

/**
 * Bind a passkey on this device to the graph's Protection Key. Requires the key in memory, which
 * is why enrolment is only offered while unlocked.
 */
export async function enrolPasskey(
    graphId: string,
    protectionKey: Uint8Array,
    deps: PasskeyProtectionDeps = {},
): Promise<DeviceProtectionWrap> {
    const ceremony = deps.ceremony ?? webAuthnCeremony
    const store = deps.store ?? indexedDbWrapStore

    const created = await ceremony.create(graphId)
    if (!created) throw new PasskeyUnsupportedError('the passkey was not created')
    const credentialId = encodeCredentialId(created.rawId)

    // Read the secret from an assertion rather than from creation: `prf.eval` at creation time is
    // honoured inconsistently, and a wrap built from a secret we cannot reproduce on unlock would
    // be worse than no wrap at all.
    const secret = prfSecretOf(await ceremony.assert(graphId, credentialId))
    if (!secret) {
        throw new PasskeyUnsupportedError(
            'this passkey cannot derive an encryption secret (its authenticator has no PRF support), so it cannot unlock protected documents',
        )
    }

    const wrap = await deviceWrapFromPrf(protectionKey, secret, credentialId)
    await store.write(graphId, wrap)
    return wrap
}

/** Whether this device has a passkey bound for the graph, and it matches the current key. */
export async function boundPasskey(
    graphId: string,
    fingerprint: string | null,
    deps: PasskeyProtectionDeps = {},
): Promise<DeviceProtectionWrap | null> {
    const wrap = await (deps.store ?? indexedDbWrapStore).read(graphId)
    if (!wrap) return null
    // A wrap for a key the graph no longer uses is stale — it would unwrap to something that
    // decrypts nothing. Treat it as absent so the user is offered the passphrase instead.
    return fingerprint !== null && wrap.fingerprint !== fingerprint ? null : wrap
}

/** Unlock from this device's bound passkey. Throws when there is none, or the ceremony fails. */
export async function unlockWithPasskey(
    graphId: string,
    fingerprint: string | null,
    deps: PasskeyProtectionDeps = {},
): Promise<Uint8Array> {
    const wrap = await boundPasskey(graphId, fingerprint, deps)
    if (!wrap) throw new PasskeyUnsupportedError('no passkey is bound to this graph on this device')
    const secret = prfSecretOf(await (deps.ceremony ?? webAuthnCeremony).assert(graphId, wrap.credentialId))
    if (!secret) throw new PasskeyUnsupportedError('the passkey did not produce its encryption secret')
    return unlockWithDeviceWrap(wrap, secret)
}
