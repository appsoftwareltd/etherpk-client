/**
 * Turn a sync failure into a sentence a user can act on (AGENTS.md rule 6: what happened, why,
 * what next).
 *
 * The prevailing pattern was `Could not X: ${(e as Error).message}`, which surfaces whatever
 * `SyncApiError` carried: usually a bare "HTTP 403". That names neither the cause nor the next
 * step, and a quota refusal in particular is not a fault the user can debug from a status code.
 *
 * Pure, so the mapping is unit tested rather than inferred from a screenshot.
 */
import type { QuotaErrorCode } from '@appsoftwareltd/etherpk-shared'
import { ManagedTokenError } from '$lib/auth/managed-token'
import { EnvelopeError, KeyringConflictError, RecoveryCodeError } from '$lib/crypto'
import { NoVaultError } from './recovery-unlock'
import { InviteNotAcceptedError, InviteeChangedError } from './invites'
import { ForeignIdentityError } from './account-identity'
import { ApprovalTamperedError } from './device-approval'
import { MissingGraphKeyError } from './keys'
import { SyncProtocolMismatchError } from './messages'
import { SyncApiError } from './sync-api'
import { DevicePasscodeLockedError } from './device-passcode'
import { VaultLockedError } from './vault-session'

/** What the server refused, and what the user can do about it. */
const QUOTA_COPY: Record<QuotaErrorCode, string> = {
    entitlement_inactive:
        'This account cannot write to Managed Sync at the moment. Check your plan on the billing page, then try again.',
    owned_graph_limit:
        'You have reached the number of graphs your plan allows you to own. Delete a graph you no longer need, or move to a larger plan.',
    owned_storage_limit:
        'You have reached your plan’s storage allowance. Delete unused documents or assets, or move to a larger plan.',
    players_per_graph_limit:
        'This graph already has as many players as your plan allows. Remove a player, or move to a larger plan.',
    asset_size_limit: 'That file is larger than your plan allows. Try a smaller file, or move to a larger plan.',
    asset_chunk_limit: 'That file is larger than your plan allows. Try a smaller file, or move to a larger plan.',
    ownership_transfer_limit:
        'The person you chose cannot take this graph on: it would exceed their own plan allowance. Ask them to make room, or choose someone else.',
}

const QUOTA_CODES = new Set(Object.keys(QUOTA_COPY))

/**
 * Refusals the server names with a code because the generic status copy would mislead: a 409
 * on an invite is not "something else changed it first", it is the address the user typed.
 */
/** Inviting your own address: the server's `invite_self`, and the invite dialog's own check. */
export const INVITE_SELF_COPY = 'That is your own address. You already own this graph, so there is nobody to invite.'

const REFUSAL_COPY: Record<string, string> = {
    invite_self: INVITE_SELF_COPY,
    invite_already_member: 'They are already a member of this graph.',
    ownership_changed: 'The graph changed hands while this ran. Refresh the page to see who owns it now.',
    asset_complete: 'This file has already been uploaded. Add it again to create a new copy.',
    asset_manifest_mismatch: 'This upload no longer matches the file it started with. Add the file again.',
    // Device approval (ADR 0125).
    upgrade_required:
        'This version of EtherPK is too old for this Sync Server. Reload the page to get the latest version, or update the Headless Client.',
    too_many_device_approvals:
        'This account has too many approval requests open or made recently. Finish or cancel one, or wait a while, then try again.',
    already_answered: 'Another of your devices is already handling this request.',
    commitment_mismatch: 'This device sent a key that does not match the one it promised. Start again.',
    // Signed Sync Identities (ADR 0126).
    key_signature_refused:
        'The Sync Server refused it because it is not signed with the security key the server holds for your account. If you replaced your Encryption Keys on another device, unlock this device again. Otherwise, contact whoever runs the server.',
    invite_signature_refused: 'The Sync Server did not accept the signature on the invite. Reload the page, then try again.',
    invitee_changed: 'That address belongs to a different account now. Look them up again.',
    invitee_keys_changed: 'Their Encryption Keys changed after you looked them up. Look them up again and compare the new fingerprint.',
    identity_required: 'Your security key has to be published before this change. Reload the page, then try again.',
    server_upgrade_required: 'This Sync Server runs an older version of EtherPK than this app. Ask whoever runs it to update it.',
    // Removal and Graph Key epochs (ADR 0127).
    remove_owner: 'The owner cannot be removed. Transfer the graph to someone else first, or delete it.',
    epoch_lease_lost: 'Another of your devices was changing the graph’s key at the same time. Try again.',
    epoch_members_changed: 'The graph’s members changed while its key was being changed. Try again.',
    epoch_recipient_keys_changed: 'A member’s Encryption Keys changed while the graph’s Graph Key was being changed. Try again.',
    epoch_signature_refused: 'The Sync Server did not accept the signatures on the new key. Reload the page, then try again.',
    // Key Replacement (ADR 0128).
    new_identity_signature_refused: 'The Sync Server did not accept the signature made with your new Encryption Keys. Nothing changed. Try again.',
    identity_unchanged: 'The new Encryption Keys matched the old ones, so the Sync Server refused them. Nothing changed. Try again.',
}

