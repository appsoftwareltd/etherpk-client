import { describe, expect, it } from 'vitest'
import { ManagedTokenError } from '$lib/auth/managed-token'
import { EnvelopeError, KeyringConflictError, RecoveryCodeError } from '$lib/crypto'
import { NoVaultError } from './recovery-unlock'
import { SyncProtocolMismatchError } from './messages'
import { InviteNotAcceptedError, InviteeChangedError } from './invites'
import { ForeignIdentityError } from './account-identity'
import { ApprovalTamperedError } from './device-approval'
import { MissingGraphKeyError } from './keys'
import { SyncApiError } from './sync-api'
import { describeSyncFailure, isRetryableSyncFailure } from './sync-error-copy'
import { VaultLockedError } from './vault-session'
import { DevicePasscodeLockedError } from './device-passcode'

/** Chromium's exact wording when a transaction is opened on a closed IndexedDB connection. */
const CLOSING_CONNECTION = new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
)

describe('describeSyncFailure', () => {
    it('names the inviter and what to ask them for when an invite cannot be accepted (ADR 0126)', () => {
        const unsigned = describeSyncFailure(new InviteNotAcceptedError('unsigned', 'owner@example.com'), 'accept the invite')
        const unverifiable = describeSyncFailure(new InviteNotAcceptedError('unverifiable', null), 'accept the invite')
        const changed = describeSyncFailure(new InviteNotAcceptedError('key-changed', 'owner@example.com'), 'accept the invite')

        expect(unsigned).toBe(
            'Could not accept the invite. It was sent by an older version of EtherPK. Ask owner@example.com to send it again.',
        )
        expect(unverifiable).toContain('not signed with the owner’s security key')
        expect(changed).toContain('compare the new fingerprint')
        expect(isRetryableSyncFailure(new InviteNotAcceptedError('unsigned', null))).toBe(false)
    })

    it('says what to do about keys that changed or do not match, none of which a retry fixes', () => {
        const errors = [new InviteeChangedError(), new KeyringConflictError('g1', 1), new ForeignIdentityError()]

        expect(describeSyncFailure(errors[0], 'send the invite')).toContain('Look them up again')
        expect(describeSyncFailure(errors[1], 'accept the invite')).toContain('nothing was changed')
        expect(describeSyncFailure(errors[2], 'check your keys')).toContain('Do not send or accept invites')
        for (const error of errors) expect(isRetryableSyncFailure(error)).toBe(false)
    })

    it('reads the signed key-write refusals by their codes', () => {
        expect(describeSyncFailure(new SyncApiError('x', 403, 'key_signature_refused'), 'save your keys')).toContain(
            'not signed with the security key',
        )
        expect(describeSyncFailure(new SyncApiError('x', 409, 'invitee_keys_changed'), 'send the invite')).toContain(
            'Their keys changed',
        )
        expect(describeSyncFailure(new SyncApiError('x', 426, 'server_upgrade_required'), 'save your keys')).toContain(
            'older version of EtherPK',
        )
    })

    it('reads the removal and key-change refusals by their codes (ADR 0127)', () => {
        expect(describeSyncFailure(new SyncApiError('x', 409, 'remove_owner'), 'remove the member')).toBe(
            'Could not remove the member. The owner cannot be removed. Transfer the graph to someone else first, or delete it.',
        )
        expect(describeSyncFailure(new SyncApiError('x', 409, 'epoch_members_changed'), 'change the graph’s key')).toContain(
            'members changed',
        )
        expect(describeSyncFailure(new SyncApiError('x', 409, 'epoch_lease_lost'), 'change the graph’s key')).toContain('Try again')
        expect(describeSyncFailure(new SyncApiError('x', 403, 'epoch_signature_refused'), 'change the graph’s key')).toContain(
            'signatures',
        )
    })

    it('says a graph whose key the account does not hold cannot be read, and what to do, which a retry does not change', () => {
        const missing = new MissingGraphKeyError('g1')
        expect(describeSyncFailure(missing, 'open the graph')).toBe(
            'Could not open the graph. Your keys do not hold this graph’s key, so its documents cannot be read. Leave the graph, then ask its owner to invite you again.',
        )
        expect(isRetryableSyncFailure(missing)).toBe(false)
    })

    it('sends the operator of an older Sync Server to upgrade it, and says changes are kept', () => {
        const message = describeSyncFailure(new SyncProtocolMismatchError(1, 2), 'save your latest changes')
        expect(message).toContain('Could not save your latest changes.')
        expect(message).toContain('The Sync Server runs sync protocol 1 and this Client needs 2.')
        expect(message).toContain('operator')
        expect(message).toContain('kept on this device')
        expect(message).not.toContain('Reload')
    })

    it('tells the user to reload when the Client is older than the Sync Server', () => {
        const message = describeSyncFailure(new SyncProtocolMismatchError(3, 2), 'save your latest changes')
        expect(message).toContain('This Client runs sync protocol 2 and the Sync Server runs 3.')
        expect(message).toContain('Reload the page')
        expect(message).toContain('ask whoever runs this Client to upgrade it')
    })

    it('names the quota that was reached and what to do about it', () => {
        const error = new SyncApiError('HTTP 403', 403, 'owned_storage_limit', true)
        const message = describeSyncFailure(error, 'save the document')
        expect(message).toContain('Could not save the document.')
        expect(message).toContain('storage allowance')
        expect(message).toContain('larger plan')
        // The bare status code never reaches the user.
        expect(message).not.toContain('403')
    })

    // A custom server's connection holds a Personal Access Token, and has no sign-in to renew.
    // The refusal says which kind of connection it came from: on a device with several, the one
    // that failed need not be the selected one.
    it('says an access token was refused, and where to add a new one', () => {
        const refused = new SyncApiError('Unauthorized', 401, undefined, false, 'custom')

        const message = describeSyncFailure(refused, 'load your graphs')

        expect(message).toBe("Could not load your graphs. The sync server did not accept this device's access token. Add a new one in Sync settings, then retry.")
    })

    it('explains an expired session rather than reporting 401', () => {
        const message = describeSyncFailure(new SyncApiError('Unauthorized', 401), 'load your graphs')
        expect(message).toContain('sign-in to the sync server has expired')
        expect(message).not.toContain('401')
    })

    it('names an invite refusal by its code rather than as a generic conflict', () => {
        // The server refuses a self-invite and a reinvite of an active member with a code, and
        // "something else changed it first" would send the user to refresh a page that has
        // nothing new on it.
        expect(describeSyncFailure(new SyncApiError('HTTP 409', 409, 'invite_self'), 'send the invite')).toBe(
            'Could not send the invite. That is your own address. You already own this graph, so there is nobody to invite.',
        )
        expect(describeSyncFailure(new SyncApiError('HTTP 409', 409, 'invite_already_member'), 'send the invite')).toBe(
            'Could not send the invite. They are already a member of this graph.',
        )
    })

    it('tells an old Client or Headless Client to update when the server refuses the old shape (ADR 0125)', () => {
        expect(describeSyncFailure(new SyncApiError('HTTP 426', 426, 'upgrade_required'), 'start the approval')).toBe(
            'Could not start the approval. This version of EtherPK is too old for this Sync Server. Reload the page to get the latest version, or update the Headless Client.',
        )
    })

    it('says why an approval request was refused, rather than calling it rate limiting', () => {
        expect(describeSyncFailure(new SyncApiError('HTTP 429', 429, 'too_many_device_approvals'), 'start the approval')).toBe(
            'Could not start the approval. This account has too many approval requests open or made recently. Finish or cancel one, or wait a while, then try again.',
        )
    })

    it('passes on a tampered reveal in its own words', () => {
        expect(describeSyncFailure(new ApprovalTamperedError(), 'approve the device')).toBe(
            'Could not approve the device. The new device sent a key that does not match the one it promised. Someone may be interfering: reject this request.',
        )
    })

    it('tells the user to refresh on a conflict', () => {
        expect(describeSyncFailure(new SyncApiError('conflict', 409), 'rename it')).toContain('Refresh the page')
    })

    it('treats any other 5xx as transient and says nothing was changed', () => {
        const message = describeSyncFailure(new SyncApiError('boom', 502), 'delete the graph')
        expect(message).toContain('Nothing was changed')
    })

    it('falls back to the server message but still gives a next step', () => {
        const message = describeSyncFailure(new SyncApiError('Teapot', 418), 'do the thing')
        expect(message).toContain('Teapot')
        expect(message).toContain('Try again')
    })

    it('says a busy sign-in service is busy, and does not blame the connection', () => {
        // /auth/token answers 503 when Corporate is briefly unavailable. The connection is fine,
        // so the copy must not send the person to check it.
        const message = describeSyncFailure(new ManagedTokenError('Managed Sync sign-in is temporarily unavailable', 503), 'open the graph')
        expect(message).toBe('Could not open the graph. EtherPK sign-in is busy at the moment. You are still signed in - try again in a minute.')
        expect(message).not.toMatch(/connection/i)
    })

    it('explains a signed-out token answer as an ended sign-in', () => {
        expect(describeSyncFailure(new ManagedTokenError('Managed Sync sign-in is required', 401), 'open the graph'))
            .toBe('Could not open the graph. Your EtherPK sign-in has ended. Sign in again, then retry.')
    })

    it('reads a non-SyncApiError as a connection failure', () => {
        const message = describeSyncFailure(new TypeError('Failed to fetch'), 'reach the server')
        expect(message).toContain('could not be reached')
        expect(message).toContain('Failed to fetch')
        expect(message).toContain('Check your connection')
    })

    it('always starts with what the user was trying to do', () => {
        for (const error of [new SyncApiError('x', 403, 'owned_graph_limit'), new SyncApiError('x', 500), new Error('x')]) {
            expect(describeSyncFailure(error, 'invite them')).toMatch(/^Could not invite them\./)
        }
    })

    // Non-network failures used to fall through to "the sync server could not be reached", which
    // for a browser-storage or key fault pointed the user at the wrong cause entirely.
    it('names a closed browser-storage connection and says to reload, hiding the DOMException text', () => {
        const message = describeSyncFailure(CLOSING_CONNECTION, 'save your latest changes')
        expect(message).toContain('Could not save your latest changes.')
        expect(message).toContain('Reload the page')
        expect(message).not.toContain('IDBDatabase')
        expect(message).not.toContain('could not be reached')
    })

    it('explains a storage quota refusal as a device problem, not a server one', () => {
        const message = describeSyncFailure(new DOMException('quota', 'QuotaExceededError'), 'save the document')
        expect(message).toContain('run out of storage')
        expect(message).not.toContain('sync server')
    })

    it('tells a locked device how to unlock rather than reporting "Vault is locked"', () => {
        const message = describeSyncFailure(new VaultLockedError(), 'open the graph')
        expect(message).toContain('Recovery Code')
        expect(message).not.toContain('Vault is locked')
    })

    it('asks for the Device Passcode when the keys are protected by it, not for the Recovery Code', () => {
        const message = describeSyncFailure(new DevicePasscodeLockedError(), 'open the graph')
        expect(message).toBe('Could not open the graph. The keys on this device are protected by its passcode. Enter the passcode, then try again.')
        expect(isRetryableSyncFailure(new DevicePasscodeLockedError())).toBe(false)
    })

    it('reads a failed envelope as keys gone stale since they were unlocked, and points at unlocking with the Recovery Code', () => {
        // A wrong Recovery Code is refused at the unlock and never gets this far, so the copy
        // names the cause that remains. Unlocking with the code replaces the key held here, so
        // the message names the one button that does it.
        const message = describeSyncFailure(new EnvelopeError('sealed envelope authentication failed'), 'open the graph')
        expect(message).toContain('replaced or reset on another device')
        expect(message).toContain('Unlock Keys With Recovery Code')
        expect(message).toContain('approve this device from another device')
        expect(message).not.toContain('lock your keys')
        expect(message).not.toContain('envelope')
    })

    it('reads the Key Replacement refusals by their codes (ADR 0128)', () => {
        expect(describeSyncFailure(new SyncApiError('x', 400, 'new_identity_signature_refused'), 'replace your keys')).toBe(
            'Could not replace your keys. The Sync Server did not accept the signature made with your new keys. Nothing changed. Try again.',
        )
        expect(describeSyncFailure(new SyncApiError('x', 400, 'identity_unchanged'), 'replace your keys')).toContain('Nothing changed')
    })

    it('says an account with no keys has nothing to unlock yet', () => {
        expect(describeSyncFailure(new NoVaultError(), 'unlock your keys')).toBe(
            'Could not unlock your keys. This account has no encryption keys yet: they are created with your first synced graph.',
        )
    })

    it('never echoes a Recovery Code character back to the screen', () => {
        const message = describeSyncFailure(new RecoveryCodeError('invalid recovery code character "!"'), 'unlock your keys')
        expect(message).toContain('Recovery Code')
        expect(message).not.toContain('"!"')
    })

    it('still reads an unrelated AbortError as a connection failure', () => {
        const message = describeSyncFailure(new DOMException('The user aborted a request.', 'AbortError'), 'reach the server')
        expect(message).toContain('could not be reached')
    })
})

