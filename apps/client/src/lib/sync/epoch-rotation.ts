/**
 * The owner starts a new Graph Key epoch (ADR 0127): after a member leaves or is removed, after a
 * member's Account Reset, after the owner's Key Replacement, or on **Rotate key**.
 *
 * Only the owner's Client can do it, because only it holds the key to start from. It allocates the
 * next epoch number from the Sync Server, checks every member's published identity against its
 * pins, makes the new key, seals the graph's keyring with the new epoch to each member, the owner
 * included, signs each copy, and commits them in one request the server refuses if the members or
 * their keys changed in between. Each member's Client then collects its copy (key-handouts.ts).
 */
import { keyHandoutTranscript } from '@appsoftwareltd/etherpk-shared'
import {
    type GraphKeyring,
    currentEpoch,
    fromBase64Url,
    randomBytes,
    sealToPublicKey,
    sha256,
    signMessage,
    toBase64Url,
} from '$lib/crypto'
import { collectKeyHandouts, keyHandoutAad, serializeHandoutPayload } from './key-handouts'
import { MissingGraphKeyError } from './keys'
import { pinState, publishedIdentity, withPin } from './pins'
import { SyncApiError, type SyncApi } from './sync-api'
import { updateVault } from './vault-update'

export type RotationResult =
    /**
     * The graph moved to `epoch`. `firstUse` names members who had never been verified and were
     * pinned on first use: worth comparing fingerprints with when convenient. `unchecked` names
     * members whose keys predate signing keys: their copy went to the key the server gives for
     * them, with nothing to check it against or pin.
     */
    | { kind: 'rotated'; epoch: number; firstUse: string[]; unchecked: string[] }
    /**
     * The server presents a key for this member other than the one pinned. Nothing changed: the
     * owner compares fingerprints (Verify in the member list) before the key can change.
     */
    | { kind: 'member-key-changed'; member: { userId: string; email: string } }
    /**
     * The server presents a member the owner has pinned without the signing key the pin records.
     * Nothing changed, and comparing fingerprints cannot settle it, since there is no signing key
     * to compare: the owner takes the member out of the graph or asks whoever runs the server.
     */
    | { kind: 'member-signing-key-missing'; member: { userId: string; email: string } }

/** The commit refusals that mean "the ground moved: allocate again and start over". */
const RESTART_CODES = new Set(['epoch_lease_lost', 'epoch_members_changed', 'epoch_recipient_keys_changed'])

/** How many times a rotation starts over after the members or their keys changed under it. */
const MAX_ATTEMPTS = 3

type RotationApi = Pick<
    SyncApi,
    'getVault' | 'putKeys' | 'allocateEpoch' | 'commitEpoch' | 'listKeyHandouts' | 'acknowledgeKeyHandout'
>

/**
 * Start a new epoch for `graphId`, whose owner this account must be. `heldKey` is what this device
 * holds for the vault.
 */
