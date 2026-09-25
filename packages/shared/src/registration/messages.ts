/**
 * What a refused registration is told, and the code it is told under.
 *
 * Browser-safe on purpose: the register pages import this to render the closed and IP states
 * and to put the email refusal on the email field, while the policy itself (`policy.ts`) is
 * server-only because it needs `node:net`. The Client never consumes these codes; they exist so
 * the pages and the e2e suites can assert on the *reason* rather than the copy.
 */

/** Why a registration was refused. Judged in this order: closed, then IP, then email. */
export type RegistrationRefusal = 'closed' | 'ip' | 'email'

export const REGISTRATION_REFUSAL_CODES: Record<RegistrationRefusal, string> = {
    closed: 'REGISTRATION_CLOSED',
    ip: 'REGISTRATION_RESTRICTED_IP',
    email: 'REGISTRATION_RESTRICTED_EMAIL',
}

/** What happened, and what to do next. Never a bare code. */
export function registrationRefusalMessage(reason: RegistrationRefusal): string {
    switch (reason) {
        case 'closed':
            return "This server is not accepting new accounts. Sign in with an existing account or contact this server's maintainer."
        case 'ip':
            return "Registration is not available from your current IP address. Sign in with an existing account or contact this server's maintainer."
        case 'email':
            return "This address is not permitted to register on this server. Check it, or contact this server's maintainer."
    }
}
