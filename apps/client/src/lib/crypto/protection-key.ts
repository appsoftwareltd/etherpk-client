/**
 * The Protection Key and its two wraps (ADR 0057).
 *
 * The key itself is random and is **never stored**. What a graph stores is a
 * {@link ProtectionRecord}: the non-secret fingerprint, the Argon2id cost parameters, and the key
 * wrapped under a key derived from the [[Protection Passphrase]]. That is the portable root — it
 * travels with the graph, so any device that knows the passphrase can reach the content.
 *
 * A second, optional wrap exists per device: {@link DeviceProtectionWrap}, keyed by a WebAuthn
 * passkey's PRF secret and held in device-local IndexedDB, **never synced and never exported**.
 * This is what keeps a synced passkey's provider outside the trust boundary — iCloud Keychain or
 * Google Password Manager replicate the PRF secret, but the blob it unwraps exists only on the
 * device that made it.
 *
 * Why Argon2id for one and plain HKDF for the other: a passphrase is human-chosen and attacked
 * offline (the wrapped blob travels in an Export), so it must be stretched by something
 * memory-hard. A PRF secret is 32 bytes of authenticator-derived entropy with nothing to guess,
 * which is the same reason `recovery-code.ts` correctly uses bare HKDF for a Recovery Code.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js'

import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'
import { contextAad, openSymmetric, sealSymmetric } from './envelope'
import { keyFingerprint } from './protection'

export const PROTECTION_RECORD_VERSION = 1
const PROTECTION_KEY_LENGTH = 32
const SALT_LENGTH = 16
const PASSPHRASE_AAD = contextAad('protection-key', 'passphrase')
const DEVICE_AAD = contextAad('protection-key', 'device')

/**
 * OWASP's Argon2id minimum. RFC 9106's first-choice profile (2 GiB) and second-choice profile
 * (64 MiB, t=3) are both out of reach for a pure-JS implementation in a browser — 64 MiB / t=3
 * measures ~2.4s on a desktop and several times that on a low-end phone, which would make the
 * idle lock punishing enough that people stop protecting documents.
 *
 * Stored per record, so raising them later costs nothing: an old record keeps opening with its
 * own parameters, and the next passphrase change re-wraps under the new ones.
 */
export const DEFAULT_KDF_PARAMS = { m: 19456, t: 2, p: 1 } as const

export interface ProtectionKdfParams {
    /** Argon2id memory cost in KiB. */
    m: number
    /** Argon2id time cost (iterations). */
    t: number
    /** Argon2id parallelism. */
    p: number
    /** base64url, unique per record — two graphs sharing a passphrase must not share a key. */
    salt: string
}

/** What a graph stores so a passphrase can reach its Protection Key. Holds no secret. */
export interface ProtectionRecord {
    v: typeof PROTECTION_RECORD_VERSION
    /** base64url of the key fingerprint — matches the `fp` in every fence written under it. */
    fingerprint: string
    kdf: ProtectionKdfParams
    /** base64url of the passphrase-wrapped Protection Key. */
    wrapped: string
}

/** A device-local wrap under a passkey's PRF secret. Never synced, never exported. */
export interface DeviceProtectionWrap {
    v: typeof PROTECTION_RECORD_VERSION
    fingerprint: string
    /** The WebAuthn credential whose PRF output unwraps this. */
    credentialId: string
    wrapped: string
}

export class ProtectionPassphraseError extends Error {
    constructor(message = 'that passphrase does not unlock this graph') {
        super(message)
        this.name = 'ProtectionPassphraseError'
    }
}

/** Bounds a record's Argon2id parameters must sit within to be used at all, in KiB and rounds. */
export const KDF_BOUNDS = { m: [8 * 1024, 1024 * 1024], t: [1, 32], p: [1, 16], saltBytes: [16, 64] } as const

/**
 * A record's parameters come from a file - `etherpk/protection.json` in an imported folder, or
 * a vault entry - and an unbounded record could name a memory cost that pins the tab, or one so
 * small that the passphrase wrap is cheap to attack. Outside these bounds the record is treated
 * as unreadable, never as instructions.
 */