function isQuotaCode(code: string | undefined): code is QuotaErrorCode {
    return code !== undefined && QUOTA_CODES.has(code)
}

/**
 * Browser storage faults arrive as DOMExceptions, and `name` is the only stable signal in
 * them. `AbortError` and `InvalidStateError` are shared with fetch and other APIs, so the
 * message is consulted too: Chromium's reads "Failed to execute 'transaction' on
 * 'IDBDatabase': The database connection is closing." and the others name the database or
 * the version in the same way.
 */
const STORAGE_CONNECTION_FAULTS = new Set(['InvalidStateError', 'AbortError', 'VersionError'])
const STORAGE_MESSAGE = /IDB|IndexedDB|database|transaction|version/i

/** A closed or superseded browser-storage connection: the next attempt reopens it. */
export function isStorageConnectionFault(error: unknown): boolean {
    return (
        error instanceof Error &&
        STORAGE_CONNECTION_FAULTS.has(error.name) &&
        STORAGE_MESSAGE.test(error.message)
    )
}

function describeStorageFault(error: unknown): string | null {
    if (!(error instanceof Error)) return null
    if (error.name === 'QuotaExceededError') {
        return 'This browser has run out of storage for your notes. Free up space on the device, or forget a graph you no longer need here, then try again.'
    }
    if (isStorageConnectionFault(error)) {
        return 'This tab lost its connection to the browser’s storage. Reload the page - work already saved on this device is still here.'
    }
    return null
}

/**
 * A sentence explaining a failed sync call, prefixed by what the user was doing.
 *
 * `action` reads as the start of the sentence, e.g. `describeSyncFailure(error, 'delete the
 * graph')` produces "Could not delete the graph. ...". Keep it a bare verb phrase.
 */
