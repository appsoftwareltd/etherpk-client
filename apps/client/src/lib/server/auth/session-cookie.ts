import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const MANAGED_SESSION_COOKIE = '__Host-etherpk-managed-session'
export const OAUTH_TRANSACTION_COOKIE = '__Host-etherpk-oauth-transaction'

/**
 * What a cookie is for. Both cookies are encrypted under the same configured secret; the
 * purpose separates their keys AND is bound in as AAD, so a cookie decrypted in the wrong slot
 * fails authentication rather than being parsed, and `isManagedSession`'s shape check is not
 * all that keeps an OAuth transaction cookie out of the managed-session slot.
 */
export type CookiePurpose = 'managed-session' | 'oauth-transaction'

/**
 * v2 derives the key with HKDF and a per-purpose info string; v1 was a bare SHA-256 of the
 * secret, shared by both cookies. v1 envelopes are not accepted: a session that fails to
 * decrypt is cleared and re-established through silent SSO, and an OAuth transaction lives
 * ten minutes, so nothing is lost by refusing the weaker construction outright.
 */
const ENVELOPE_VERSION = 'v2'

// A fixed, non-secret salt. HKDF's salt does not need to be secret; the domain separation
// that matters here comes from the per-purpose info string.
const KEY_SALT = Buffer.from('etherpk-cookie-key', 'utf8')

function cookieKey(secret: string, purpose: CookiePurpose): Buffer {
    return Buffer.from(
        hkdfSync('sha256', Buffer.from(secret, 'utf8'), KEY_SALT, `etherpk:cookie:${ENVELOPE_VERSION}:${purpose}`, 32),
    )
}

export interface ManagedSession {
    refreshToken: string
    idToken: string
    expiresAt: number
}

export interface AuthorizationTransaction {
    state: string
    nonce: string
    codeVerifier: string
    returnPath: string
    createdAt: number
    interaction: ClientAuthorizationInteraction
}

export type ClientAuthorizationInteraction = 'interactive' | 'silent'

/** Reject malformed and pre-coordinated-logout cookies before using their token material. */
export function isManagedSession(value: unknown): value is ManagedSession {
    if (!value || typeof value !== 'object') return false
    const session = value as Partial<ManagedSession>
    return typeof session.refreshToken === 'string'
        && session.refreshToken.length > 0
        && typeof session.idToken === 'string'
        && session.idToken.length > 0
        && typeof session.expiresAt === 'number'
        && Number.isFinite(session.expiresAt)
}

/** AES-256-GCM cookie envelope: version.iv.ciphertext.tag, all base64url encoded. */
export async function encryptSessionCookie(
    value: object,
    secret: string,
    purpose: CookiePurpose,
): Promise<string> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', cookieKey(secret, purpose), iv)
    cipher.setAAD(Buffer.from(purpose, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [ENVELOPE_VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
}

export async function decryptSessionCookie<T = ManagedSession>(
    cookie: string,
    secret: string,
    purpose: CookiePurpose,
): Promise<T> {
    const [version, encodedIv, encodedCiphertext, encodedTag, extra] = cookie.split('.')
    if (version !== ENVELOPE_VERSION || !encodedIv || !encodedCiphertext || !encodedTag || extra) {
        throw new Error('Invalid managed session cookie')
    }
    // Exact lengths: GCM would otherwise verify a truncated tag against the same prefix of the
    // real one, cutting the cost of a forgery from 2^128 guesses to as few as 2^32, and a
    // non-96-bit IV takes a different, less-studied counter derivation.
    const iv = Buffer.from(encodedIv, 'base64url')
    const tag = Buffer.from(encodedTag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid managed session cookie')
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(secret, purpose), iv, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(purpose, 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as T
}
