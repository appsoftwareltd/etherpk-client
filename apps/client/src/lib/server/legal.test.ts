import { describe, expect, it } from 'vitest'
import { clientLegalLinks } from './legal'

const managedEnvironment = {
    CLIENT_PUBLIC_URL: 'https://app.example.com',
    CORPORATE_ISSUER: 'https://www.example.com',
    MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
    MANAGED_SYNC_URL: 'https://sync.example.com',
    CLIENT_SESSION_SECRET: 'client-session-secret-at-least-32-bytes-long',
}

// The Client's footer and its /terms and /privacy routes.
describe('clientLegalLinks', () => {
    it('uses EtherPK pages on Corporate when the Client is managed, whatever the operator settings say', () => {
        expect(clientLegalLinks(managedEnvironment, { PUBLIC_TERMS_URL: 'https://example.org/terms' })).toEqual({
            termsUrl: 'https://www.example.com/terms',
            privacyUrl: 'https://www.example.com/privacy',
            contactUrl: 'https://www.example.com/contact',
        })
    })

    it("uses the operator's pages on a self-hosted Client", () => {
        expect(clientLegalLinks({}, {
            PUBLIC_TERMS_URL: 'https://example.org/terms',
            PUBLIC_PRIVACY_URL: 'https://example.org/privacy',
        })).toEqual({
            termsUrl: 'https://example.org/terms',
            privacyUrl: 'https://example.org/privacy',
            contactUrl: null,
        })
    })

    it('has no legal pages on a self-hosted Client that configures none', () => {
        expect(clientLegalLinks({}, {})).toEqual({ termsUrl: null, privacyUrl: null, contactUrl: null })
    })

    it('refuses a malformed operator page, naming the setting', () => {
        expect(() => clientLegalLinks({}, { PUBLIC_PRIVACY_URL: 'example.org/privacy' })).toThrow(/PUBLIC_PRIVACY_URL/)
    })
})
