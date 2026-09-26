import { isHttpError, isRedirect } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import { managedLegalLinks, parseLegalPageUrl, serveLegalPage } from './legal-links'

// A managed deployment's legal pages are EtherPK's, and Corporate serves the one copy. A
// self-hosted deployment belongs to its operator, whose pages are wherever they say, or nowhere.
describe('managedLegalLinks', () => {
    it('points at the Terms, Privacy and Contact pages on Corporate', () => {
        expect(managedLegalLinks('https://www.etherpk.com')).toEqual({
            termsUrl: 'https://www.etherpk.com/terms',
            privacyUrl: 'https://www.etherpk.com/privacy',
            contactUrl: 'https://www.etherpk.com/contact',
        })
    })

    it('accepts a loopback Corporate origin for development and e2e', () => {
        expect(managedLegalLinks('http://localhost:5175').termsUrl).toBe('http://localhost:5175/terms')
    })
})

describe('parseLegalPageUrl', () => {
    it('is null when the operator has not set one', () => {
        expect(parseLegalPageUrl(undefined, 'TERMS_URL')).toBeNull()
        expect(parseLegalPageUrl('   ', 'TERMS_URL')).toBeNull()
    })

    it('accepts an HTTPS page anywhere, with a path and a fragment', () => {
        expect(parseLegalPageUrl(' https://example.com/legal/terms#service ', 'TERMS_URL'))
            .toBe('https://example.com/legal/terms#service')
    })

    it('refuses a relative, non-web or plain-HTTP address, naming the setting', () => {
        expect(() => parseLegalPageUrl('/terms', 'TERMS_URL')).toThrow(/TERMS_URL/)
        expect(() => parseLegalPageUrl('javascript:alert(1)', 'PRIVACY_URL')).toThrow(/PRIVACY_URL/)
        expect(() => parseLegalPageUrl('http://example.com/terms', 'TERMS_URL')).toThrow(/HTTPS/)
    })

    it('allows plain HTTP on loopback, as the other deployment URLs do', () => {
        expect(parseLegalPageUrl('http://localhost:8080/terms', 'TERMS_URL')).toBe('http://localhost:8080/terms')
    })

    it('refuses credentials in the URL', () => {
        expect(() => parseLegalPageUrl('https://user:pass@example.com/terms', 'TERMS_URL')).toThrow(/credentials/)
    })
})

describe('serveLegalPage', () => {
    function thrown(action: () => unknown): unknown {
        try {
            action()
        } catch (caught) {
            return caught
        }
        throw new Error('expected serveLegalPage to throw')
    }

    it('redirects to the configured page', () => {
        const result = thrown(() => serveLegalPage('https://example.com/terms'))
        expect(isRedirect(result)).toBe(true)
        expect(result).toMatchObject({ status: 307, location: 'https://example.com/terms' })
    })

    it('answers 404 when the deployment has no such page', () => {
        const result = thrown(() => serveLegalPage(null))
        expect(isHttpError(result)).toBe(true)
        expect(result).toMatchObject({ status: 404 })
    })
})