describe('isRetryableSyncFailure', () => {
    it('is false for a quota refusal, because trying again changes nothing', () => {
        expect(isRetryableSyncFailure(new SyncApiError('x', 403, 'owned_graph_limit'))).toBe(false)
    })

    it('is true for server faults, rate limits and conflicts', () => {
        expect(isRetryableSyncFailure(new SyncApiError('x', 500))).toBe(true)
        expect(isRetryableSyncFailure(new SyncApiError('x', 429))).toBe(true)
        expect(isRetryableSyncFailure(new SyncApiError('x', 409))).toBe(true)
    })

    it('is false for an ordinary permission refusal', () => {
        expect(isRetryableSyncFailure(new SyncApiError('x', 403))).toBe(false)
    })

    it('is true for a network failure', () => {
        expect(isRetryableSyncFailure(new TypeError('Failed to fetch'))).toBe(true)
    })

    it('is true for a closed storage connection, which reopens on the next attempt', () => {
        expect(isRetryableSyncFailure(CLOSING_CONNECTION)).toBe(true)
    })

    it('is false for a protocol mismatch, which retrying cannot fix', () => {
        expect(isRetryableSyncFailure(new SyncProtocolMismatchError(1, 2))).toBe(false)
    })

    it('is false for a storage quota refusal and for key faults, which retrying cannot fix', () => {
        expect(isRetryableSyncFailure(new DOMException('quota', 'QuotaExceededError'))).toBe(false)
        expect(isRetryableSyncFailure(new VaultLockedError())).toBe(false)
        expect(isRetryableSyncFailure(new EnvelopeError('authentication failed'))).toBe(false)
    })
})
