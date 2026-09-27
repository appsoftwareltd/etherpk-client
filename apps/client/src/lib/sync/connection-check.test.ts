import { describe, expect, it } from 'vitest'

import { describeConnectionCheckFailure } from './connection-check'
import { SyncApiError } from './sync-api'

const SERVER = 'https://sync.example.com/'

describe('describeConnectionCheckFailure', () => {
    it('puts a refused token at the token field, with where to make a new one', () => {
        expect(describeConnectionCheckFailure(new SyncApiError('Unauthorized', 401), SERVER)).toEqual({
            field: 'token',
            message: 'This server did not accept the token. It may be mistyped, expired, revoked or limited to some graphs. Create one for your whole account on the server\'s Access tokens page.',
            tokensUrl: 'https://sync.example.com/account/tokens',
        })
    })

    // The app's own address answers the account lookup with its 404 page, or a page that is not JSON.
    it('says an address that is not a Sync Server is not one', () => {
        const notAServer = {
            field: 'url',
            message: "That address is not an EtherPK Sync Server. Use the server's address, not the app's.",
        }
        expect(describeConnectionCheckFailure(new SyncApiError('HTTP 404', 404), SERVER)).toEqual(notAServer)
        expect(describeConnectionCheckFailure(new SyntaxError('Unexpected token <'), SERVER)).toEqual(notAServer)
    })

    it('says a server that cannot be reached could not be reached, at the address field', () => {
        expect(describeConnectionCheckFailure(new TypeError('Failed to fetch'), SERVER)).toEqual({
            field: 'url',
            message: 'Could not reach https://sync.example.com. Check the address and your connection. If both are right, ask the server\'s administrator whether it accepts connections from this app.',
        })
    })

    it('reports any other answer from the server at the address field', () => {
        const failure = describeConnectionCheckFailure(new SyncApiError('Service unavailable', 503), SERVER)
        expect(failure.field).toBe('url')
        expect(failure.message).not.toBe('')
    })
})
