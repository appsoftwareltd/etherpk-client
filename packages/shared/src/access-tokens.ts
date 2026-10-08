/**
 * The access-token formats the Sync Server, the Client and the Headless Client must agree on.
 *
 * A Personal Access Token is one of two kinds, and its prefix says which:
 *
 * - **standard** (`epk_pat_`): made on the Sync Server's Access tokens page, pasted into a
 *   Client's custom server settings or a script. It reaches every route a signed-in session
 *   reaches, apart from the few that need the portal itself.
 * - **agent** (`epk_agt_`): held by the Headless Client. It reaches only the routes the Headless
 *   Client calls, and stops working after {@link AGENT_TOKEN_IDLE_DAYS} days unused. A person never
 *   handles one: `login` gets it for a one-time setup code (`epk_setup_`), or in exchange for a
 *   standard token, which the exchange revokes.
 *
 * The Sync Server decides a token's kind from its own record, never from the prefix. The prefix
 * lets the Headless Client tell, without a request, whether the token it holds still needs
 * exchanging, and lets a person or a secret scanner tell the kinds apart.
 */

export const STANDARD_TOKEN_PREFIX = 'epk_pat_'
export const AGENT_TOKEN_PREFIX = 'epk_agt_'
export const AGENT_SETUP_CODE_PREFIX = 'epk_setup_'

/** Every token and setup code carries 32 random bytes, which base64url writes as 43 characters. */
const SECRET_LENGTH = 43
const SECRET = /^[A-Za-z0-9_-]+$/

export type AccessTokenKind = 'standard' | 'agent'

/** An agent token nobody has used for this many days stops working. */
export const AGENT_TOKEN_IDLE_DAYS = 30

/** A setup code works once, within this many minutes of being made. */
export const AGENT_SETUP_CODE_MINUTES = 10

/** At most this many setup codes may be waiting to be used for one account at a time. */
export const AGENT_SETUP_CODE_MAX_OPEN = 5

/** The coded refusal for an agent token on a route outside its list. */
export const AGENT_TOKEN_REFUSED_CODE = 'agent_token_refused'

/** The coded refusal for a setup code that is unknown, used or past its time. */
export const AGENT_SETUP_CODE_INVALID_CODE = 'agent_setup_code_invalid'

/** The coded refusal for an Account Reset that came with a token or an old sign-in. */
export const RESET_NEEDS_RECENT_SIGN_IN_CODE = 'reset_needs_recent_sign_in'

/**
 * An Account Reset from the Sync Server portal needs a sign-in at most this many minutes old
 * (ADR 0133). A reset deletes every graph the account owns, so it asks the person to prove
 * again that they are there, as a token or a forgotten open tab cannot.
 */
export const RESET_SIGN_IN_MAX_AGE_MINUTES = 10

function hasSecret(value: string, prefix: string): boolean {
    if (!value.startsWith(prefix)) return false
    const rest = value.slice(prefix.length)
    return rest.length === SECRET_LENGTH && SECRET.test(rest)
}

/** The kind a token's prefix claims, or null for anything that is not shaped like a token. */
export function accessTokenKind(token: string): AccessTokenKind | null {
    if (hasSecret(token, STANDARD_TOKEN_PREFIX)) return 'standard'
    if (hasSecret(token, AGENT_TOKEN_PREFIX)) return 'agent'
    return null
}

/** Is this shaped like a setup code? Checked before any request, so a typo is named at once. */
export function looksLikeAgentSetupCode(value: string): boolean {
    return hasSecret(value, AGENT_SETUP_CODE_PREFIX)
}
