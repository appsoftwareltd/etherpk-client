/**
 * Player invites (ADR 0026, made two-sided by ADR 0126).
 *
 * The owner looks the invitee up, compares their Security Fingerprint, seals the graph keyring
 * to their X25519 key and signs the invite with the owner's Ed25519 key, over the graph, both
 * accounts, the identity it was sealed to and the sealed payload. The invitee checks that
 * signature against the inviter's identity, compares the inviter's fingerprint (or finds it
 * pinned), and folds the keyring into their vault. Each fingerprint a user confirms is pinned.
 *
 * The server only ever brokers the sealed blob and the signature: it never sees the keyring, and
 * an invite it made up, or moved to another graph, person or payload, does not check out.
 */
import { inviteTranscript } from '@appsoftwareltd/etherpk-shared'
import {
    type GraphKeyring,
    type KeyVault,
    type KeyringJson,
    type PublicIdentity,
    contextAad,
    fingerprint,
    fromBase64Url,
    identityHash,
    identityPublicKeys,
    keyringsFromJson,
    keyringsToJson,
    mergeKeyringEpochs,
    openSealed,
    openVault,
    sealToPublicKey,
    sha256,
    signMessage,
    toBase64Url,
    utf8,
    verifySignature,
} from '$lib/crypto'
import { type PinState, pinState, publishedIdentity, withPin } from './pins'
import { NoVaultError } from './recovery-unlock'
import { SyncApiError, type PendingInvite, type SyncApi } from './sync-api'
import { updateVault } from './vault-update'

const inviteAad = (graphId: string) => contextAad('keyring-invite', `graph:${graphId}`)

/**
 * Sealed invite payload v2: the keyrings plus the [[Graph Name]], so the invitee's client can
 * label the graph at accept time — before ever opening it. The name rides INSIDE the sealed
 * box (the server can never supply one, ADR 0024). Legacy payloads — a bare keyring array,
 * sealed before v2 — still open.
 */
interface InvitePayloadV2 {
    v: 2
    keyrings: KeyringJson[]
    name?: string
}

function serializeInvitePayload(keyring: GraphKeyring, name?: string): Uint8Array {
    const payload: InvitePayloadV2 = { v: 2, keyrings: keyringsToJson([keyring]), ...(name ? { name } : {}) }
    return utf8(JSON.stringify(payload))
}

function parseInvitePayload(bytes: Uint8Array): { keyrings: GraphKeyring[]; name?: string } {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (Array.isArray(json)) return { keyrings: keyringsFromJson(json as KeyringJson[]) } // legacy
    const v2 = json as InvitePayloadV2
    return {
        keyrings: keyringsFromJson(v2.keyrings),
        ...(typeof v2.name === 'string' && v2.name !== '' ? { name: v2.name } : {}),
    }
}

/** Read the account's vault with the key this device holds, with the account id the server gives it. */
async function readOwnVault(
    api: Pick<SyncApi, 'getVault'>,
    heldKey: Uint8Array,
): Promise<{ vault: KeyVault; principalId: string }> {
    const stored = await api.getVault()
    if (!stored) throw new NoVaultError()
    return { vault: (await openVault(fromBase64Url(stored.vault), heldKey)).vault, principalId: stored.principalId }
}

/**
 * Is the typed address the signed-in account's own? Inviting yourself is refused by the server,
 * but only after the lookup step has shown the owner their own key's fingerprint to check, so the
 * dialog asks this first. Addresses compare without case or surrounding space.
 */
export function isOwnAddress(typed: string, own: string | null | undefined): boolean {
    return own != null && typed.trim().toLowerCase() === own.trim().toLowerCase()
}

export type InviteLookup =
    /** Somebody to invite, with the fingerprint to compare and what the pins say about it. */
    | { kind: 'found'; inviteeUserId: string; identity: PublicIdentity; fingerprint: string; pin: PinState }
    /** No account with that address can be invited: none exists, or it has no keys yet. */
    | { kind: 'not-found' }
    /** They have keys, but their EtherPK has not opened them since signing keys existed. */
    | { kind: 'keys-outdated' }

/** Step 1: look up the invitee, and get their fingerprint and pin to show before sealing. */
export async function prepareInvite(
    api: Pick<SyncApi, 'getIdentityByEmail' | 'getVault'>,
    graphId: string,
    inviteeEmail: string,
    heldKey: Uint8Array,
): Promise<InviteLookup> {
    const found = await api.getIdentityByEmail(graphId, inviteeEmail)
    if (!found) return { kind: 'not-found' }
    const identity = publishedIdentity(found)
    if (!identity) return { kind: 'keys-outdated' }
    const { vault } = await readOwnVault(api, heldKey)
    return {
        kind: 'found',
        inviteeUserId: found.userId,
        identity,
        fingerprint: await fingerprint(identity),
        pin: pinState(vault, found.userId, identity),
    }
}

