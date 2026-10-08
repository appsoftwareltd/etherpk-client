import { describe, expect, it } from 'vitest'
import { SyncApiError } from '$lib/sync/sync-api'
import { describeConnectionFailure } from './connection-errors'

const SERVER = 'https://sync.example.com'

/** What Node's fetch throws when it cannot connect: a TypeError with the socket error as its cause. */
function fetchFailed(code: string): TypeError {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
}

describe('describeConnectionFailure', () => {
    it('says an address that is not a Sync Server is not one, and where to find the right one', () => {
        expect(describeConnectionFailure(new SyncApiError('HTTP 404', 404), SERVER)).toBe(
            'https://sync.example.com is not a Sync Server (it may be the EtherPK app). Use the Sync Server address shown in EtherPK under a synced graph\'s Settings > Agents.',
        )
    })

    it('says a refused token was refused, and how to sign in again', () => {
        expect(describeConnectionFailure(new SyncApiError('Unauthorized', 401), SERVER)).toBe(
            'https://sync.example.com did not accept the token: it may have been revoked, mistyped, or left unused for 30 days. Make a setup code in EtherPK (a synced graph\'s Settings > Agents) and run login again.',
        )
    })

    it.each([
        ['ENOTFOUND', 'the host was not found. Check the address.'],
        ['ECONNREFUSED', 'the connection was refused. Check the address and that the server is running.'],
        ['ERR_SSL_WRONG_VERSION_NUMBER', 'the secure connection failed. Check whether the server uses https or http.'],
        ['CERT_HAS_EXPIRED', 'the secure connection failed. Check whether the server uses https or http.'],
        ['ETIMEDOUT', 'it did not answer (ETIMEDOUT).'],
    ])('names %s in words', (code, reason) => {
        expect(describeConnectionFailure(fetchFailed(code), SERVER)).toBe(`Could not connect to ${SERVER}: ${reason}`)
    })

    it('leaves any other failure to be reported as it is', () => {
        expect(describeConnectionFailure(new SyncApiError('The graph is read-only.', 409), SERVER)).toBeNull()
        expect(describeConnectionFailure(new Error('something else'), SERVER)).toBeNull()
    })
})
