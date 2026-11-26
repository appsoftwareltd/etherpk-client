/**
 * Signing in to EtherPK from a Native App: the messages to the issuer, and the checks on what it
 * answers. The authorization code flow with PKCE (RFC 7636) in the system browser, returning to an
 * address on this computer (RFC 8252). The app is a public client and holds no secret.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface SignInConfig {
    /** An origin, with no slash at the end. */
    issuer: string
    clientId: string
    resource: string
    scopes: readonly string[]
}

export interface Endpoints { authorize: string; token: string; revoke: string | null }

/** One sign-in on its way through the browser. In memory only. */
export interface Attempt { state: string; nonce: string; verifier: string; redirectUri: string }

export interface TokenSet { accessToken: string; refreshToken: string; expiresAt: number }

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

const DISCOVERY_BUDGET_MS = 5_000
const EXCHANGE_BUDGET_MS = 10_000
const REVOKE_BUDGET_MS = 10_000

/** The issuer did not answer, or not with an answer about this sign-in. It can be asked again. */
export class IssuerUnavailable extends Error {}
/**
 * The request may have reached the issuer, and no answer came back: a refresh token sent this way may
 * be spent already. One that failed before anything left the computer is a plain {@link IssuerUnavailable}.
 */
export class AnswerLost extends IssuerUnavailable {}
/** The issuer answered that the sign-in is over. */
export class SignInOver extends Error {}
/** The answer is not one this app may act on. */
export class WrongAnswer extends Error {}
/** The issuer took the request and answered with no tokens, so a refresh token sent with it is spent. */
export class NoTokens extends WrongAnswer {}

/**
 * Failures that happen before a request leaves the computer, so the issuer has seen nothing. Electron's
 * network stack names them `net::ERR_…`, and Node's by code. Every other failure, a timeout included,
 * may come after the issuer has acted.
 */
const NOT_SENT = /\b(?:ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_ACCESS_DENIED|ERR_ADDRESS_UNREACHABLE|ERR_ADDRESS_INVALID|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|ERR_UNSAFE_PORT|ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)\b/

/** Whether a failed request certainly never reached the issuer. */
export function neverSent(error: unknown): boolean {
    const cause = (error as { cause?: { message?: unknown; code?: unknown } } | null)?.cause
    const said = [error instanceof Error ? error.message : String(error), cause?.message, cause?.code].filter((one) => typeof one === 'string').join(' ')
    return NOT_SENT.test(said)
}

const random = (bytes: number) => randomBytes(bytes).toString('base64url')

export function newAttempt(redirectUri: string): Attempt {
    return { state: random(32), nonce: random(32), verifier: random(64), redirectUri }
}

/** The issuer of a build, or null for none. Plain http is for a developer's own computer. */
export function checkedIssuer(issuer: unknown): string | null {
    if (typeof issuer !== 'string' || !URL.canParse(issuer)) return null
    const url = new URL(issuer)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.origin !== issuer) return null
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? issuer : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Every address the app will send a token to is on the issuer's own origin. */
export function checkedEndpoints(metadata: unknown, issuer: string): Endpoints {
    if (!isRecord(metadata) || metadata.issuer !== issuer) throw new WrongAnswer('The metadata is not of this issuer.')
    const methods = metadata.code_challenge_methods_supported
    if (!Array.isArray(methods) || !methods.includes('S256')) throw new WrongAnswer('The issuer does not take PKCE with S256.')
    const endpoint = (name: string): string => {
        const value = metadata[name]
        if (typeof value !== 'string' || !URL.canParse(value)) throw new WrongAnswer(`The metadata has no ${name}.`)
        const url = new URL(value)
        if (url.origin !== issuer || url.username || url.password) throw new WrongAnswer(`The ${name} is not on the issuer's origin.`)
        return url.href
    }
    return {
        authorize: endpoint('authorization_endpoint'),
        token: endpoint('token_endpoint'),
        revoke: metadata.revocation_endpoint === undefined ? null : endpoint('revocation_endpoint'),
    }
}

export function authorizeUrl(config: SignInConfig, endpoints: Endpoints, attempt: Attempt): string {
    const url = new URL(endpoints.authorize)
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: attempt.redirectUri,
        scope: config.scopes.join(' '),
        resource: config.resource,
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge: createHash('sha256').update(attempt.verifier, 'ascii').digest('base64url'),
        code_challenge_method: 'S256',
    }).toString()
    return url.href
}

export type Callback = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'failed'; error: string } | { kind: 'other' }

/**
 * What a callback says. One with another state, or that another issuer made (RFC 9207), is not this
 * attempt's, and the attempt goes on waiting.
 */
