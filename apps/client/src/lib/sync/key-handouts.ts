/**
 * This account's copies of graph keyrings (ADR 0127).
 *
 * When a graph's owner starts a new Graph Key epoch, their Client seals the graph's whole keyring
 * to each member's X25519 key and signs each copy. A member's Client checks the owner's signature
 * against the identity the directory publishes for the owner and against its pins, opens the copy,
 * merges its epochs into the keyring it holds, writes the vault, and acknowledges the copy. The
 * owner's own copy is collected the same way, so every one of their devices gets the epoch too.
 *
 * Each copy holds every epoch up to its own, so a member who missed one copy loses nothing by
 * collecting the next.
 */
import { keyHandoutTranscript } from '@appsoftwareltd/etherpk-shared'
import {
    type GraphKeyring,
    type KeyVault,
    type KeyringJson,
    type PublicIdentity,
    KeyringConflictError,
    bytesEqual,
    contextAad,
    fingerprint,
    fromBase64Url,
    identityPublicKeys,
    keyringsFromJson,
    keyringsToJson,
    mergeKeyringEpochs,
    openSealed,
    sha256,
    utf8,
    verifySignature,
} from '$lib/crypto'
import { pinState, publishedIdentity, withPin } from './pins'
import type { PendingKeyHandout, SyncApi } from './sync-api'
import { updateVault } from './vault-update'

/** What a copy is sealed under: it names the graph, the epoch and the recipient. */
export function keyHandoutAad(graphId: string, epoch: number, recipientId: string): Uint8Array {
    return contextAad('key-handout', `graph:${graphId}`, `epoch:${epoch}`, `recipient:${recipientId}`)
}

interface HandoutPayloadV1 {
    v: 1
    keyring: KeyringJson
}

export function serializeHandoutPayload(keyring: GraphKeyring): Uint8Array {
    const payload: HandoutPayloadV1 = { v: 1, keyring: keyringsToJson([keyring])[0] }
    return utf8(JSON.stringify(payload))
}

function parseHandoutPayload(bytes: Uint8Array): GraphKeyring {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as HandoutPayloadV1
    if (payload.v !== 1) throw new Error(`unknown key copy format ${String(payload.v)}`)
    return keyringsFromJson([payload.keyring])[0]
}

/** What became of one copy waiting for this account. */
export type HandoutOutcome =
    /** Its epochs are in the vault now (or were already). */
    | { kind: 'added'; graphId: string; epoch: number }
    /**
     * Signed by a key other than the one pinned for the owner: nothing was added. The member must
     * compare the owner's new fingerprint before the new key is trusted.
     */
    | { kind: 'owner-key-changed'; graphId: string; epoch: number; ownerId: string; ownerEmail: string | null; identity: PublicIdentity; fingerprint: string }
    /** The signature does not check out against the owner's published identity: nothing was added. */
    | { kind: 'unverifiable'; graphId: string; epoch: number; ownerEmail: string | null }
    /** An epoch in the copy is held under a different key: nothing was added. */
    | { kind: 'conflict'; graphId: string; epoch: number }
    /** No keyring for the graph is held yet (an invite not yet accepted): left for later. */
    | { kind: 'not-joined'; graphId: string; epoch: number }

/** A copy that checked out: its keyring, and the owner to pin on first use when never pinned. */
interface OpenedHandout {
    handout: PendingKeyHandout
    keyring: GraphKeyring
    firstUsePin?: { ownerId: string; identity: PublicIdentity; email: string }
}

/**
 * Check and open `handouts` against the account's vault: the owner's signature by the identity the
 * directory publishes for them, that identity against the pins, and the sealed keyring. The owner's
 * own copies are checked against the vault's identity. An owner never pinned is pinned on first use,
 * marked unverified; a changed key stops that graph.
 */
export async function openKeyHandouts(
    handouts: readonly PendingKeyHandout[],
    own: { vault: KeyVault; principalId: string },
): Promise<{ opened: OpenedHandout[]; outcomes: HandoutOutcome[] }> {
    const opened: OpenedHandout[] = []
    const outcomes: HandoutOutcome[] = []
    for (const handout of handouts) {
        const base = { graphId: handout.graphId, epoch: handout.epoch }
        const isOwn = handout.ownerUserId === own.principalId
        const signer = isOwn ? identityPublicKeys(own.vault) : publishedIdentity(handout.ownerIdentity)
        const sealedToPublicKey = fromBase64Url(handout.sealedToPublicKey)
        if (!signer || !bytesEqual(sealedToPublicKey, own.vault.identityPublicKey)) {
            outcomes.push({ kind: 'unverifiable', ...base, ownerEmail: handout.ownerEmail })
            continue
        }
        const sealed = fromBase64Url(handout.sealedKeyring)
        const transcript = keyHandoutTranscript({
            graphId: handout.graphId,
            epoch: handout.epoch,
            ownerId: handout.ownerUserId,
            recipientId: own.principalId,
            sealedToPublicKey,
            sealedHash: await sha256(sealed),
        })
        if (!verifySignature(fromBase64Url(handout.signature), transcript, signer.signingPublicKey)) {
            outcomes.push({ kind: 'unverifiable', ...base, ownerEmail: handout.ownerEmail })
            continue
        }
        let firstUsePin: OpenedHandout['firstUsePin']
        if (!isOwn) {
            const pin = pinState(own.vault, handout.ownerUserId, signer)
            if (pin.kind === 'changed') {
                outcomes.push({
                    kind: 'owner-key-changed',
                    ...base,
                    ownerId: handout.ownerUserId,
                    ownerEmail: handout.ownerEmail,
                    identity: signer,
                    fingerprint: await fingerprint(signer),
                })
                continue
            }
            if (pin.kind === 'unpinned') firstUsePin = { ownerId: handout.ownerUserId, identity: signer, email: handout.ownerEmail ?? '' }
        }
        let keyring: GraphKeyring
        try {
            keyring = parseHandoutPayload(
                await openSealed(own.vault.identityPrivateKey, sealed, keyHandoutAad(handout.graphId, handout.epoch, own.principalId)),
            )
        } catch {
            outcomes.push({ kind: 'unverifiable', ...base, ownerEmail: handout.ownerEmail })
            continue
        }
        if (keyring.graphId !== handout.graphId || !keyring.epochs.some((e) => e.epochId === handout.epoch)) {
            outcomes.push({ kind: 'unverifiable', ...base, ownerEmail: handout.ownerEmail })
            continue
        }
        opened.push({ handout, keyring, ...(firstUsePin ? { firstUsePin } : {}) })
    }
    return { opened, outcomes }
}

