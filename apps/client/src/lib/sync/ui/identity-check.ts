/**
 * The own-key check (ADR 0126) as the app runs it: in the background, the first time a page uses
 * an account's keys, and with what it finds told to the user in the notice rail.
 *
 * The check publishes the vault's identity again when the server was publishing another. The user
 * must hear about it, because an invite sent to them meanwhile may have been sealed to somebody
 * else's key. It never blocks opening a graph: the keys work either way, and a check that fails for
 * any other reason is tried again on the next use.
 */
import { showNotice } from '$lib/activity/notices'
import { ForeignIdentityError, ensureAccountIdentity } from '../account-identity'
import type { SyncApi } from '../sync-api'
import { serverHost } from '../sync-connections'

/** The accounts checked since this page loaded, as `origin|account`. */
const checked = new Set<string>()

/**
 * Check the identity of the account on `origin` once per page load. Never rejects.
 * `account` is the account's id where known, so another account signing in here is checked too.
 */
export async function checkAccountIdentity(
    api: Pick<SyncApi, 'getVault' | 'putKeys' | 'getIdentity'>,
    heldKey: Uint8Array,
    origin: string,
    account: string | null | undefined,
): Promise<void> {
    const key = `${origin}|${account ?? ''}`
    if (checked.has(key)) return
    checked.add(key)
    try {
        const result = await ensureAccountIdentity(api, heldKey)
        if (result.repaired) reportIdentityRepair(origin)
    } catch (error) {
        if (error instanceof ForeignIdentityError) {
            reportForeignIdentity(origin)
            return
        }
        // Unreachable server, locked keys, a conflict that kept losing: try again on the next use.
        checked.delete(key)
        console.warn('[keys] could not check the identity the Sync Server publishes for this account', error)
    }
}

/** The server was publishing a key for the account that is not in its vault, and now publishes the vault's. */
export function reportIdentityRepair(origin: string): void {
    const host = serverHost(origin)
    showNotice({
        id: `identity-repaired:${origin}`,
        tone: 'error',
        title: `Your security key was replaced on ${host}`,
        text: `${host} was publishing a security key for your account that does not match your keys. EtherPK has published your own key again. If someone invited you, or accepted an invite from you, since you last used EtherPK, compare security fingerprints with them again.`,
    })
}

function reportForeignIdentity(origin: string): void {
    const host = serverHost(origin)
    showNotice({
        id: `identity-foreign:${origin}`,
        tone: 'error',
        title: `${host} publishes a security key that is not yours`,
        text: `It refused to publish your own key in its place. Do not send or accept invites on ${host} until whoever runs it has looked into it.`,
        footnote: 'Troubleshooting in the EtherPK user docs says what they need to do.',
    })
}