export function readCallback(query: URLSearchParams, attempt: Attempt, issuer: string): Callback {
    const single = (name: string) => (query.getAll(name).length === 1 ? query.get(name) : null)
    if (single('state') !== attempt.state || single('iss') !== issuer) return { kind: 'other' }
    const error = single('error')
    if (error !== null) return error === 'access_denied' ? { kind: 'denied' } : { kind: 'failed', error }
    const code = single('code')
    return code ? { kind: 'code', code } : { kind: 'other' }
}

/** Decoded, not verified: it came straight from the issuer over TLS (OpenID Connect Core 3.1.3.7, point 6). */
export function checkIdToken(idToken: unknown, config: SignInConfig, nonce: string, now: number): void {
    let claims: unknown = null
    try {
        claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8'))
    } catch {
        // Falls through to the refusal below.
    }
    const good = isRecord(claims) && claims.iss === config.issuer && claims.nonce === nonce
        && (claims.aud === config.clientId || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId))
        && typeof claims.exp === 'number' && claims.exp * 1000 > now
    if (!good) throw new WrongAnswer('The ID token is not for this sign-in.')
}

export class Issuer {
    private endpoints: Endpoints | null = null

    constructor(readonly config: SignInConfig, private readonly fetcher: Fetcher, private readonly now: () => number = Date.now) {}

    async discover(): Promise<Endpoints> {
        if (this.endpoints) return this.endpoints
        const response = await this.ask(`${this.config.issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } }, DISCOVERY_BUDGET_MS)
        if (!response.ok) throw new IssuerUnavailable(`Discovery was answered with ${response.status}.`)
        this.endpoints = checkedEndpoints(await this.json(response), this.config.issuer)
        return this.endpoints
    }

    private async ask(url: string, init: RequestInit, budget: number): Promise<Response> {
        try {
            return await this.fetcher(url, { ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(budget) })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw neverSent(error) ? new IssuerUnavailable(message) : new AnswerLost(message)
        }
    }

    /** An answer that came and could not be read was still an answer: the issuer acted on the request. */
    private async json(response: Response): Promise<unknown> {
        try {
            return await response.json()
        } catch {
            throw new AnswerLost(`The answer (${response.status}) could not be read.`)
        }
    }

    /** A form post from the app itself. The issuer's framework refuses one with no Origin of its own. */
    private post(url: string, form: Record<string, string>, budget: number): Promise<Response> {
        return this.ask(url, {
            method: 'POST',
            headers: { Origin: this.config.issuer, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams(form).toString(),
        }, budget)
    }

    private async tokens(form: Record<string, string>, budget: number): Promise<{ tokens: TokenSet; idToken: unknown }> {
        const { token } = await this.discover()
        const asked = this.now()
        const response = await this.post(token, form, budget)
        if (response.status === 400 || response.status === 401) throw new SignInOver(`The issuer answered ${response.status}.`)
        // A gateway that gave up waiting: the issuer behind it may have answered by now.
        if (response.status === 504) throw new AnswerLost('The issuer answered 504.')
        if (!response.ok) throw new IssuerUnavailable(`The issuer answered ${response.status}.`)
        const answer = await this.json(response)
        if (!isRecord(answer) || typeof answer.access_token !== 'string' || typeof answer.refresh_token !== 'string') {
            throw new NoTokens('The answer holds no tokens.')
        }
        const seconds = typeof answer.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 900
        return {
            tokens: { accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: Math.trunc(asked + seconds * 1000) },
            idToken: answer.id_token,
        }
    }

    /** Asked once and never again: a code presented twice ends the tokens issued for it. */
    async exchange(code: string, attempt: Attempt): Promise<TokenSet> {
        const { tokens, idToken } = await this.tokens({
            grant_type: 'authorization_code', code, client_id: this.config.clientId, redirect_uri: attempt.redirectUri,
            code_verifier: attempt.verifier, resource: this.config.resource,
        }, EXCHANGE_BUDGET_MS)
        checkIdToken(idToken, this.config, attempt.nonce, this.now())
        return tokens
    }

    async refresh(refreshToken: string, budget: number): Promise<TokenSet> {
        const { tokens } = await this.tokens({
            grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.config.clientId,
            scope: this.config.scopes.join(' '), resource: this.config.resource,
        }, budget)
        return tokens
    }

    async revoke(refreshToken: string): Promise<void> {
        const { revoke } = await this.discover()
        if (revoke === null) return
        const response = await this.post(revoke, { token: refreshToken, token_type_hint: 'refresh_token', client_id: this.config.clientId }, REVOKE_BUDGET_MS)
        if (!response.ok) throw new IssuerUnavailable(`The revocation was answered with ${response.status}.`)
    }
}
