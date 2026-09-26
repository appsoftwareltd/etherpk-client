import { describe, expect, it } from 'vitest'
import { ManagedTokenError } from '$lib/auth/managed-token'
import { EnvelopeError, RecoveryCodeError } from '$lib/crypto'
import { NoVaultError } from './recovery-unlock'
import { SyncProtocolMismatchError } from './messages'
import { InviteForHeldGraphError } from './invites'
import { SyncApiError } from './sync-api'
import { describeSyncFailure, isRetryableSyncFailure } from './sync-error-copy'
import { VaultLockedError } from './vault-session'

/** Chromium's exact wording when a transaction is opened on a closed IndexedDB connection. */
const CLOSING_CONNECTION = new DOMException(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    'InvalidStateError',
)

describe('describeSyncFailure', () => {
    it('says an invite for a graph already held was refused and nothing changed', () => {
        const message = describeSyncFailure(new InviteForHeldGraphError('g1'), 'accept the invite')
        expect(message).toContain('Could not accept the invite.')
        expect(message).toContain('already')
        expect(message).toContain('refused')
        expect(isRetryableSyncFailure(new InviteForHeldGraphError('g1'))).toBe(false)
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
        expect(message).toBe('Could not open the graph. EtherPK sign-in is busy at the moment. You are still signed in; try again in a minute.')
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

    it('reads a failed envelope as keys gone stale since they were unlocked, and points at lock-then-unlock', () => {
        // A wrong Recovery Code is refused at the unlock and never gets this far, so the copy
        // names the cause that remains instead of sending someone to retype the same code.
        const message = describeSyncFailure(new EnvelopeError('sealed envelope authentication failed'), 'open the graph')
        expect(message).toContain('reset on another device')
        expect(message).toContain('lock your keys, then unlock them again')
        expect(message).not.toContain('envelope')
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
