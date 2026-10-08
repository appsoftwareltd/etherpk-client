import { describe, expect, it } from 'vitest'
import { buildAccountMenu, buildAdminMenu, isCurrentDestination } from './account-menu'

describe('buildAccountMenu', () => {
    it('lists the account and its billing, then access tokens and the administrator\'s pages in sections of their own', () => {
        expect(buildAccountMenu({
            accountUrl: 'https://www.example.com/account',
            billingUrl: 'https://www.example.com/billing',
            accessTokensUrl: 'https://sync.example.com/account/tokens',
            admin: buildAdminMenu({
                usersUrl: 'https://www.example.com/admin/users',
                storageUrl: 'https://sync.example.com/admin/storage',
            }),
        })).toEqual({
            account: [
                { label: 'Account', href: 'https://www.example.com/account' },
                { label: 'Billing', href: 'https://www.example.com/billing' },
            ],
            access: [{ label: 'Access tokens', href: 'https://sync.example.com/account/tokens' }],
            admin: [
                { label: 'Users', href: 'https://www.example.com/admin/users' },
                { label: 'Storage', href: 'https://sync.example.com/admin/storage' },
            ],
        })
    })

    // A standalone Server has no Billing, and someone who is not the administrator has no
    // administration section at all.
    it('leaves out what the deployment or the person does not have', () => {
        expect(buildAccountMenu({ accountUrl: '/account', billingUrl: null, accessTokensUrl: null })).toEqual({
            account: [{ label: 'Account', href: '/account' }],
            access: [],
            admin: [],
        })
    })
})

describe('isCurrentDestination', () => {
    const page = (href: string) => new URL(href)

    it('marks the link to the page being shown, and the pages beneath it', () => {
        expect(isCurrentDestination('/account', page('https://www.example.com/account'))).toBe(true)
        expect(isCurrentDestination('/admin/users', page('https://sync.example.com/admin/users/u1'))).toBe(true)
        expect(isCurrentDestination('https://www.example.com/billing', page('https://www.example.com/billing?x=1'))).toBe(true)
    })

    it('does not mark a link to another page, another origin or a mere prefix', () => {
        expect(isCurrentDestination('/billing', page('https://www.example.com/account'))).toBe(false)
        expect(isCurrentDestination('https://www.example.com/account', page('https://sync.example.com/account'))).toBe(false)
        expect(isCurrentDestination('/account', page('https://www.example.com/accounts'))).toBe(false)
    })
})
