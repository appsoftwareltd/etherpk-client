/**
 * The key vault (ADR 0026): everything a device needs — the identity keypair and
 * every graph keyring — as one envelope. Stored server-side as an opaque blob;
 * losing local storage is harmless.
 *
 * Format v2 (device approval): the vault content is encrypted under a random VAULT KEY,
 * and the vault key travels alongside, wrapped under the Recovery-Code-derived wrap key:
 *
 *   [0]      version = 1 (envelope family)
 *   [1]      kind    = 3 (vault container)
 *   [2..3]   u16 BE — byte length of the wrapped-vault-key envelope
 *   [4..]    wrapped vault key (symmetric envelope under the WRAP key, aad 'vault-key')
 *   [rest]   vault content (symmetric envelope under the VAULT key, aad 'vault')
 *
 * The indirection is what device approval seals to a new device (the vault key, never the
 * code), and it makes Regenerate Recovery Code a re-WRAP: the vault key — the thing every
 * unlocked device caches — survives, so other devices stay unlocked.
 *
 * Legacy (phase 1) blobs are the content envelope directly under the wrap key; they still
 * open, and any write upgrades them to v2 with a freshly minted vault key.
 */
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'
import { ENVELOPE_VERSION, EnvelopeError, KIND_SYMMETRIC, contextAad, openSymmetric, sealSymmetric } from './envelope'
import { type GraphKeyring, deserializeKeyrings, serializeKeyrings } from './keyring'
import type { ProtectionRecord } from './protection-key'

export interface KeyVault {
    identityPrivateKey: Uint8Array
    identityPublicKey: Uint8Array
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
}

export const KIND_VAULT_V2 = 3
const VAULT_AAD = contextAad('vault')
const VAULT_KEY_AAD = contextAad('vault-key')
const CONTAINER_HEADER = 4

interface VaultJson {
    identityPrivateKey: string
    identityPublicKey: string
    keyrings: string
    /** Absent in every vault written before protection existed — read as "no protected graphs". */
    protection?: Record<string, ProtectionRecord>
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

async function sealContent(vault: KeyVault, vaultKey: Uint8Array): Promise<Uint8Array> {
    const json: VaultJson = {
        identityPrivateKey: toBase64Url(vault.identityPrivateKey),
        identityPublicKey: toBase64Url(vault.identityPublicKey),
        keyrings: new TextDecoder().decode(serializeKeyrings(vault.keyrings)),
        // Omitted entirely when empty, so a vault holding no protected graph is byte-identical to
        // one written before the feature existed.
        ...(vault.protection && Object.keys(vault.protection).length > 0 ? { protection: vault.protection } : {}),
    }
    return sealSymmetric({ key: vaultKey, epochId: 0, plaintext: utf8(JSON.stringify(json)), aad: VAULT_AAD })
}

async function openContent(envelope: Uint8Array, vaultKey: Uint8Array): Promise<KeyVault> {
    const { plaintext } = await openSymmetric({ keyForEpoch: () => vaultKey, envelope, aad: VAULT_AAD })
    const json = JSON.parse(new TextDecoder().decode(plaintext)) as VaultJson
    return {
        identityPrivateKey: fromBase64Url(json.identityPrivateKey),
        identityPublicKey: fromBase64Url(json.identityPublicKey),
        keyrings: deserializeKeyrings(utf8(json.keyrings)),
        ...(json.protection ? { protection: json.protection } : {}),
    }
}

function buildContainer(wrapped: Uint8Array, content: Uint8Array): Uint8Array {
    const out = new Uint8Array(CONTAINER_HEADER + wrapped.length + content.length)
    out[0] = ENVELOPE_VERSION
    out[1] = KIND_VAULT_V2
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

/**
 * Encrypt a vault under `wrapKey` (v2). Pass `vaultKey` to preserve an existing vault key —
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
 * (legacy or v2), or the vault key itself (v2 — the device-approval / cached case).
 */
export async function openVault(envelope: Uint8Array, key: Uint8Array): Promise<OpenedVault> {
    if (envelope.length >= 2 && envelope[0] === ENVELOPE_VERSION && envelope[1] === KIND_VAULT_V2) {
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
            return { vault: await openContent(content, key), vaultKey: key, legacy: false }
        }
        return { vault: await openContent(content, vaultKey), vaultKey, legacy: false }
    }
    if (envelope.length >= 2 && envelope[1] === KIND_SYMMETRIC) {
        // Phase-1 blob: content directly under the wrap key — no separate vault key exists.
        return { vault: await openContent(envelope, key), vaultKey: key, legacy: true }
    }
    throw new EnvelopeError(`unexpected vault envelope kind ${envelope[1] ?? 'none'}`)
}

/**
 * Re-encrypt UPDATED CONTENT against the envelope it was read from. A v2 envelope keeps its
 * wrapped-key segment verbatim (content writers usually hold only the vault key, never the
 * wrap key); a legacy envelope is upgraded to v2 — there the opening key WAS the wrap key,
 * so a fresh vault key is minted under it. Cache the returned vaultKey.
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
