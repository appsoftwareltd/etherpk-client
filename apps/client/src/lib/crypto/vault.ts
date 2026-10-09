/**
 * The key vault (ADR 0026): everything a device needs - the Sync Identity, every graph keyring,
 * protection records and Pinned Identities - as one envelope. Stored server-side as an opaque blob;
 * losing local storage is harmless.
 *
 * The vault content is encrypted under a random VAULT KEY, and the vault key travels alongside,
 * wrapped under the Recovery-Code-derived wrap key:
 *
 *   [0]      version = 1 (envelope family)
 *   [1]      kind    = 5 (vault container v3; 3 is v2)
 *   [2..3]   u16 BE - byte length of the wrapped-vault-key envelope
 *   [4..]    wrapped vault key (symmetric envelope under the WRAP key, aad 'vault-key')
 *   [rest]   vault content (symmetric envelope under the VAULT key, aad 'vault|v3'; v2 used 'vault')
 *
 * The indirection is what device approval hands to a new device (the vault key, never the code),
 * and it makes Regenerate Recovery Code a re-WRAP: the vault key - the thing every unlocked device
 * caches - survives, so other devices stay unlocked.
 *
 * Format v3 (ADR 0126) has the v2 layout and adds the signing key pair and the pins to the
 * content. It has its own kind and its own content context because Clients before it dropped every
 * field they did not know when they wrote the vault back, which would have deleted pins and signing
 * keys. Such a Client cannot open v3 at all, even with the kind byte changed back, so it fails
 * closed until it reloads. This version keeps every top-level field it does not know
 * (`otherFields`), so the next format change does not need a new kind for the same reason.
 *
 * v2 and legacy (phase 1, the content directly under the wrap key) blobs still open, and any
 * write upgrades them to v3 - a legacy blob with a freshly minted vault key.
 */
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'
import { ENVELOPE_VERSION, EnvelopeError, KIND_SYMMETRIC, contextAad, openSymmetric, sealSymmetric } from './envelope'
import { type GraphKeyring, deserializeKeyrings, serializeKeyrings } from './keyring'
import type { ProtectionRecord } from './protection-key'

/**
 * A person whose Security Fingerprint this account has confirmed, or taken on first use for a
 * member who joined before pins existed: a Pinned Identity (ADR 0126). Kept in the vault, keyed by
 * that person's account id on the vault's Sync Server, so every device of the account knows it.
 * Stored as plain JSON and written back as read, so a field a later version adds survives.
 */
export interface PinnedIdentity {
    /** X25519 public key, base64url. */
    publicKey: string
    /** Ed25519 public key, base64url. */
    signingPublicKey: string
    /** The address the server gave for them when the pin was made: a label, never what is trusted. */
    email: string
    /** When the pin was made, as an ISO 8601 timestamp. */
    pinnedAt: string
    /** True once the user compared fingerprints; false for a pin only taken on first use. */
    verified: boolean
}

/**
 * One of the person's settings as the vault keeps it (ADR 0134): its value, or null once cleared,
 * and when it was changed, in milliseconds since 1970, which decides between two devices.
 */
export interface VaultSetting {
    value: string | null
    changedAt: number
}

export interface KeyVault {
    identityPrivateKey: Uint8Array
    identityPublicKey: Uint8Array
    /**
     * The Ed25519 half of the Sync Identity (ADR 0126). Absent only from a vault written before
     * signing keys existed: the next unlock adds one (`ensureAccountIdentity`).
     */
    signingPrivateKey?: Uint8Array
    signingPublicKey?: Uint8Array
    keyrings: GraphKeyring[]
    /**
     * Protection records by graph id (ADR 0057), for graphs on a Server Backend. Personal, never
     * shared with Players — which is why they live here and not in the graph's encrypted *shared*
     * metadata (ADR 0031), where every Player would hold the blob and could attack the passphrase
     * offline. A Filesystem Backend graph has no vault and keeps its record in `etherpk/` instead.
     *
     * Nesting is deliberate and load-bearing: the record holds only a passphrase-wrapped key, so
     * reaching the vault — which a cached wrap key in `localStorage` does — still does not reach
     * protected content.
     */
    protection?: Record<string, ProtectionRecord>
    /** Pinned Identities by account id (ADR 0126). */
    pins?: Record<string, PinnedIdentity>
    /**
     * The person's settings by key (ADR 0134), Extension Settings among them, so they follow the
     * person to every device of the account. Written back as read, like the pins.
     */
    settings?: Record<string, VaultSetting>
    /** Top-level fields this version does not know, written back unchanged. */
    otherFields?: Record<string, unknown>
}