export function describeSyncFailure(error: unknown, action: string): string {
    const opening = `Could not ${action}.`

    if (error instanceof SyncApiError) {
        if (isQuotaCode(error.code)) return `${opening} ${QUOTA_COPY[error.code]}`
        if (error.code && error.code in REFUSAL_COPY) return `${opening} ${REFUSAL_COPY[error.code]}`

        switch (error.status) {
            case 401:
                // A custom server's connection holds an access token and has no sign-in to renew.
                return error.connectionKind === 'custom'
                    ? `${opening} The sync server did not accept this device's access token. Add a new one in Sync settings, then retry.`
                    : `${opening} Your sign-in to the sync server has expired. Sign in again, then retry.`
            case 403:
                return `${opening} The sync server refused it: this account does not have permission. If you expected to, check you are signed in as the right account.`
            case 404:
                return `${opening} The sync server no longer has it. Refresh the page to see the current state.`
            case 409:
                return `${opening} Something else changed it first. Refresh the page and try again.`
            case 429:
                return `${opening} The sync server is rate limiting this account. Wait a moment, then try again.`
            case 503:
                return `${opening} The sync server is temporarily unavailable. Try again in a moment.`
        }
        if (error.status >= 500) {
            return `${opening} The sync server failed while handling it. Nothing was changed - try again in a moment.`
        }
        // A code or message the map does not know: still say what to do next.
        return `${opening} The sync server said: ${error.message}. Try again, and check your connection if it persists.`
    }

    // The Client's own /auth/token, not the sync server. A 503 there means Corporate was briefly
    // busy and the session is intact; blaming the connection would send people to check their
    // network. The browser has already waited and asked again before this shows.
    if (error instanceof ManagedTokenError) {
        if (error.status === 401) return `${opening} Your EtherPK sign-in has ended. Sign in again, then retry.`
        if (error.status === 503 || error.status === 429) {
            return `${opening} EtherPK sign-in is busy at the moment. You are still signed in - try again in a minute.`
        }
    }

    if (error instanceof InviteNotAcceptedError) {
        const inviter = error.inviterEmail ?? 'the owner'
        switch (error.reason) {
            case 'unsigned':
                return `${opening} It was sent by an older version of EtherPK. Ask ${inviter} to send it again.`
            case 'unverifiable':
                return `${opening} It is not signed with ${inviter}’s security key, so it may have been changed on the way. Ask ${inviter} to send it again.`
            case 'key-changed':
                return `${opening} ${inviter}’s security key changed while you were checking it. Open the invite again and compare the new fingerprint.`
        }
    }
    if (error instanceof InviteeChangedError) {
        return `${opening} Their account or Encryption Keys changed after you looked them up. Look them up again and compare the new fingerprint.`
    }
    if (error instanceof KeyringConflictError) {
        return `${opening} The key in the invite does not match the key you already hold for this graph, so nothing was changed. Ask the owner to send the invite again.`
    }
    if (error instanceof MissingGraphKeyError) {
        return `${opening} Your Encryption Keys do not include this graph’s Graph Key, so its documents cannot be read. Leave the graph, then ask its owner to invite you again.`
    }
    if (error instanceof ForeignIdentityError) {
        return `${opening} The Sync Server publishes a security key for your account that does not match your Encryption Keys, and refused to replace it. Do not send or accept invites on this server until whoever runs it has looked into it.`
    }

    if (error instanceof ApprovalTamperedError) return `${opening} ${error.message}`

    // Which side is older decides who can fix it: an old server needs its operator, an old
    // Client needs a reload (or an upgrade by whoever runs it). Pending appends stay in the
    // cache, so saying the changes are kept is true in both cases.
    if (error instanceof SyncProtocolMismatchError) {
        return error.serverIsOlder
            ? `${opening} The Sync Server runs sync protocol ${error.serverVersion} and this Client needs ${error.clientVersion}. Its operator needs to upgrade the server - until then your changes are kept on this device.`
            : `${opening} This Client runs sync protocol ${error.clientVersion} and the Sync Server runs ${error.serverVersion}. Reload the page to get the latest Client, or ask whoever runs this Client to upgrade it. Your changes are kept on this device.`
    }

    // Key faults are device problems. Reporting them as "server could not be reached" sent
    // users to check their connection when the fix was in Sync settings (2026-09-01).
    if (error instanceof DevicePasscodeLockedError) {
        return `${opening} The Encryption Keys on this device are protected by its passcode. Enter the passcode, then try again.`
    }
    if (error instanceof VaultLockedError) {
        return `${opening} Your Encryption Keys are locked on this device. Unlock them with your Recovery Code, or by approving from another device that is unlocked, then try again.`
    }
    if (error instanceof EnvelopeError) {
        // A wrong Recovery Code is refused at the unlock (recovery-unlock.ts), so keys that open
        // nothing were unlocked correctly and have since gone stale: the account's keys were reset
        // on another device. Saying so stops a person retyping the same code; unlocking with the
        // code replaces the key held here.
        return `${opening} Your Encryption Keys were replaced or reset on another device, so the Encryption Keys unlocked here no longer open your account’s data. Unlock this device again: on the Sync tab, select Unlock Encryption Keys, then approve it from another device or use your new Recovery Code.`
    }
    if (error instanceof NoVaultError) {
        return `${opening} This account has no Encryption Keys yet. They are created with your first synced graph.`
    }
    if (error instanceof RecoveryCodeError) {
        // Never echo the offending character: it is one keystroke away from the real code.
        return `${opening} That Recovery Code was not accepted. Check it character by character - only the most recently issued code is valid.`
    }

    const storage = describeStorageFault(error)
    if (storage) return `${opening} ${storage}`

    // Almost always a network failure: fetch rejects rather than resolving with a status.
    const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
    return `${opening} The sync server could not be reached${detail}. Check your connection, then try again.`
}

/** True when retrying the same request could plausibly succeed. */
export function isRetryableSyncFailure(error: unknown): boolean {
    if (error instanceof VaultLockedError || error instanceof EnvelopeError || error instanceof RecoveryCodeError || error instanceof NoVaultError) {
        return false // the keys will not change by trying again
    }
    if (error instanceof SyncProtocolMismatchError) return false
    // Trying the same invite or key write again changes none of these: the keys have to.
    if (
        error instanceof InviteNotAcceptedError ||
        error instanceof InviteeChangedError ||
        error instanceof KeyringConflictError ||
        error instanceof ForeignIdentityError ||
        error instanceof MissingGraphKeyError
    ) {
        return false
    }
    if (error instanceof Error && error.name === 'QuotaExceededError') return false
    if (!(error instanceof SyncApiError)) return true // network and storage-connection failures are worth retrying
    if (isQuotaCode(error.code)) return false // the allowance will not change by trying again
    return error.status >= 500 || error.status === 429 || error.status === 409
}