/**
 * Nobody with the address can be invited: no account has it, or the account has not set up a
 * device (published an identity key) yet. The server gives one answer for both (`404
 * identity_not_found`), on the lookup and again on the invite itself.
 */
export class InviteeNotFoundError extends Error {
    constructor() {
        super('No account with that address can be invited yet')
        this.name = 'InviteeNotFoundError'
    }
}

/**
 * Between the lookup and the send, the address moved to another account or the invitee's keys
 * changed: the fingerprint the owner compared is not the one the invite would reach.
 */
export class InviteeChangedError extends Error {
    constructor() {
        super('Their account or Encryption Keys changed after you looked them up')
        this.name = 'InviteeChangedError'
    }
}

/**
 * Step 2, once the owner has compared fingerprints: pin the invitee, seal this graph's keyring
 * (and its name, if known) to them, sign the invite, and send it.
 */
export async function sendInvite(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'createInvite'>,
    invite: {
        graphId: string
        graphName?: string
        inviteeEmail: string
        invitee: { userId: string; identity: PublicIdentity }
    },
    heldKey: Uint8Array,
): Promise<string> {
    // The pin goes first: the user has just compared fingerprints, whatever happens to the send.
    // The same write gives a vault from before signing keys its key, which the server must hold
    // before it can check this invite's signature.
    const update = await updateVault(api, heldKey, {
        apply: (vault) => {
            const pinned = withPin(vault, invite.invitee.userId, invite.invitee.identity, {
                email: invite.inviteeEmail,
                verified: true,
            })
            if (pinned !== vault) return pinned
            return vault.signingPrivateKey ? null : vault
        },
    })
    const keyring = update.vault.keyrings.find((k) => k.graphId === invite.graphId)
    if (!keyring) throw new Error('This device does not hold the key for this graph.')
    const sealed = await sealToPublicKey(
        invite.invitee.identity.publicKey,
        serializeInvitePayload(keyring, invite.graphName),
        inviteAad(invite.graphId),
    )
    const transcript = inviteTranscript({
        graphId: invite.graphId,
        inviterId: update.principalId,
        inviteeId: invite.invitee.userId,
        inviteeIdentityHash: await identityHash(invite.invitee.identity),
        sealedHash: await sha256(sealed),
    })
    try {
        const { id } = await api.createInvite({
            graphId: invite.graphId,
            inviteeEmail: invite.inviteeEmail,
            inviteeUserId: invite.invitee.userId,
            sealedKeyring: toBase64Url(sealed),
            sealedToPublicKey: toBase64Url(invite.invitee.identity.publicKey),
            signature: toBase64Url(signMessage(transcript, update.vault.signingPrivateKey!)),
        })
        return id
    } catch (error) {
        // The invite route answers 404 only for an invitee nobody can be invited under; the
        // generic "the server no longer has it" reading of a 404 would send the owner to refresh.
        if (error instanceof SyncApiError && error.status === 404) throw new InviteeNotFoundError()
        if (error instanceof SyncApiError && (error.code === 'invitee_changed' || error.code === 'invitee_keys_changed')) {
            throw new InviteeChangedError()
        }
        throw error
    }
}

/** What the invitee's Client makes of a pending invite before it is accepted. */
export type InviteCheck =
    /** Sent by a Client from before ADR 0126, with no signature to check. */
    | { kind: 'unsigned'; inviterEmail: string | null }
    /** The signature does not check out against the inviter's published identity. */
    | { kind: 'unverifiable'; inviterEmail: string | null }
    /** Signed by the inviter's identity: here is its fingerprint, and what the pins say about it. */
    | {
          kind: 'signed'
          inviterId: string
          inviterEmail: string | null
          identity: PublicIdentity
          fingerprint: string
          pin: PinState
      }

/**
 * Check `invite` against the account's own identity and pins: was it signed by the identity the
 * server publishes for its inviter, over this graph, this account, this account's identity and
 * this payload?
 */