export const KIND_VAULT_V2 = 3
export const KIND_VAULT_V3 = 5
const VAULT_V2_AAD = contextAad('vault')
const VAULT_V3_AAD = contextAad('vault', 'v3')
const VAULT_KEY_AAD = contextAad('vault-key')
const CONTAINER_HEADER = 4

/** The fields this version reads. Everything else in the content is kept as `otherFields`. */
const KNOWN_FIELDS = [
    'identityPrivateKey',
    'identityPublicKey',
    'signingPrivateKey',
    'signingPublicKey',
    'keyrings',
    'protection',
    'pins',
    'settings',
] as const

interface VaultJson {
    identityPrivateKey: string
    identityPublicKey: string
    /** Absent in every vault written before ADR 0126. */
    signingPrivateKey?: string
    signingPublicKey?: string
    keyrings: string
    /** Absent in every vault written before protection existed — read as "no protected graphs". */
    protection?: Record<string, ProtectionRecord>
    pins?: Record<string, PinnedIdentity>
    settings?: Record<string, VaultSetting>
}

export interface EncryptedVault {
    envelope: Uint8Array
    /** The key the device caches — it opens the vault content directly. */
    vaultKey: Uint8Array
}

export interface OpenedVault {
    vault: KeyVault
    /** The key that decrypts the vault content — cache THIS on the device. */
    vaultKey: Uint8Array
    /** True for a phase-1 blob (no indirection); the opening key was the wrap key itself. */
    legacy: boolean
}

const nonEmpty = <T extends object>(value: T | undefined): value is T => value !== undefined && Object.keys(value).length > 0

async function sealContent(vault: KeyVault, vaultKey: Uint8Array): Promise<Uint8Array> {
    const json: VaultJson = {
        identityPrivateKey: toBase64Url(vault.identityPrivateKey),
        identityPublicKey: toBase64Url(vault.identityPublicKey),
        ...(vault.signingPrivateKey && vault.signingPublicKey
            ? { signingPrivateKey: toBase64Url(vault.signingPrivateKey), signingPublicKey: toBase64Url(vault.signingPublicKey) }
            : {}),
        keyrings: new TextDecoder().decode(serializeKeyrings(vault.keyrings)),
        // Omitted when empty, so a vault holding no protected graph or pin says nothing about them.
        ...(nonEmpty(vault.protection) ? { protection: vault.protection } : {}),
        ...(nonEmpty(vault.pins) ? { pins: vault.pins } : {}),
        ...(nonEmpty(vault.settings) ? { settings: vault.settings } : {}),
    }
    // Known fields are written last, so an unknown field can never shadow one.
    const content = { ...vault.otherFields, ...json }
    return sealSymmetric({ key: vaultKey, epochId: 0, plaintext: utf8(JSON.stringify(content)), aad: VAULT_V3_AAD })
}

async function openContent(envelope: Uint8Array, vaultKey: Uint8Array, aad: Uint8Array): Promise<KeyVault> {
    const { plaintext } = await openSymmetric({ keyForEpoch: () => vaultKey, envelope, aad })
    const content = JSON.parse(new TextDecoder().decode(plaintext)) as VaultJson & Record<string, unknown>
    const otherFields: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(content)) {
        if (!(KNOWN_FIELDS as readonly string[]).includes(field)) otherFields[field] = value
    }
    return {
        identityPrivateKey: fromBase64Url(content.identityPrivateKey),
        identityPublicKey: fromBase64Url(content.identityPublicKey),
        ...(content.signingPrivateKey && content.signingPublicKey
            ? { signingPrivateKey: fromBase64Url(content.signingPrivateKey), signingPublicKey: fromBase64Url(content.signingPublicKey) }
            : {}),
        keyrings: deserializeKeyrings(utf8(content.keyrings)),
        ...(content.protection ? { protection: content.protection } : {}),
        ...(content.pins ? { pins: content.pins } : {}),
        ...(content.settings ? { settings: content.settings } : {}),
        ...(Object.keys(otherFields).length > 0 ? { otherFields } : {}),
    }
}

function buildContainer(wrapped: Uint8Array, content: Uint8Array): Uint8Array {
    const out = new Uint8Array(CONTAINER_HEADER + wrapped.length + content.length)
    out[0] = ENVELOPE_VERSION
    out[1] = KIND_VAULT_V3
    new DataView(out.buffer).setUint16(2, wrapped.length, false)
    out.set(wrapped, CONTAINER_HEADER)
    out.set(content, CONTAINER_HEADER + wrapped.length)
    return out
}

