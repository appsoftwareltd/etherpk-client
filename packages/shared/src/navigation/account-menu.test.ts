import { describe, expect, it } from 'vitest'
import { buildAccountMenu } from './account-menu'

describe('buildAccountMenu', () => {
    it('lists the app\'s own page, then the account, its billing, access tokens and administration', () => {
        expect(buildAccountMenu({
            home: { label: 'Dashboard', href: '/dashboard' },
            accountUrl: 'https://www.example.com/account',
            billingUrl: 'https://www.example.com/billing',
            accessTokensUrl: '/account/tokens',
            admin: [{ label: 'Users', href: '/admin/users' }],
        })).toEqual([
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Account', href: 'https://www.example.com/account' },
            { label: 'Billing', href: 'https://www.example.com/billing' },
            { label: 'Access tokens', href: '/account/tokens' },
            { label: 'Users', href: '/admin/users' },
        ])
    })

    it('leaves out what the deployment does not have', () => {
        expect(buildAccountMenu({ accountUrl: '/account', billingUrl: null, accessTokensUrl: null })).toEqual([
            { label: 'Account', href: '/account' },
        ])
    })
})
