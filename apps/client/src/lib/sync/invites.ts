/**
 * Player invite crypto flow (ADR 0026). The owner seals the graph keyring to the invitee's
 * identity public key (TOFU + a displayed fingerprint for out-of-band verification); the
 * invitee unseals it and folds the keyring into their own vault. The server only ever brokers
 * the sealed blob — it never sees the keyring.
 */
import {
    type GraphKeyring,
    type KeyVault,
    type KeyringJson,
    contextAad,
    fingerprint,
    fromBase64Url,
    keyringsFromJson,
    keyringsToJson,
    openSealed,
    openVault,
    reencryptVault,
    sealToPublicKey,
    toBase64Url,
    utf8,
} from '$lib/crypto'
import type { SyncApi } from './sync-api'

const inviteAad = (graphId: string) => contextAad('keyring-invite', `graph:${graphId}`)

/**
 * Sealed invite payload v2: the keyrings plus the [[Graph Name]], so the invitee's client can
 * label the graph at accept time — before ever opening it. The name rides INSIDE the sealed
 * box (the server can never supply one, ADR 0024). Legacy payloads — a bare keyring array,
 * sealed before v2 — must keep opening: pending invites survive an upgrade.
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

export interface InvitePreparation {
    inviteePublicKey: Uint8Array
    /** The invitee's identity fingerprint — show it for out-of-band verification (TOFU). */
    fingerprint: string
}

/** Step 1: look up the invitee and get their fingerprint to confirm before sealing. */
export async function prepareInvite(api: SyncApi, inviteeEmail: string): Promise<InvitePreparation | null> {
    const identity = await api.getIdentityByEmail(inviteeEmail)
    if (!identity) return null
    const inviteePublicKey = fromBase64Url(identity.publicKey)
    return { inviteePublicKey, fingerprint: await fingerprint(inviteePublicKey) }
}

/** Step 2: seal this graph's keyring (+ its name, if known) to the verified invitee. */
export async function sendInvite(
    api: SyncApi,
    graphId: string,
    inviteeEmail: string,
    inviteePublicKey: Uint8Array,
    keyring: GraphKeyring,
    graphName?: string,
): Promise<string> {
    const sealed = await sealToPublicKey(inviteePublicKey, serializeInvitePayload(keyring, graphName), inviteAad(graphId))
    const { id } = await api.createInvite(graphId, inviteeEmail, toBase64Url(sealed))
    return id
}

export interface AcceptedInvite {
    graphId: string
    rootDocId: string
    keyring: GraphKeyring
    /** The graph's name as the inviter knew it — a labelling snapshot; the meta map is canonical. */
    name?: string
}

/**
 * Accept an invite: unseal the keyring with the invitee's identity key, fold it into their
 * vault, and activate membership. Returns what the client needs to open the shared graph.
 */
export async function acceptInvite(
    api: SyncApi,
    invite: { id: string; graphId: string; rootDocId: string; sealedKeyring: string },
    identityPrivateKey: Uint8Array,
    heldVaultKey: Uint8Array,
    currentVaultVersion: number,
): Promise<AcceptedInvite> {
    const payload = parseInvitePayload(
        await openSealed(identityPrivateKey, fromBase64Url(invite.sealedKeyring), inviteAad(invite.graphId)),
    )
    const keyring = payload.keyrings.find((k) => k.graphId === invite.graphId)
    if (!keyring) throw new Error('sealed invite did not contain this graph’s keyring')

    // Fold the new keyring into the vault (re-read to get the latest identity + keyrings).
    const latest = await api.getVault()
    if (!latest) throw new Error('no vault to add the keyring to')
    const latestEnvelope = fromBase64Url(latest.vault)
    const opened = await openVault(latestEnvelope, heldVaultKey)
    const merged: KeyVault = {
        ...opened.vault,
        keyrings: [...opened.vault.keyrings.filter((k) => k.graphId !== invite.graphId), keyring],
    }
    const { envelope } = await reencryptVault(merged, latestEnvelope, opened)
    await api.putVault(toBase64Url(envelope), latest.version)
    void currentVaultVersion

    await api.acceptInvite(invite.id)
    return { graphId: invite.graphId, rootDocId: invite.rootDocId, keyring, ...(payload.name ? { name: payload.name } : {}) }
}
