/**
 * The account menu's links, the same on every origin: the person's EtherPK account and, on the
 * managed service, its billing, then their access tokens and the administrator's pages, each in
 * a section of their own. Access tokens are always the Sync Server's, but they are how a person
 * signs a program in as themselves, so the menu offers them on every origin rather than leaving
 * them to be found on the Server. The menu never repeats the top navigation
 * (`buildApplicationNavigation`), so an app's own signed-in page is not here. Each app passes the
 * destinations it has. The sign-out buttons stay each app's own, since each ends a different
 * session.
 */

export interface AccountMenuItem {
    label: string
    href: string
}

export interface AccountMenu {
    /** Account, then Billing where Sync+ is paid for. */
    account: AccountMenuItem[]
    /** The Sync Server's Access tokens page, where the person has a Sync Server. */
    access: AccountMenuItem[]
    /** The administrator's pages (`buildAdminMenu`); empty for everyone else. */
    admin: AccountMenuItem[]
}

export function buildAccountMenu(options: {
    accountUrl?: string | null
    /** Where Sync+ is paid for: the managed service only. */
    billingUrl?: string | null
    accessTokensUrl?: string | null
    admin?: AccountMenuItem[]
}): AccountMenu {
    return {
        account: [
            options.accountUrl ? { label: 'Account', href: options.accountUrl } : null,
            options.billingUrl ? { label: 'Billing', href: options.billingUrl } : null,
        ].filter((item): item is AccountMenuItem => item !== null),
        access: options.accessTokensUrl ? [{ label: 'Access tokens', href: options.accessTokensUrl }] : [],
        admin: options.admin ?? [],
    }
}

/**
 * The administrator's pages, one list wherever they are offered. On the managed service Users is
 * Corporate's (the EtherPK accounts; the Server's own Users page reads Better Auth, which a
 * managed Server switches off) and Storage is the Sync Server's. A standalone Server has both.
 */
export function buildAdminMenu(urls: { usersUrl: string; storageUrl: string }): AccountMenuItem[] {
    return [
        { label: 'Users', href: urls.usersUrl },
        { label: 'Storage', href: urls.storageUrl },
    ]
}

/**
 * Whether a menu link leads to the page being shown, or to a page beneath it, so the menu can mark
 * it as the top navigation marks its own. A link to another origin never matches, and a path only
 * matches whole segments: /account is not current on /accounts.
 */
export function isCurrentDestination(href: string, current: URL): boolean {
    const target = new URL(href, current)
    if (target.origin !== current.origin) return false
    const path = target.pathname.replace(/\/$/, '') || '/'
    return current.pathname === path || (path !== '/' && current.pathname.startsWith(`${path}/`))
}
