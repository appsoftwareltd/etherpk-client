import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkedEndpoints, checkedIssuer, checkIdToken, Issuer, neverSent, newAttempt, readCallback, type SignInConfig } from './oauth.ts'
import { AppSignIn, REFRESH_ATTEMPT_MS, REPEAT_WINDOW_MS, type SignInParts } from './sign-in.ts'
import { fileStore, type Sealer, type TokenStore } from './token-store.ts'

const config: SignInConfig = { issuer: 'https://account.example', clientId: 'etherpk-installed', resource: 'urn:etherpk:managed-sync', scopes: ['openid', 'offline_access', 'sync'] }
const metadata = {
    issuer: config.issuer, code_challenge_methods_supported: ['S256'], authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`, revocation_endpoint: `${config.issuer}/revoke`,
}

/** An issuer that rotates refresh tokens as the real one does: a spent one repeats its answer for 30 s, then ends everything. */
function fakeIssuer() {
    const state = {
        now: 1_900_000_000_000, live: new Set<string>(), spent: new Map<string, { at: number; answer: Record<string, unknown> }>(), next: 0,
        family: true, revoked: [] as string[], requests: [] as { url: string; headers: Headers; form: URLSearchParams }[], codes: new Map<string, { challenge: string; nonce: string; redirectUri: string }>(),
        /**
         * What happens to each coming token request: lost before it leaves the computer, answered into
         * the void at once, answered while the app waits until its time is up, answered with no tokens in
         * it, or a status.
         */
        trouble: [] as ('lost' | 'unheard' | 'stalled' | 'stripped' | number)[],
    }
    const issue = (nonce?: string) => {
        const refresh_token = `refresh-${state.next++}`
        state.live.add(refresh_token)
        const claims = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.clientId, nonce, exp: state.now / 1000 + 600 })).toString('base64url')
        return { access_token: `access-${state.next}`, refresh_token, expires_in: 900, ...(nonce ? { id_token: `e.${claims}.s` } : {}) }
    }
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    const token = (form: URLSearchParams): Response => {
        if (form.get('grant_type') === 'authorization_code') {
            const code = state.codes.get(form.get('code')!)
            state.codes.delete(form.get('code')!)
            const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
            if (!code || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri')) return answer(400, { error: 'invalid_grant' })
            return answer(200, issue(code.nonce))
        }
        const presented = form.get('refresh_token')!
        if (state.live.delete(presented)) {
            const next = issue()
            state.spent.set(presented, { at: state.now, answer: next })
            return answer(200, next)
        }
        const spent = state.spent.get(presented)
        if (spent && state.now - spent.at < 30_000) return answer(200, spent.answer)
        if (spent) {
            state.family = false
            state.live.clear()
        }
        return answer(400, { error: 'invalid_grant' })
    }
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.endsWith('openid-configuration')) return answer(200, metadata)
        const form = new URLSearchParams(String(init?.body))
        await new Promise((resolve) => setTimeout(resolve, 0))
        state.requests.push({ url, headers: new Headers(init?.headers), form })
        if (url.endsWith('/revoke')) {
            state.revoked.push(form.get('token')!)
            if (!state.live.delete(form.get('token')!)) state.family = false
            return answer(200, {})
        }
        const trouble = state.trouble.shift()
        // As Electron's network stack says it: refused before anything was sent.
        if (trouble === 'lost') throw new Error('net::ERR_CONNECTION_REFUSED')
        if (typeof trouble === 'number') return answer(trouble, {})
        const reply = token(form)
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (trouble === 'unheard') throw new Error('net::ERR_EMPTY_RESPONSE')
        if (trouble === 'stalled') {
            state.now += REFRESH_ATTEMPT_MS
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        }
        if (trouble === 'stripped') return answer(200, { access_token: 'access-without-refresh' })
        return reply
    }
    return { state, fetcher, issuer: new Issuer(config, fetcher, () => state.now) }
}

const sealer: Sealer = { seal: (text) => Buffer.from(text).reverse(), unseal: (bytes) => Buffer.from(bytes).reverse().toString() }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-auth-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

function world(over: Partial<SignInParts> = {}) {
    const fake = fakeIssuer()
    const seen = { pages: [] as { status: number; text: string; headers: Headers }[], returned: 0, notLasting: 0, notSaved: 0, endedHere: 0, opened: [] as string[] }
    const store: TokenStore = fileStore(join(dir, 'sign-in.bin'), config.issuer, sealer, () => {})
    /** The person's browser: signs in and follows the redirect. A test may put another in its place. */
    const browser = {
        visit: async (url: URL) => {
            const code = `code-${fake.state.codes.size}`
            fake.state.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, nonce: url.searchParams.get('nonce')!, redirectUri: url.searchParams.get('redirect_uri')! })
            await follow(url, { code, state: url.searchParams.get('state')!, iss: config.issuer })
        },
    }
    async function follow(url: URL, query: Record<string, string>) {
        const response = await fetch(`${url.searchParams.get('redirect_uri')}?${new URLSearchParams(query)}`)
        seen.pages.push({ status: response.status, text: await response.text(), headers: response.headers })
    }
    const parts: SignInParts = {
        issuer: fake.issuer, store, now: () => fake.state.now, wait: async (ms) => { fake.state.now += ms },
        openBrowser: async (url) => { seen.opened.push(url); void browser.visit(new URL(url)).catch(() => {}) },
        returned: () => { seen.returned++ }, notLasting: () => { seen.notLasting++ }, notSaved: () => { seen.notSaved++ }, endedHere: () => { seen.endedHere++ },
        log: () => {}, ...over,
    }
    return { ...fake, seen, browser, follow, parts, signIn: new AppSignIn(parts) }
}

describe('signing in', () => {
    it('goes through the browser and back, with PKCE, and gives the page an access token only', async () => {
        const { signIn, seen, state } = world()
        const grant = await signIn.signIn()
        expect(grant).toEqual({ accessToken: 'access-1', expiresAt: state.now + 900_000 })
        const url = new URL(seen.opened[0])
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'etherpk-installed', response_type: 'code', code_challenge_method: 'S256', resource: config.resource, scope: 'openid offline_access sync' })
        expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
        expect(state.requests[0].headers.get('origin')).toBe(config.issuer)
        expect(state.requests[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded')
        expect(seen.pages[0]).toMatchObject({ status: 200 })
        expect(seen.pages[0].text).toContain('You are signed in')
        expect(seen.pages[0].headers.get('cache-control')).toBe('no-store')
        expect(seen.pages[0].text).not.toContain('code-')
        expect(seen.returned).toBe(1)
        expect(await signIn.signedIn()).toBe(true)
    })
    it('stops listening once it has been answered', async () => {
        const { signIn, seen } = world()
        await signIn.signIn()
        await expect(fetch(new URL(seen.opened[0]).searchParams.get('redirect_uri')!)).rejects.toThrow()
    })
    it('goes on waiting through a callback that is not its own', async () => {
        const { signIn, seen, browser, follow, state } = world()
        const real = browser.visit
        browser.visit = async (url) => {
            const mine = url.searchParams.get('state')!
            for (const query of [{ code: 'x', state: 'other', iss: config.issuer }, { code: 'x', state: mine, iss: 'https://elsewhere.example' }, { code: 'x', state: mine }, { state: mine, iss: config.issuer }]) await follow(url, query as Record<string, string>)
            await real(url)
        }
        await signIn.signIn()
        expect(seen.pages.map(({ status }) => status)).toEqual([400, 400, 400, 400, 200])
        expect(state.requests).toHaveLength(1)
    })
    it('answers nothing but its own address', async () => {
        const { signIn, browser } = world()
        const statuses: number[] = []
        const real = browser.visit
        browser.visit = async (url) => {
            const base = new URL(url.searchParams.get('redirect_uri')!)
            for (const [path, init] of [['/', {}], ['/callback/', {}], ['/favicon.ico', {}], ['/callback', { method: 'POST' }]] as const) statuses.push((await fetch(new URL(path, base), init)).status)
            await real(url)
        }
        await signIn.signIn()
        expect(statuses).toEqual([404, 404, 404, 404])
    })
    it('is given up when the person says no, or asks again', async () => {
        const { signIn, browser, follow } = world()
        browser.visit = (url) => follow(url, { error: 'access_denied', state: url.searchParams.get('state')!, iss: config.issuer })
        await expect(signIn.signIn()).rejects.toMatchObject({ failure: 'AbortError' })
        browser.visit = (url) => follow(url, { error: 'server_error', state: url.searchParams.get('state')!, iss: config.issuer })
        await expect(signIn.signIn()).rejects.toMatchObject({ failure: 'OperationError' })
        browser.visit = async () => {}
        const first = signIn.signIn().catch((error: unknown) => error)
        await new Promise((resolve) => setTimeout(resolve, 50))
        const second = signIn.signIn().catch((error: unknown) => error)
        expect(await first).toMatchObject({ failure: 'AbortError' })
        await new Promise((resolve) => setTimeout(resolve, 50))
        signIn.cancel()
        expect(await second).toMatchObject({ failure: 'AbortError' })
    })
    it('two asked for in one turn leave one waiting', async () => {
        const { signIn, browser } = world()
        browser.visit = async () => {}
        const both = [signIn.signIn(), signIn.signIn()].map((one) => one.catch((error: unknown) => (error as { failure: string }).failure))
        await new Promise((resolve) => setTimeout(resolve, 50))
        signIn.cancel()
        expect(await Promise.all(both)).toEqual(['AbortError', 'AbortError'])
    })
    it('never asks twice with one code', async () => {
        const { signIn, state } = world()
        state.trouble = ['unheard']
        await expect(signIn.signIn()).rejects.toMatchObject({ failure: 'NetworkError' })
        expect(state.requests).toHaveLength(1)
        expect(await signIn.signedIn()).toBe(false)
    })
    it('says when it will not outlast the app', async () => {
        const { memoryStore } = await import('./token-store.ts')
        const { signIn, seen } = world({ store: memoryStore() })
        await signIn.signIn()
        expect(seen.notLasting).toBe(1)
    })
    it('a build with no issuer has no sign-in', async () => {
        const { signIn } = world({ issuer: null })
        await expect(signIn.signIn()).rejects.toMatchObject({ failure: 'NotSupportedError' })
        expect(await signIn.signedIn()).toBe(false)
        expect(await signIn.accessToken(false)).toBe(null)
    })
})

describe('the access token', () => {
    it('is kept while it lasts, and refreshed when it is nearly over or when asked', async () => {
        const { signIn, state } = world()
        const first = await signIn.signIn()
        expect(await signIn.accessToken(false)).toEqual(first)
        state.now += 839_000
        expect(await signIn.accessToken(false)).toEqual(first)
        state.now += 2_000
        const second = await signIn.accessToken(false)
        expect(second).not.toEqual(first)
        expect(await signIn.accessToken(true)).not.toEqual(second)
        expect(state.requests.at(-1)?.form.get('resource')).toBe(config.resource)
        expect(state.requests.at(-1)?.form.get('scope')).toBe('openid offline_access sync')
    })
    it('is refreshed once for all who ask at once', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        const grants = await Promise.all([signIn.accessToken(true), signIn.accessToken(true), signIn.accessToken(false).then(() => signIn.accessToken(true))])
        expect(new Set(grants.slice(0, 2).map((grant) => grant?.accessToken)).size).toBe(1)
        expect(state.family).toBe(true)
    })
    it('has its refresh token on the disk before it is answered', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        await signIn.accessToken(true)
        const kept = JSON.parse(sealer.unseal(await readFile(join(dir, 'sign-in.bin')))) as { refreshToken: string }
        expect([...state.live]).toEqual([kept.refreshToken])
    })
    it('is there after a restart, with no network to know it', async () => {
        const first = world()
        await first.signIn.signIn()
        const again = new AppSignIn({ ...first.parts })
        expect(await again.signedIn()).toBe(true)
        expect(await again.accessToken(false)).not.toBe(null)
    })
    it('an answer that was lost is asked for again while the issuer repeats it', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        state.trouble = ['unheard']
        expect(await signIn.accessToken(true)).not.toBe(null)
        expect(state.family).toBe(true)
        expect(await signIn.accessToken(true)).not.toBe(null)
    })
    it('an answer that never came in time is asked for once more, inside the issuer’s window', async () => {
        const { signIn, state, seen } = world()
        await signIn.signIn()
        state.trouble = ['stalled']
        const started = state.now
        expect(await signIn.accessToken(true)).not.toBe(null)
        // The repeat went while the issuer still repeats its answer.
        expect(state.now - started).toBeLessThan(REPEAT_WINDOW_MS)
        expect(state.family).toBe(true)
        expect(seen.endedHere).toBe(0)
    })
    for (const trouble of [['stalled', 'stalled'], ['stalled', 'lost'], ['stalled', 503], ['unheard', 'unheard'], [504, 504]] as const) {
        it(`a token that may be spent is never sent once the window has passed (${trouble.join(', ')})`, async () => {
            const { signIn, state, seen } = world()
            await signIn.signIn()
            state.trouble = [...trouble]
            expect(await signIn.accessToken(true)).toBe(null)
            expect(await signIn.signedIn()).toBe(false)
            expect(seen.endedHere).toBe(1)
            await expect(readFile(join(dir, 'sign-in.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
            const sent = state.requests.length
            state.now += REPEAT_WINDOW_MS
            expect(await signIn.accessToken(true)).toBe(null)
            expect(state.requests).toHaveLength(sent)
            // The account's other devices are still signed in.
            expect(state.family).toBe(true)
        })
    }
    it('an answer with no tokens in it spends the token, and it is not sent again', async () => {
        const { signIn, state, seen } = world()
        await signIn.signIn()
        state.trouble = ['stripped']
        const sent = state.requests.length
        expect(await signIn.accessToken(true)).toBe(null)
        expect(state.requests).toHaveLength(sent + 1)
        expect(seen.endedHere).toBe(1)
        state.now += REPEAT_WINDOW_MS
        expect(await signIn.accessToken(true)).toBe(null)
        expect(state.family).toBe(true)
    })
    it('offline is a NetworkError and keeps the sign-in', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        for (const trouble of [['lost', 'lost'], [503, 503], [429, 500], [403, 403], [502]] as (typeof state.trouble)[]) {
            state.trouble = trouble
            await expect(signIn.accessToken(true)).rejects.toMatchObject({ failure: 'NetworkError' })
            expect(await signIn.signedIn()).toBe(true)
        }
        expect(await signIn.accessToken(true)).not.toBe(null)
    })
    for (const status of [400, 401]) {
        it(`${status} ends the sign-in`, async () => {
            const { signIn, state } = world()
            await signIn.signIn()
            state.trouble = [status]
            expect(await signIn.accessToken(true)).toBe(null)
            expect(await signIn.signedIn()).toBe(false)
            await expect(readFile(join(dir, 'sign-in.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
        })
    }
    it('a token that could not be kept leaves no spent one behind', async () => {
        const { parts, signIn, state } = world()
        await signIn.signIn()
        const failing: Sealer = { ...sealer, seal: () => { throw new Error('the key store is locked') } }
        const second = new AppSignIn({ ...parts, store: fileStore(join(dir, 'sign-in.bin'), config.issuer, failing, () => {}) })
        expect(await second.accessToken(true)).not.toBe(null)
        await expect(readFile(join(dir, 'sign-in.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await second.accessToken(true)).not.toBe(null)
        expect(state.family).toBe(true)
    })
    it('a sign-in that could not be saved is told once', async () => {
        const { parts, signIn, seen } = world()
        await signIn.signIn()
        const failing: Sealer = { ...sealer, seal: () => { throw new Error('the key store is locked') } }
        const second = new AppSignIn({ ...parts, store: fileStore(join(dir, 'sign-in.bin'), config.issuer, failing, () => {}) })
        await second.accessToken(true)
        await second.accessToken(true)
        expect(seen.notSaved).toBe(1)
    })
})

describe('signing out', () => {
    it('forgets here and revokes there', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        const [live] = state.live
        await signIn.signOut()
        expect(state.revoked).toEqual([live])
        expect(await signIn.signedIn()).toBe(false)
        expect(await signIn.accessToken(true)).toBe(null)
    })
    it('in the middle of a refresh revokes the token the refresh brought', async () => {
        const { signIn, state } = world()
        await signIn.signIn()
        await Promise.all([signIn.accessToken(true), signIn.signOut()])
        expect(state.family).toBe(true)
        expect(await signIn.signedIn()).toBe(false)
        expect(state.live.size).toBe(0)
    })
})

it('property: whatever is asked and whatever fails, no spent token is used after the issuer stops repeating', async () => {
    const step = fc.oneof(
        { weight: 4, arbitrary: fc.constant('refresh' as const) }, { weight: 2, arbitrary: fc.constant('token' as const) },
        { weight: 1, arbitrary: fc.constant('signOut' as const) }, { weight: 1, arbitrary: fc.constant('signIn' as const) },
        { weight: 2, arbitrary: fc.constant('restart' as const) }, { weight: 2, arbitrary: fc.constant('later' as const) },
    )
    const trouble = fc.constantFrom<'lost' | 'unheard' | number | undefined>('unheard', 503, 'lost', undefined, undefined)
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(step, trouble, fc.boolean()), { maxLength: 14 }), async (steps) => {
        await rm(join(dir, 'sign-in.bin'), { force: true })
        const { signIn: first, state, parts } = world()
        let signIn = first
        await signIn.signIn()
        const going: Promise<unknown>[] = []
        for (const [what, fails, wait] of steps) {
            // At most one failure for each request, so the repeat two seconds later is heard: what
            // the issuer's own rule cannot survive is a failure that lasts past its 30 seconds.
            state.trouble = fails === undefined || what === 'signIn' ? [] : [fails]
            if (what === 'later') { await Promise.all(going); state.now += 1_000_000 }
            if (what === 'restart') { await Promise.all(going); signIn = new AppSignIn(parts) }
            const act = { refresh: () => signIn.accessToken(true), token: () => signIn.accessToken(false), signOut: () => signIn.signOut(), signIn: () => signIn.signIn() }[what as string]
            if (act) going.push(Promise.resolve(act()).catch(() => {}))
            if (wait) await Promise.all(going)
        }
        await Promise.all(going)
        expect(state.family).toBe(true)
    }), { seed: 20261125, numRuns: Number(process.env.AUTH_FUZZ_RUNS ?? 80) })
}, 60_000)

describe('a request that failed', () => {
    it('never left the computer only when the network stack says so', () => {
        for (const message of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_CERT_DATE_INVALID']) expect(neverSent(new Error(message))).toBe(true)
        expect(neverSent(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND account.example'), { code: 'ENOTFOUND' }) }))).toBe(true)
        for (const error of [new Error('net::ERR_EMPTY_RESPONSE'), new Error('net::ERR_CONNECTION_RESET'), new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new TypeError('fetch failed'), 'something']) {
            expect(neverSent(error)).toBe(false)
        }
    })
})

describe('what the issuer says is checked', () => {
    it('its addresses', () => {
        expect(checkedEndpoints(metadata, config.issuer)).toEqual({ authorize: metadata.authorization_endpoint, token: metadata.token_endpoint, revoke: metadata.revocation_endpoint })
        for (const wrong of [null, { ...metadata, issuer: 'https://elsewhere.example' }, { ...metadata, token_endpoint: 'https://elsewhere.example/token' }, { ...metadata, code_challenge_methods_supported: ['plain'] }, { ...metadata, authorization_endpoint: 'https://a:b@account.example/' }]) {
            expect(() => checkedEndpoints(wrong, config.issuer)).toThrow()
        }
    })
    it('the issuer itself', () => {
        for (const good of ['https://account.example', 'http://127.0.0.1:5000', 'http://localhost:5000']) expect(checkedIssuer(good)).toBe(good)
        for (const wrong of [null, undefined, '', 'https://account.example/', 'https://account.example/path', 'http://account.example', 'not an address', 7]) expect(checkedIssuer(wrong)).toBe(null)
    })
    it('the ID token', () => {
        const token = (claims: object) => `e.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
        const good = { iss: config.issuer, aud: config.clientId, nonce: 'n', exp: 100 }
        checkIdToken(token(good), config, 'n', 99_000)
        for (const wrong of [{ ...good, iss: 'x' }, { ...good, aud: 'x' }, { ...good, aud: [config.clientId, 'x'] }, { ...good, nonce: 'x' }, { ...good, nonce: undefined }, { ...good, exp: 99 }]) expect(() => checkIdToken(token(wrong), config, 'n', 99_000)).toThrow()
        for (const wrong of [undefined, '', 'a.b', 'a.b.c']) expect(() => checkIdToken(wrong, config, 'n', 0)).toThrow()
    })
    it('a callback that says something twice', () => {
        const attempt = newAttempt('http://127.0.0.1:1/callback')
        const query = new URLSearchParams([['state', attempt.state], ['iss', config.issuer], ['code', 'a'], ['code', 'b']])
        expect(readCallback(query, attempt, config.issuer)).toEqual({ kind: 'other' })
    })
})

it('a kept sign-in that cannot be opened, or is another issuer’s, is none', async () => {
    const file = join(dir, 'sign-in.bin')
    await writeFile(file, 'not sealed')
    expect(await fileStore(file, config.issuer, sealer, () => {}).load()).toBe(null)
    await fileStore(file, 'https://elsewhere.example', sealer, () => {}).save('t')
    expect(await fileStore(file, config.issuer, sealer, () => {}).load()).toBe(null)
})
