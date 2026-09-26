/**
 * The password rule both apps apply wherever a password is set: registration, a change, a reset
 * and "set a password". At least 8 characters, and not one an attacker tries first: one of the
 * 100,000 most used passwords (the NCSC list, bundled, so no password or hash of one leaves the
 * server), one character repeated, or the account's own email name or the service's name. These
 * are the checks NIST SP 800-63B asks for, in place of composition rules such as "one capital
 * letter", which it advises against.
 */

export const PASSWORD_MIN_LENGTH = 8

/** The rule as persistent help text beside a new-password field. */
export const PASSWORD_HELP = `At least ${PASSWORD_MIN_LENGTH} characters, and not a commonly used password.`

/** The shortest email name worth looking for: "jo" or "al" would refuse ordinary words. */
const SHORTEST_TELLING_NAME = 4

let commonPasswords: Promise<Set<string>> | undefined

/**
 * Loaded on first use rather than at import: the barrel that exports this module is imported by
 * browser code too, and the list (about 450 kB) belongs only on the server.
 */
function loadCommonPasswords(): Promise<Set<string>> {
    commonPasswords ??= import('./common-passwords.txt?raw').then(
        ({ default: text }) => new Set(text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))),
    )
    return commonPasswords
}

/** Why a password may not be used, as a sentence for its field, or null when it may. */
export async function passwordWeakness(
    password: string,
    context: { email?: string | null } = {},
): Promise<string | null> {
    if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
    const lower = password.toLowerCase()
    if ((await loadCommonPasswords()).has(lower)) {
        return 'This is one of the most used passwords. Choose one that is harder to guess.'
    }
    if (/^(.)\1+$/u.test(password)) return 'One character repeated is too easy to guess.'
    const name = context.email?.split('@')[0]?.toLowerCase()
    if (name && name.length >= SHORTEST_TELLING_NAME && lower.includes(name)) {
        return 'Leave your email address out of your password.'
    }
    if (lower.includes('etherpk')) return 'Leave the name EtherPK out of your password.'
    return null
}

/** The code a refused password answers with, which the pages show at the password field. */
export const WEAK_PASSWORD_CODE = 'PASSWORD_TOO_WEAK'

/** The code a change of email address answers with when it came without the account's password. */
export const CURRENT_PASSWORD_REQUIRED_CODE = 'CURRENT_PASSWORD_REQUIRED'

/**
 * Where Better Auth takes a new password: the body field that carries it, and where to find the
 * account's email for the name check. An administrator setting someone else's password is checked
 * without one, since the session there is the administrator's own.
 */
export const NEW_PASSWORD_ENDPOINTS: Readonly<
    Record<string, { field: 'password' | 'newPassword'; email: 'body' | 'session' | 'none' }>
> = {
    '/sign-up/email': { field: 'password', email: 'body' },
    '/change-password': { field: 'newPassword', email: 'session' },
    '/reset-password': { field: 'newPassword', email: 'none' },
    '/set-password': { field: 'newPassword', email: 'session' },
    '/admin/create-user': { field: 'password', email: 'body' },
    '/admin/set-user-password': { field: 'newPassword', email: 'none' },
}