export function kdfParamsSane(kdf: { m: number; t: number; p: number; salt: string }): boolean {
    const within = (value: number, [low, high]: readonly [number, number]) =>
        Number.isInteger(value) && value >= low && value <= high
    if (!within(kdf.m, KDF_BOUNDS.m) || !within(kdf.t, KDF_BOUNDS.t) || !within(kdf.p, KDF_BOUNDS.p)) return false
    try {
        return within(fromBase64Url(kdf.salt).length, KDF_BOUNDS.saltBytes)
    } catch {
        return false
    }
}

export function newKdfParams(): ProtectionKdfParams {
    return { ...DEFAULT_KDF_PARAMS, salt: toBase64Url(randomBytes(SALT_LENGTH)) }
}

export function createProtectionKey(): Uint8Array {
    return randomBytes(PROTECTION_KEY_LENGTH)
}

/**
 * Stretch a passphrase into a wrapping key. `asyncTick` lets the worker yield between Argon2id
 * blocks so a slow unlock cannot freeze the thread it runs on.
 */
async function deriveWrapKey(passphrase: string, kdf: ProtectionKdfParams): Promise<Uint8Array> {
    return argon2idAsync(utf8(passphrase), fromBase64Url(kdf.salt), {
        t: kdf.t,
        m: kdf.m,
        p: kdf.p,
        dkLen: PROTECTION_KEY_LENGTH,
        asyncTick: 20,
    })
}

async function wrap(key: Uint8Array, wrapKey: Uint8Array, aad: Uint8Array): Promise<string> {
    return toBase64Url(await sealSymmetric({ key: wrapKey, epochId: 0, plaintext: key, aad }))
}

async function unwrap(wrapped: string, wrapKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    try {
        const { plaintext } = await openSymmetric({
            keyForEpoch: () => wrapKey,
            envelope: fromBase64Url(wrapped),
            aad,
        })
        return plaintext
    } catch {
        throw new ProtectionPassphraseError()
    }
}

/**
 * Mint a protection record. Pass `existingKey` to re-root an existing key under a new passphrase —
 * that is how a device holding only a passkey wrap recovers from a forgotten passphrase without
 * re-encrypting a single document.
 */
export async function createProtectionRecord(
    passphrase: string,
    kdf: ProtectionKdfParams = newKdfParams(),
    existingKey?: Uint8Array,
): Promise<{ record: ProtectionRecord; key: Uint8Array }> {
    const key = existingKey ?? createProtectionKey()
    const wrapKey = await deriveWrapKey(passphrase, kdf)
    return {
        key,
        record: {
            v: PROTECTION_RECORD_VERSION,
            fingerprint: toBase64Url(await keyFingerprint(key)),
            kdf,
            wrapped: await wrap(key, wrapKey, PASSPHRASE_AAD),
        },
    }
}

export async function unlockProtectionRecord(record: ProtectionRecord, passphrase: string): Promise<Uint8Array> {
    return unwrap(record.wrapped, await deriveWrapKey(passphrase, record.kdf), PASSPHRASE_AAD)
}

/**
 * Re-wrap under a new passphrase. The Protection Key is unchanged, so no protected document is
 * touched and every fence already written stays readable — the same shape as regenerating a
 * Recovery Code. A fresh salt and fresh parameters are minted so the old blob gives no help
 * against the new one.
 */
export async function changeProtectionPassphrase(
    record: ProtectionRecord,
    current: string,
    next: string,
    kdf: ProtectionKdfParams = newKdfParams(),
): Promise<ProtectionRecord> {
    const key = await unlockProtectionRecord(record, current)
    return (await createProtectionRecord(next, kdf, key)).record
}

export async function deviceWrapFromPrf(
    key: Uint8Array,
    prfSecret: Uint8Array,
    credentialId: string,
): Promise<DeviceProtectionWrap> {
    return {
        v: PROTECTION_RECORD_VERSION,
        fingerprint: toBase64Url(await keyFingerprint(key)),
        credentialId,
        wrapped: await wrap(key, await derivePrfWrapKey(prfSecret), DEVICE_AAD),
    }
}

