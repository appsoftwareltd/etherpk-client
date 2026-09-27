/**
 * The account menu's links, in one order on every origin: the app's own signed-in page, then the
 * EtherPK account and its billing, then access tokens and administration. Each app passes the
 * destinations it has; the sign-out buttons stay each app's own, since each ends a different
 * session.
 */

export interface AccountMenuItem {
    label: string
    href: string
}

export function buildAccountMenu(options: {
    /** The app's own signed-in page: the Client's Graphs, the Sync portal's Dashboard. */
    home?: AccountMenuItem | null
    accountUrl?: string | null
    /** Where Sync+ is paid for: the managed service only. */
    billingUrl?: string | null
    accessTokensUrl?: string | null
    /** Administrators' pages, last. */
    admin?: AccountMenuItem[]
}): AccountMenuItem[] {
    return [
        options.home ?? null,
        options.accountUrl ? { label: 'Account', href: options.accountUrl } : null,
        options.billingUrl ? { label: 'Billing', href: options.billingUrl } : null,
        options.accessTokensUrl ? { label: 'Access tokens', href: options.accessTokensUrl } : null,
        ...(options.admin ?? []),
    ].filter((item): item is AccountMenuItem => item !== null)
}