export async function checkInvite(invite: PendingInvite, own: { vault: KeyVault; principalId: string }): Promise<InviteCheck> {
    const inviterEmail = invite.inviterEmail ?? null
    if (!invite.signature) return { kind: 'unsigned', inviterEmail }
    const identity = publishedIdentity(invite.inviterIdentity)
    const ownIdentity = identityPublicKeys(own.vault)
    if (!identity || !invite.inviterUserId || !ownIdentity) return { kind: 'unverifiable', inviterEmail }
    const transcript = inviteTranscript({
        graphId: invite.graphId,
        inviterId: invite.inviterUserId,
        inviteeId: own.principalId,
        inviteeIdentityHash: await identityHash(ownIdentity),
        sealedHash: await sha256(fromBase64Url(invite.sealedKeyring)),
    })
    if (!verifySignature(fromBase64Url(invite.signature), transcript, identity.signingPublicKey)) {
        return { kind: 'unverifiable', inviterEmail }
    }
    return {
        kind: 'signed',
        inviterId: invite.inviterUserId,
        inviterEmail,
        identity,
        fingerprint: await fingerprint(identity),
        pin: pinState(own.vault, invite.inviterUserId, identity),
    }
}

/** Read the account's vault and check `invite` against it: what the accept dialog shows. */
export async function inspectInvite(
    api: Pick<SyncApi, 'getVault'>,
    invite: PendingInvite,
    heldKey: Uint8Array,
): Promise<InviteCheck> {
    return checkInvite(invite, await readOwnVault(api, heldKey))
}

/**
 * The invite was not accepted, and nothing changed: it carries no signature, the signature does
 * not check out, or the inviter's key is not the one the user compared.
 */
export class InviteNotAcceptedError extends Error {
    constructor(
        readonly reason: 'unsigned' | 'unverifiable' | 'key-changed',
        readonly inviterEmail: string | null,
    ) {
        super(`The invite was not accepted: ${reason}`)
        this.name = 'InviteNotAcceptedError'
    }
}

export interface AcceptedInvite {
    graphId: string
    rootDocId: string
    /** The keyring the vault now holds for the graph: the invite's, merged into any held already. */
    keyring: GraphKeyring
    /** The graph's name as the inviter knew it — a labelling snapshot; the meta map is canonical. */
    name?: string
}

/**
 * The graph's name from a pending invite, to say what the invite is for before it is accepted.
 * The name rides inside the sealed payload, so reading it takes the account's identity key; the
 * keyring beside it is read and dropped, and nothing reaches the vault. Undefined for an invite
 * sealed without a name, or one this key cannot open.
 */
export async function inviteGraphName(
    invite: { graphId: string; sealedKeyring: string },
    identityPrivateKey: Uint8Array,
): Promise<string | undefined> {
    try {
        const sealed = fromBase64Url(invite.sealedKeyring)
        return parseInvitePayload(await openSealed(identityPrivateKey, sealed, inviteAad(invite.graphId))).name
    } catch {
        return undefined
    }
}

/**
 * Accept an invite the user has looked at: check it again, pin the inviter, fold the keyring into
 * the vault and activate membership. `confirmedFingerprint` is the inviter fingerprint the accept
 * dialog showed; if the server now presents another identity, nothing is accepted.
 *
 * An invite for a graph whose key the vault already holds is a Player who left being invited
 * back: its epochs are merged into the keyring held, by epoch number, and an epoch held under a
 * different key stops the accept (`KeyringConflictError`) rather than replace the key in use.
 */
export async function acceptInvite(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'acceptInvite'>,
    invite: PendingInvite,
    heldKey: Uint8Array,
    confirmedFingerprint: string,
): Promise<AcceptedInvite> {
    const own = await readOwnVault(api, heldKey)
    const check = await checkInvite(invite, own)
    if (check.kind !== 'signed') throw new InviteNotAcceptedError(check.kind, check.inviterEmail)
    if (check.fingerprint !== confirmedFingerprint) throw new InviteNotAcceptedError('key-changed', check.inviterEmail)

    const payload = parseInvitePayload(await openSealed(own.vault.identityPrivateKey, fromBase64Url(invite.sealedKeyring), inviteAad(invite.graphId)))
    const incoming = payload.keyrings.find((k) => k.graphId === invite.graphId)
    if (!incoming) throw new Error('sealed invite did not contain this graph’s keyring')

    let keyring = incoming
    await updateVault(api, heldKey, {
        apply: (vault) => {
            const pinned = withPin(vault, check.inviterId, check.identity, {
                email: check.inviterEmail ?? '',
                verified: true,
            })
            const held = pinned.keyrings.find((k) => k.graphId === invite.graphId)
            keyring = held ? mergeKeyringEpochs(held, incoming) : incoming
            return {
                ...pinned,
                keyrings: held ? pinned.keyrings.map((k) => (k === held ? keyring : k)) : [...pinned.keyrings, keyring],
            }
        },
    })

    await api.acceptInvite(invite.id)
    return { graphId: invite.graphId, rootDocId: invite.rootDocId, keyring, ...(payload.name ? { name: payload.name } : {}) }
}