export async function unlockWithDeviceWrap(wrapRecord: DeviceProtectionWrap, prfSecret: Uint8Array): Promise<Uint8Array> {
    return unwrap(wrapRecord.wrapped, await derivePrfWrapKey(prfSecret), DEVICE_AAD)
}

/** HKDF over the PRF secret — no stretching needed, it is already high-entropy. */
async function derivePrfWrapKey(prfSecret: Uint8Array): Promise<Uint8Array> {
    const ikm = await crypto.subtle.importKey('raw', prfSecret as BufferSource, 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: utf8('etherpk-protection-device-v1') as BufferSource,
            info: utf8('protection-device-wrap') as BufferSource,
        },
        ikm,
        PROTECTION_KEY_LENGTH * 8,
    )
    return new Uint8Array(bits)
}

export function serialiseProtectionRecord(record: ProtectionRecord): string {
    return JSON.stringify(record)
}

/**
 * Why stored text is not a usable record. Two kinds, because they want different advice: a
 * `damaged` record wants restoring from a backup, a `newer-version` one wants this build updated -
 * telling someone to restore a backup over a perfectly good record would be the very mistake the
 * distinction exists to prevent.
 */
export type ProtectionRecordProblem = 'damaged' | 'newer-version'

/** Stored text, or a vault entry, that is not a record this build can use. Never "no record". */
export class ProtectionRecordFormatError extends Error {
    constructor(
        readonly problem: ProtectionRecordProblem,
        detail: string,
    ) {
        super(detail)
        this.name = 'ProtectionRecordFormatError'
    }
}

/**
 * Parse the JSON a store holds. Anything that is not a usable record throws - a mangled file, an
 * empty one, a record from a newer build, parameters outside {@link KDF_BOUNDS} - and is never
 * read as "no record". Read as absent, it would let enabling protection write a fresh key over a
 * record it could not read, orphaning every fence sealed under the old one, which no passphrase
 * or Recovery Code brings back (ADR 0057). Whether any bytes existed at all is the store's call,
 * not the parser's.
 */
export function parseProtectionRecord(text: string): ProtectionRecord {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (error) {
        throw new ProtectionRecordFormatError('damaged', `not JSON: ${(error as Error).message}`)
    }
    return validateProtectionRecord(parsed)
}

/**
 * The same check over a value that is already parsed - a vault entry, which arrives as an object
 * inside the decrypted vault rather than as text of its own. Only the fields a record has are
 * kept, so whatever else a stored copy carried does not travel on.
 */
export function validateProtectionRecord(value: unknown): ProtectionRecord {
    const damaged = (detail: string) => new ProtectionRecordFormatError('damaged', detail)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw damaged('not a record object')
    const raw = value as Record<string, unknown>
    if (raw.v !== PROTECTION_RECORD_VERSION) {
        // A whole number above ours was written by a build after this one. Anything else was
        // never written by any build, so it is damage rather than the future.
        if (typeof raw.v === 'number' && Number.isInteger(raw.v) && raw.v > PROTECTION_RECORD_VERSION) {
            throw new ProtectionRecordFormatError(
                'newer-version',
                `record version ${raw.v}; this build reads version ${PROTECTION_RECORD_VERSION}`,
            )
        }
        throw damaged(`record version ${String(raw.v)} is not ${PROTECTION_RECORD_VERSION}`)
    }
    if (typeof raw.fingerprint !== 'string' || typeof raw.wrapped !== 'string') throw damaged('fingerprint or wrapped key missing')
    const kdf = raw.kdf as Partial<ProtectionKdfParams> | null | undefined
    if (!kdf || typeof kdf !== 'object') throw damaged('KDF parameters missing')
    if (typeof kdf.m !== 'number' || typeof kdf.t !== 'number' || typeof kdf.p !== 'number' || typeof kdf.salt !== 'string') {
        throw damaged('KDF parameters missing')
    }
    const params: ProtectionKdfParams = { m: kdf.m, t: kdf.t, p: kdf.p, salt: kdf.salt }
    if (!kdfParamsSane(params)) throw damaged('KDF parameters outside the bounds this build will run')
    return { v: PROTECTION_RECORD_VERSION, fingerprint: raw.fingerprint, wrapped: raw.wrapped, kdf: params }
}
