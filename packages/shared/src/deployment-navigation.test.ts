import { describe, expect, it } from 'vitest'

import {
    NAV_EMAIL_MAX_CHARACTERS,
    PUBLIC_DOCS_URL,
    buildApplicationNavigation,
    buildAccountUrl,
    buildBillingUrl,
    buildHomeUrl,
    buildPricingUrl,
    buildClientDemoUrl,
    buildClientGraphsUrl,
    buildSyncServerUrl,
    parseNavigationOrigin,
    truncateNavigationEmail,
} from './deployment-navigation'

describe('deployment navigation', () => {
    it('keeps a short signed-in email unchanged', () => {
        expect(truncateNavigationEmail('person@example.com')).toBe('person@example.com')
    })

    it('uses three ASCII dots while keeping the display to the fixed character limit', () => {
        const email = 'a-very-long-account-name@example.com'
        const displayed = truncateNavigationEmail(email)

        expect(displayed).toBe('a-very-long-account-name@...')
        expect(displayed).toHaveLength(NAV_EMAIL_MAX_CHARACTERS)
    })

    it('builds the Client graphs destination from a validated application origin', () => {
        expect(buildClientGraphsUrl('https://app.example.com')).toBe('https://app.example.com/graphs')
        expect(buildClientGraphsUrl('http://localhost:5174')).toBe('http://localhost:5174/graphs')
    })

    it('builds the Client demo destination from the same origin', () => {
        expect(buildClientDemoUrl('https://app.example.com')).toBe('https://app.example.com/demo')
        expect(() => buildClientDemoUrl('https://app.example.com/path')).toThrow('CLIENT_PUBLIC_URL')
    })

    it('builds shared Account and Sync Server navigation destinations', () => {
        expect(buildAccountUrl('https://www.example.com')).toBe('https://www.example.com/account')
        expect(buildBillingUrl('https://www.example.com')).toBe('https://www.example.com/billing')
        expect(buildPricingUrl('https://www.example.com')).toBe('https://www.example.com/pricing')
        expect(buildSyncServerUrl('https://sync.example.com')).toBe('https://sync.example.com/')
        expect(buildSyncServerUrl('http://sync.localhost:5273')).toBe('http://sync.localhost:5273/')
    })

    it('builds the public home that the Client names as its canonical marketing page', () => {
        expect(buildHomeUrl('https://www.example.com')).toBe('https://www.example.com/home')
        expect(buildHomeUrl('http://localhost:5275')).toBe('http://localhost:5275/home')
        expect(() => buildHomeUrl('https://www.example.com/home')).toThrow('Corporate origin')
    })

    it('carries only cross-application destinations, never an application-local Dashboard', () => {
        expect(buildApplicationNavigation({
            accountUrl: 'https://www.example.com/account',
            syncServerUrl: 'https://sync.example.com/',
            graphsUrl: '/graphs',
            current: 'account',
        })).toEqual([
            { href: 'https://www.example.com/account', label: 'Account', current: true },
            { href: 'https://sync.example.com/', label: 'Sync Server', current: false },
            { href: '/graphs', label: 'Graphs', current: false },
        ])
    })

    it('appends the public docs last, only when Corporate offers them', () => {
        const withDocs = buildApplicationNavigation({ graphsUrl: '/graphs', docsUrl: PUBLIC_DOCS_URL })
        expect(withDocs.at(-1)).toEqual({ href: 'https://docs.etherpk.com', label: 'Docs', current: false })
        expect(buildApplicationNavigation({ graphsUrl: '/graphs' }).map((item) => item.label)).not.toContain('Docs')
    })

    it('orders every managed application destination consistently', () => {
        expect(buildApplicationNavigation({
            accountUrl: 'https://www.example.com/account',
            syncServerUrl: 'https://sync.example.com/',
            graphsUrl: 'https://app.example.com/graphs',
        })).toEqual([
            { href: 'https://www.example.com/account', label: 'Account', current: false },
            { href: 'https://sync.example.com/', label: 'Sync Server', current: false },
            { href: 'https://app.example.com/graphs', label: 'Graphs', current: false },
        ])
    })

    it('omits Account while retaining Sync Server and Graphs in standalone mode', () => {
        expect(buildApplicationNavigation({
            accountUrl: null,
            syncServerUrl: 'https://sync.example.com/',
            graphsUrl: '/graphs',
            current: 'graphs',
        })).toEqual([
            { href: 'https://sync.example.com/', label: 'Sync Server', current: false },
            { href: '/graphs', label: 'Graphs', current: true },
        ])
    })

    it('rejects unsafe or ambiguous navigation origins', () => {
        expect(() => parseNavigationOrigin('http://app.example.com', 'CLIENT_PUBLIC_URL'))
            .toThrow('CLIENT_PUBLIC_URL must use HTTPS except on localhost')
        expect(() => parseNavigationOrigin('https://app.example.com/subpath', 'CLIENT_PUBLIC_URL'))
            .toThrow('CLIENT_PUBLIC_URL must be an origin without a path, query, or fragment')
    })
})
