import { describe, expect, it } from 'vitest'

import {
    NAV_EMAIL_MAX_CHARACTERS,
    PUBLIC_DOCS_URL,
    buildApplicationNavigation,
    buildAccountUrl,
    buildAdminUsersUrl,
    buildBillingUrl,
    buildHomeUrl,
    buildPricingUrl,
    buildClientDemoUrl,
    buildClientGraphsUrl,
    buildSyncAccessTokensUrl,
    buildSyncServerUrl,
    buildSyncStorageAdminUrl,
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

    // The administrator's pages on the managed service: Users is Corporate's, Storage the Server's.
    it('builds the administrator destinations on each origin', () => {
        expect(buildAdminUsersUrl('https://www.example.com')).toBe('https://www.example.com/admin/users')
        expect(buildSyncStorageAdminUrl('https://sync.example.com')).toBe('https://sync.example.com/admin/storage')
        expect(() => buildSyncStorageAdminUrl('https://sync.example.com/path')).toThrow('Sync Server origin')
    })

    // Access tokens are always the Sync Server's, so Corporate's account menu links there.
    it('builds the Sync Server access tokens destination', () => {
        expect(buildSyncAccessTokensUrl('https://sync.example.com')).toBe('https://sync.example.com/account/tokens')
        expect(() => buildSyncAccessTokensUrl('https://sync.example.com/path')).toThrow('Sync Server origin')
    })

    it('builds the public home that the Client names as its canonical marketing page', () => {
        expect(buildHomeUrl('https://www.example.com')).toBe('https://www.example.com/home')
        expect(buildHomeUrl('http://localhost:5275')).toBe('http://localhost:5275/home')
        expect(() => buildHomeUrl('https://www.example.com/home')).toThrow('Corporate origin')
    })

    // Account and Billing belong to the person, so they are in the account menu, never up here.
    it('carries only cross-application destinations, never Account or an application-local Dashboard', () => {
        expect(buildApplicationNavigation({
            managed: true,
            signedIn: true,
            syncServerUrl: 'https://sync.example.com/',
            pricingUrl: 'https://www.example.com/pricing',
            graphsUrl: 'https://app.example.com/graphs',
        })).toEqual([
            { href: 'https://sync.example.com/', label: 'Sync+', current: false },
            { href: 'https://app.example.com/graphs', label: 'Graphs', current: false },
            { href: PUBLIC_DOCS_URL, label: 'Docs', current: false },
        ])
    })

    it('ends with the public docs on every origin, managed or standalone', () => {
        for (const managed of [true, false]) {
            expect(buildApplicationNavigation({ managed, signedIn: false, graphsUrl: '/graphs' }).at(-1))
                .toEqual({ href: 'https://docs.etherpk.com', label: 'Docs', current: false })
        }
    })

    it('keeps Sync Server, Graphs and Docs in standalone mode and marks the current one', () => {
        expect(buildApplicationNavigation({
            managed: false,
            signedIn: true,
            syncServerUrl: 'https://sync.example.com/',
            graphsUrl: '/graphs',
            current: 'graphs',
        })).toEqual([
            { href: 'https://sync.example.com/', label: 'Sync Server', current: false },
            { href: '/graphs', label: 'Graphs', current: true },
            { href: PUBLIC_DOCS_URL, label: 'Docs', current: false },
        ])
    })

    // Sync+ is the managed service's plan, so only a managed deployment names its Sync Server
    // that, signed out included. A standalone one keeps the full name: a bare "Sync" would read as
    // the Graphs page's own Sync tab.
    it('names the Sync Server link by the deployment', () => {
        const label = (managed: boolean) =>
            buildApplicationNavigation({ managed, signedIn: true, syncServerUrl: 'https://sync.example.com/', graphsUrl: '/graphs' })[0]?.label
        expect(label(true)).toBe('Sync+')
        expect(label(false)).toBe('Sync Server')
    })

    // Someone signed out has no Sync+ account to open yet, so on the managed service the link shows
    // what Sync+ costs. A standalone Server sells nothing, so its link always opens the Server.
    it('sends a signed-out visitor\'s Sync+ link to the pricing page, and a signed-in one to the Server', () => {
        const syncLink = (managed: boolean, signedIn: boolean) => buildApplicationNavigation({
            managed,
            signedIn,
            syncServerUrl: 'https://sync.example.com/',
            pricingUrl: managed ? 'https://www.example.com/pricing' : null,
            graphsUrl: '/graphs',
        })[0]
        expect(syncLink(true, false)).toEqual({ href: 'https://www.example.com/pricing', label: 'Sync+', current: false })
        expect(syncLink(true, true)).toEqual({ href: 'https://sync.example.com/', label: 'Sync+', current: false })
        expect(syncLink(false, false)).toEqual({ href: 'https://sync.example.com/', label: 'Sync Server', current: false })
    })

    it('rejects unsafe or ambiguous navigation origins', () => {
        expect(() => parseNavigationOrigin('http://app.example.com', 'CLIENT_PUBLIC_URL'))
            .toThrow('CLIENT_PUBLIC_URL must use HTTPS except on localhost')
        expect(() => parseNavigationOrigin('https://app.example.com/subpath', 'CLIENT_PUBLIC_URL'))
            .toThrow('CLIENT_PUBLIC_URL must be an origin without a path, query, or fragment')
    })
})
