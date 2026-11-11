/**
 * Sharing a synced graph from inside it: who may, and what the invite dialog needs (ADR 0126).
 *
 * The [[Owner]] invites; a [[Player]] cannot, and a graph in a folder has nobody to invite. The
 * workspace asks once per open, in the background, and offers Share only on a yes.
 */

import { ownerCanWrite, type SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'

import { fromBase64Url, openVault } from '#lib/crypto/index.js'

import { MissingGraphKeyError } from './keys'
import { NoVaultError } from './recovery-unlock'
import type { SyncApi } from './sync-api'

/** What an invitee must have on the Owner's server, for the invite dialog to name. */
export interface InviteeNeeds {
    /** The kind of account, in words. */
    account: string
    /** Whether its address must be verified. */
    verifiedEmail: boolean
}

/** What the invite dialog needs about the person sharing. */
export interface ShareAccess {
    /** The Owner's own address, so inviting it is refused before the lookup. */
    ownEmail: string | null
    inviteeNeeds: InviteeNeeds
}

/** What somebody `account` invites must have on its server. */
export function inviteeNeedsOf(account: SyncAccountSummary | null): InviteeNeeds {
    return {
        account: account?.authentication.mode === 'standalone' ? 'an account on this server' : 'an EtherPK account',
        // An older server does not say; the stricter reading names the step that may be missing.
        verifiedEmail: account?.invitesNeedVerifiedEmail ?? true,
    }
}

/**
 * Whether this person may share the graph, and what the invite dialog needs if so. Null for a
 * Player, while the role or the account cannot be read (offline: an invite could not be sent
 * either), and while the Owner's plan takes no new Players.
 */
export async function readShareAccess(api: Pick<SyncApi, 'me'>, ownerRole: Promise<boolean | null>): Promise<ShareAccess | null> {
    if ((await ownerRole) !== true) return null
    const account = await api.me().catch(() => null)
    if (!account || !ownerCanWrite(account)) return null
    return { ownEmail: account.principal.email ?? null, inviteeNeeds: inviteeNeedsOf(account) }
}

/**
 * The vault key an invite is sealed and pinned with, opened with the key this device holds
 * (`wrapKey`: the one the Recovery Code gives, or the vault key itself). Refuses a graph whose
 * Graph Key the Encryption Keys do not hold, since there would be nothing to seal to the invitee.
 */
export async function vaultKeyForInvite(api: Pick<SyncApi, 'getVault'>, wrapKey: Uint8Array, graphId: string): Promise<Uint8Array> {
    const stored = await api.getVault()
    if (!stored) throw new NoVaultError()
    const opened = await openVault(fromBase64Url(stored.vault), wrapKey)
    if (!opened.vault.keyrings.some((keyring) => keyring.graphId === graphId)) throw new MissingGraphKeyError(graphId)
    return opened.vaultKey
}
