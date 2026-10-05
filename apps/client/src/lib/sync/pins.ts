/**
 * Pinned Identities (ADR 0126): the Security Fingerprints this account has confirmed, kept in its
 * vault so that every one of its devices knows them.
 *
 * A pin is made when the user compares fingerprints - sending an invite, accepting one, or
 * Verify in a graph's member list - and records both public keys. From then on, the keys the
 * server presents for that person are compared with the pin: the same keys need no second
 * comparison, and different ones stop the action until the user compares again. A member who
 * joined before pins existed is pinned on first use, marked unverified, so the owner is not asked
 * to reach every member before a shared graph can carry on.
 */
import { type KeyVault, type PinnedIdentity, type PublicIdentity, bytesEqual, fromBase64Url, toBase64Url } from '$lib/crypto'
import type { PublishedIdentityJson, SyncApi } from './sync-api'
import { updateVault } from './vault-update'

export type PinState =
    /** Confirmed by comparing fingerprints, and the server presents the pinned keys. */
    | { kind: 'verified' }
    /** Pinned on first use only, and the server presents the pinned keys. */
    | { kind: 'unverified' }
    /** Never pinned. */
    | { kind: 'unpinned' }
    /** The server presents keys that differ from the pinned ones. */
    | { kind: 'changed'; pinned: PinnedIdentity }

function pinMatches(pin: PinnedIdentity, identity: PublicIdentity): boolean {
    return (
        bytesEqual(fromBase64Url(pin.publicKey), identity.publicKey) &&
        bytesEqual(fromBase64Url(pin.signingPublicKey), identity.signingPublicKey)
    )
}

/** What this vault's pins say about the keys the server presents for `principalId`. */
export function pinState(vault: Pick<KeyVault, 'pins'>, principalId: string, presented: PublicIdentity): PinState {
    const pin = vault.pins?.[principalId]
    if (!pin) return { kind: 'unpinned' }
    if (!pinMatches(pin, presented)) return { kind: 'changed', pinned: pin }
    return pin.verified ? { kind: 'verified' } : { kind: 'unverified' }
}

/**
 * The vault with `identity` pinned for `principalId`, or the same vault object when it already
 * holds that pin at least as strongly - so a caller can skip the write. A pin taken on first use
 * never replaces a verified pin of the same keys, and a pin of other keys replaces the old one
 * whole, since what it held described keys no longer trusted.
 */
export function withPin(
    vault: KeyVault,
    principalId: string,
    identity: PublicIdentity,
    details: { email: string; verified: boolean; now?: () => Date },
): KeyVault {
    const existing = vault.pins?.[principalId]
    const now = (details.now ?? (() => new Date()))().toISOString()
    let pin: PinnedIdentity
    if (existing && pinMatches(existing, identity)) {
        if (existing.verified || !details.verified) return vault
        pin = { ...existing, email: details.email, pinnedAt: now, verified: true }
    } else {
        pin = {
            publicKey: toBase64Url(identity.publicKey),
            signingPublicKey: toBase64Url(identity.signingPublicKey),
            email: details.email,
            pinnedAt: now,
            verified: details.verified,
        }
    }
    return { ...vault, pins: { ...vault.pins, [principalId]: pin } }
}

/** A published identity as keys, or null when there is none or it has no signing key yet. */
export function publishedIdentity(json: PublishedIdentityJson | null | undefined): PublicIdentity | null {
    if (!json?.signingPublicKey) return null
    return { publicKey: fromBase64Url(json.publicKey), signingPublicKey: fromBase64Url(json.signingPublicKey) }
}

/** Pin `identity` for `principalId` in the account's vault, with a signed write. */
export async function savePin(
    api: Pick<SyncApi, 'getVault' | 'putKeys'>,
    heldKey: Uint8Array,
    principalId: string,
    identity: PublicIdentity,
    details: { email: string; verified: boolean },
): Promise<void> {
    await updateVault(api, heldKey, {
        apply: (vault) => {
            const next = withPin(vault, principalId, identity, details)
            return next === vault ? null : next
        },
    })
}