export async function rotateGraphKey(api: RotationApi, graphId: string, heldKey: Uint8Array): Promise<RotationResult> {
    /** The epoch the previous attempt was allocated, whom it pinned on first use and whom it could not check. */
    let previous: { epoch: number; firstUse: string[]; unchecked: string[] } | null = null
    for (let attempt = 1; ; attempt++) {
        const allocation = await api.allocateEpoch(graphId)
        if (previous && allocation.epoch > previous.epoch) {
            // Another of the owner's devices committed an epoch after this one's allocation, which
            // came after whatever made the change due. The server checked that epoch's members as
            // it committed, so it leaves out everyone this one would have: collect it and stop.
            await collectKeyHandouts(api, heldKey, { graphId }).catch(() => undefined)
            return { kind: 'rotated', epoch: allocation.epoch - 1, firstUse: previous.firstUse, unchecked: previous.unchecked }
        }
        // Every recipient's key, checked against the pins in the same pass that pins on first use
        // any member never verified, so the pins written are the keys sealed to.
        // Set inside the vault change, which runs again after a conflicting write.
        let changed = null as RotationResult | null
        const firstUse: string[] = []
        const unchecked: string[] = []
        const sealTo: Array<{ userId: string; publicKey: Uint8Array }> = []
        const update = await updateVault(api, heldKey, {
            apply(vault, _opened, principalId) {
                changed = null
                firstUse.length = 0
                unchecked.length = 0
                sealTo.length = 0
                let next = vault
                for (const recipient of allocation.recipients) {
                    if (recipient.userId === principalId) {
                        sealTo.push({ userId: recipient.userId, publicKey: vault.identityPublicKey })
                        continue
                    }
                    if (!recipient.identity) continue
                    const identity = publishedIdentity(recipient.identity)
                    if (!identity) {
                        // Every pin records a signing key, and a Client never withdraws one it has
                        // published, so a pinned member presented without one has a changed key.
                        if (next.pins?.[recipient.userId]) {
                            changed = { kind: 'member-signing-key-missing', member: { userId: recipient.userId, email: recipient.email } }
                            return null
                        }
                        // A member whose keys predate signing keys can be neither checked nor pinned
                        // yet. They still need the key, sealed to the X25519 key the server gives,
                        // and the owner is told whom that covered.
                        unchecked.push(recipient.email)
                        sealTo.push({ userId: recipient.userId, publicKey: fromBase64Url(recipient.identity.publicKey) })
                        continue
                    }
                    const pin = pinState(next, recipient.userId, identity)
                    if (pin.kind === 'changed') {
                        changed = { kind: 'member-key-changed', member: { userId: recipient.userId, email: recipient.email } }
                        return null
                    }
                    if (pin.kind === 'unpinned') {
                        next = withPin(next, recipient.userId, identity, { email: recipient.email, verified: false })
                        firstUse.push(recipient.email)
                    }
                    sealTo.push({ userId: recipient.userId, publicKey: identity.publicKey })
                }
                // A vault without a signing key cannot sign the copies: the write upgrades it.
                if (next === vault && vault.signingPrivateKey) return null
                return next
            },
        })
        if (changed) return changed

        const held = update.vault.keyrings.find((k) => k.graphId === graphId)
        if (!held) throw new MissingGraphKeyError(graphId)
        if (currentEpoch(held).epochId !== allocation.epoch - 1) {
            // Another device of this account started an epoch this vault has not collected yet.
            await collectKeyHandouts(api, heldKey, { graphId })
            if (attempt >= MAX_ATTEMPTS) throw new Error('This graph’s key could not be changed: this device could not collect the newest one.')
            continue
        }

        const next: GraphKeyring = { graphId, epochs: [...held.epochs, { epochId: allocation.epoch, key: randomBytes(32) }] }
        const payload = serializeHandoutPayload(next)
        const copies = []
        for (const recipient of sealTo) {
            const sealed = await sealToPublicKey(recipient.publicKey, payload, keyHandoutAad(graphId, allocation.epoch, recipient.userId))
            const transcript = keyHandoutTranscript({
                graphId,
                epoch: allocation.epoch,
                ownerId: update.principalId,
                recipientId: recipient.userId,
                sealedToPublicKey: recipient.publicKey,
                sealedHash: await sha256(sealed),
            })
            copies.push({
                recipientId: recipient.userId,
                sealedToPublicKey: toBase64Url(recipient.publicKey),
                sealedKeyring: toBase64Url(sealed),
                signature: toBase64Url(signMessage(transcript, update.vault.signingPrivateKey!)),
            })
        }

        try {
            await api.commitEpoch(graphId, allocation.epoch, copies)
        } catch (error) {
            if (error instanceof SyncApiError && error.code && RESTART_CODES.has(error.code) && attempt < MAX_ATTEMPTS) {
                previous = { epoch: allocation.epoch, firstUse: [...firstUse], unchecked: [...unchecked] }
                continue
            }
            throw error
        }
        // The owner's own copy is collected like every member's: that is what puts the new epoch in
        // the vault, for this device and every other device of the owner. The epoch has moved on
        // whether or not this lands: when it does not, the server refuses this device's next write
        // as written under an older epoch, and the sync engine collects the copy then.
        await collectKeyHandouts(api, heldKey, { graphId }).catch(() => undefined)
        return { kind: 'rotated', epoch: allocation.epoch, firstUse: [...firstUse], unchecked: [...unchecked] }
    }
}