/**
 * Fold `opened` copies into `vault`: each copy's epochs merge into the keyring held for its graph,
 * and owners seen for the first time are pinned unverified. Copies for a graph with no keyring held
 * yet are left out, and so are copies whose epochs conflict with the keyring held.
 */
function foldHandouts(vault: KeyVault, opened: readonly OpenedHandout[]): { vault: KeyVault; folded: OpenedHandout[]; outcomes: HandoutOutcome[] } {
    let next = vault
    const folded: OpenedHandout[] = []
    const outcomes: HandoutOutcome[] = []
    for (const entry of opened) {
        const base = { graphId: entry.handout.graphId, epoch: entry.handout.epoch }
        const held = next.keyrings.find((k) => k.graphId === entry.handout.graphId)
        if (!held) {
            outcomes.push({ kind: 'not-joined', ...base })
            continue
        }
        let merged: GraphKeyring
        try {
            merged = mergeKeyringEpochs(held, entry.keyring)
        } catch (error) {
            if (!(error instanceof KeyringConflictError)) throw error
            outcomes.push({ kind: 'conflict', ...base })
            continue
        }
        if (entry.firstUsePin) {
            next = withPin(next, entry.firstUsePin.ownerId, entry.firstUsePin.identity, { email: entry.firstUsePin.email, verified: false })
        }
        if (merged.epochs.length !== held.epochs.length) {
            next = { ...next, keyrings: next.keyrings.map((k) => (k === held ? merged : k)) }
        }
        folded.push(entry)
        outcomes.push({ kind: 'added', ...base })
    }
    return { vault: next, folded, outcomes }
}

/**
 * Collect the copies waiting for this account, for every graph or for `graphId`: check and open
 * them, merge their epochs into the vault with one signed write, then acknowledge each one the
 * vault now holds. Resolves to the vault as the server now holds it, which another device may
 * already have brought up to date, and what became of each copy.
 */
export async function collectKeyHandouts(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'listKeyHandouts' | 'acknowledgeKeyHandout'>,
    heldKey: Uint8Array,
    options: { graphId?: string } = {},
): Promise<{ vault: KeyVault; outcomes: HandoutOutcome[] }> {
    const handouts = await api.listKeyHandouts(options.graphId)
    let outcomes: HandoutOutcome[] = []
    let folded: OpenedHandout[] = []
    const update = await updateVault(api, heldKey, {
        async apply(vault, _opened, principalId) {
            const checked = await openKeyHandouts(handouts, { vault, principalId })
            const result = foldHandouts(vault, checked.opened)
            outcomes = [...checked.outcomes, ...result.outcomes]
            folded = result.folded
            return result.vault === vault ? null : result.vault
        },
    })
    for (const entry of folded) {
        // Best effort: an acknowledgement that does not land leaves a copy whose epochs are held
        // already, which the next collection acknowledges.
        await api.acknowledgeKeyHandout(entry.handout.id).catch(() => undefined)
    }
    return { vault: update.vault, outcomes }
}

/**
 * The Headless Client's reading of the copies waiting for its account (ADR 0127): `keyring` with
 * every checked copy's epochs merged in, in memory only. It never writes the vault or
 * acknowledges a copy, so a browser of the same account still collects it. An owner never pinned
 * is trusted on first use for this run; a changed key or a bad signature leaves the keyring as it is.
 */
export async function readKeyHandouts(
    api: Pick<SyncApi, 'listKeyHandouts'>,
    own: { vault: KeyVault; principalId: string },
    keyring: GraphKeyring,
): Promise<GraphKeyring> {
    const handouts = await api.listKeyHandouts(keyring.graphId)
    const { opened } = await openKeyHandouts(handouts, own)
    let merged = keyring
    for (const entry of opened) {
        try {
            merged = mergeKeyringEpochs(merged, entry.keyring)
        } catch (error) {
            if (!(error instanceof KeyringConflictError)) throw error
        }
    }
    return merged
}