function splitContainer(envelope: Uint8Array): { wrapped: Uint8Array; content: Uint8Array } {
    if (envelope.length < CONTAINER_HEADER) throw new EnvelopeError('vault container too short')
    const wrappedLength = new DataView(envelope.buffer, envelope.byteOffset).getUint16(2, false)
    if (envelope.length < CONTAINER_HEADER + wrappedLength) throw new EnvelopeError('vault container truncated')
    return {
        wrapped: envelope.subarray(CONTAINER_HEADER, CONTAINER_HEADER + wrappedLength),
        content: envelope.subarray(CONTAINER_HEADER + wrappedLength),
    }
}

/** The content context of a v2 or v3 container, or null for anything else. */
function containerContentAad(envelope: Uint8Array): Uint8Array | null {
    if (envelope.length < 2 || envelope[0] !== ENVELOPE_VERSION) return null
    if (envelope[1] === KIND_VAULT_V3) return VAULT_V3_AAD
    if (envelope[1] === KIND_VAULT_V2) return VAULT_V2_AAD
    return null
}

/**
 * Encrypt a vault under `wrapKey` (v3). Pass `vaultKey` to preserve an existing vault key —
 * a Recovery Code regenerate re-wraps without invalidating other devices' cached keys; omit
 * it to mint a fresh one (new account, or upgrading a legacy blob).
 */
export async function encryptVault(vault: KeyVault, wrapKey: Uint8Array, vaultKey?: Uint8Array): Promise<EncryptedVault> {
    const key = vaultKey ?? randomBytes(32)
    const wrapped = await sealSymmetric({ key: wrapKey, epochId: 0, plaintext: key, aad: VAULT_KEY_AAD })
    return { envelope: buildContainer(wrapped, await sealContent(vault, key)), vaultKey: key }
}

/**
 * Open a vault with whatever key the device holds: the Recovery-Code-derived wrap key
 * (legacy, v2 or v3), or the vault key itself (v2 or v3 — the device-approval / cached case).
 */
export async function openVault(envelope: Uint8Array, key: Uint8Array): Promise<OpenedVault> {
    const contentAad = containerContentAad(envelope)
    if (contentAad) {
        const { wrapped, content } = splitContainer(envelope)
        // Only the UNWRAP is speculative: it answers "is the held key the wrap key or the
        // vault key?". Opening the content is not, so it stays outside the try. Inside it, a
        // corrupt vault - unwrap succeeded, content failed - would fall through to the fallback
        // and surface as "envelope authentication failed" against the wrong key, pointing the
        // user at the wrong cause.
        let vaultKey: Uint8Array
        try {
            // The held key as the WRAP key: unwrap the vault key first.
            vaultKey = (await openSymmetric({ keyForEpoch: () => key, envelope: wrapped, aad: VAULT_KEY_AAD })).plaintext
        } catch {
            // The held key as the VAULT key: open the content directly under it.
            return { vault: await openContent(content, key, contentAad), vaultKey: key, legacy: false }
        }
        return { vault: await openContent(content, vaultKey, contentAad), vaultKey, legacy: false }
    }
    if (envelope.length >= 2 && envelope[1] === KIND_SYMMETRIC) {
        // Phase-1 blob: content directly under the wrap key — no separate vault key exists.
        return { vault: await openContent(envelope, key, VAULT_V2_AAD), vaultKey: key, legacy: true }
    }
    throw new EnvelopeError(`unexpected vault envelope kind ${envelope[1] ?? 'none'}`)
}

/**
 * Re-encrypt UPDATED CONTENT against the envelope it was read from, as v3. A v2 or v3 envelope
 * keeps its wrapped-key segment verbatim (content writers usually hold only the vault key, never
 * the wrap key); a legacy envelope is upgraded — there the opening key WAS the wrap key, so a
 * fresh vault key is minted under it. Cache the returned vaultKey.
 */
export async function reencryptVault(
    vault: KeyVault,
    previousEnvelope: Uint8Array,
    opened: Pick<OpenedVault, 'vaultKey' | 'legacy'>,
): Promise<EncryptedVault> {
    if (opened.legacy) return encryptVault(vault, opened.vaultKey)
    const { wrapped } = splitContainer(previousEnvelope)
    return { envelope: buildContainer(wrapped, await sealContent(vault, opened.vaultKey)), vaultKey: opened.vaultKey }
}
