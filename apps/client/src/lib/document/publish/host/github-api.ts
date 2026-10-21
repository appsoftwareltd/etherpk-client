/**
 * The few calls to GitHub's REST API a [[Publish Repository]] needs, made with the person's own
 * GitHub token (ADR 0152). The Client calls GitHub from the page, which GitHub allows from any
 * origin, and the Headless Client calls it from Node: both through `fetch`, so this module is
 * the same in both.
 *
 * It does three things on top of `fetch`:
 *
 * - **It paces writes.** GitHub asks for requests that create content to be made one at a time,
 *   at least a second apart, and limits them to 80 a minute and 500 an hour. Every POST, PATCH
 *   and PUT waits for the one before it and for that second.
 * - **It waits out a rate limit.** A 403 or 429 that GitHub marks as a rate limit is retried after
 *   `retry-after`, else after `x-ratelimit-reset`, else after a minute that doubles each time,
 *   which is GitHub's own order. `onWait` says until when, for the Activity.
 * - **It names what went wrong.** Every refusal becomes a {@link GitHubError} with a code the
 *   caller can act on and word for a person (`github-repository.ts`).
 *
 * Framework-free and free of `$lib` imports: the Playwright suites and the Headless Client load
 * it through relative paths.
 */

export const GITHUB_API_URL = 'https://api.github.com'

/** A branch of a repository on GitHub: `owner/name` and the branch the site goes to. */
export interface GitHubRepository {
    owner: string
    name: string
    branch: string
}

export type GitHubErrorCode =
    /** `fetch` itself failed: no network, or GitHub could not be reached. */
    | 'offline'
    /** 401: the token is wrong, expired or revoked. */
    | 'bad-token'
    /** The repository is not there for this token: a wrong name, or a token not given it. */
    | 'no-access'
    /** The token can read the repository but not write to it. */
    | 'read-only'
    | 'branch-missing'
    /** The repository has no commits yet. */
    | 'empty-repository'
    /** The branch moved between reading it and committing to it. */
    | 'branch-moved'
    /** A branch protection rule refused the commit: a pull request or a signed commit is required. */
    | 'branch-protected'
    /** GitHub kept asking EtherPK to wait, past the number of times it will. */
    | 'rate-limited'
    /** A file is over GitHub's 100 MB limit. */
    | 'too-large'
    /** GitHub listed only part of the branch, so strays could not all be seen. */
    | 'truncated'
    | 'unexpected'

export class GitHubError extends Error {
    constructor(
        readonly code: GitHubErrorCode,
        message: string,
        /** The HTTP status, when GitHub answered. */
        readonly status?: number,
        /** For `too-large`, the file; for `rate-limited`, when to try again (ms since 1970). */
        readonly detail?: { path?: string; size?: number; retryAt?: number },
    ) {
        super(message)
        this.name = 'GitHubError'
    }
}

export interface GitHubApiOptions {
    token: string
    fetch?: typeof fetch
    /** GitHub's API, or GitHub Enterprise Server's (`https://host/api/v3`). */
    baseUrl?: string
    /** Injected so tests do not wait for real. */
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** GitHub asked for a wait: until this time (ms since 1970). */
    onWait?: (until: number) => void
}

export interface GitHubApi {
    /** One request; the parsed JSON answer, or null for an empty one. Throws {@link GitHubError}. */
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>
}

/** Writes GitHub asks to be spaced (its "best practices for using the REST API"). */
const WRITE_SPACING_MS = 1000
/** How many times one request waits out a rate limit before it gives up. */
const RATE_LIMIT_ATTEMPTS = 5
/** How many times a request GitHub failed on (5xx) is tried again. Creating git objects is idempotent. */
const SERVER_ERROR_RETRIES = 2

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** True for a 403 or 429 that GitHub sends as a rate limit, rather than a refusal. */
function isRateLimit(status: number, headers: Headers, message: string): boolean {
    if (status === 429) return true
    if (status !== 403) return false
    return headers.has('retry-after') || headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)
}

/** How long to wait before trying again, in GitHub's order: retry-after, the reset time, a doubling minute. */
function waitFor(headers: Headers, attempt: number, now: number): number {
    const retryAfter = Number(headers.get('retry-after'))
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
    const reset = Number(headers.get('x-ratelimit-reset'))
    if (headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset * 1000 > now) return reset * 1000 - now
    return 60_000 * 2 ** attempt
}

/** The code for a refusal GitHub sent, from its status and message. */
function refusalCode(status: number, message: string): GitHubErrorCode {
    if (status === 401) return 'bad-token'
    if (/not a fast.?forward/i.test(message)) return 'branch-moved'
    if (/protected branch|pull request|GH006|signed/i.test(message)) return 'branch-protected'
    if (status === 409 && /empty/i.test(message)) return 'empty-repository'
    if (status === 403) return 'read-only'
    if (status === 404) return 'no-access'
    return 'unexpected'
}

export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    const baseUrl = (options.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, '')
    const sleep = options.sleep ?? realSleep
    const now = options.now ?? Date.now
    let lastWrite = Number.NEGATIVE_INFINITY
    // Writes run one at a time: each waits for the one before it.
    let writeQueue: Promise<unknown> = Promise.resolve()

    async function send(method: string, path: string, body: unknown): Promise<Response> {
        try {
            return await doFetch(`${baseUrl}${path}`, {
                method,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${options.token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                // The token is the only credential: no cookies to or from GitHub.
                credentials: 'omit',
            })
        } catch (error) {
            throw new GitHubError('offline', `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    async function attempt<T>(method: string, path: string, body: unknown, write: boolean): Promise<T> {
        let rateLimited = 0
        let failed = 0
        for (;;) {
            if (write) {
                const wait = lastWrite + WRITE_SPACING_MS - now()
                if (wait > 0) await sleep(wait)
                lastWrite = now()
            }
            const response = await send(method, path, body)
            if (response.ok) {
                const text = await response.text()
                return (text === '' ? null : JSON.parse(text)) as T
            }
            const message = await response
                .json()
                .then((json: { message?: unknown }) => (typeof json?.message === 'string' ? json.message : ''))
                .catch(() => '')
            if (isRateLimit(response.status, response.headers, message)) {
                const wait = waitFor(response.headers, rateLimited, now())
                if (rateLimited >= RATE_LIMIT_ATTEMPTS - 1) {
                    throw new GitHubError('rate-limited', `GitHub asked for a wait: ${message}`, response.status, { retryAt: now() + wait })
                }
                rateLimited++
                options.onWait?.(now() + wait)
                await sleep(wait)
                continue
            }
            if (response.status >= 500 && failed < SERVER_ERROR_RETRIES) {
                failed++
                await sleep(2000 * failed)
                continue
            }
            throw new GitHubError(refusalCode(response.status, message), message || `${response.status} ${response.statusText}`, response.status)
        }
    }

    return {
        request<T>(method: string, path: string, body?: unknown): Promise<T> {
            if (method === 'GET') return attempt<T>(method, path, body, false)
            const run = writeQueue.then(() => attempt<T>(method, path, body, true))
            writeQueue = run.catch(() => undefined)
            return run
        },
    }
}

// ── Paths and encoding ─────────────────────────────────────────────────────────────────────

/** `/repos/{owner}/{name}`, each part escaped. */
export function repoPath(repo: Pick<GitHubRepository, 'owner' | 'name'>): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

/** A branch name in a ref path: a branch may hold `/`, which stays a separator. */
export function branchPath(branch: string): string {
    return branch.split('/').map(encodeURIComponent).join('/')
}

/** Standard base64, as GitHub's blob and contents endpoints take and give it. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    // In slices: one call with a large file's bytes as arguments overflows the stack.
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

/** GitHub's base64 wraps lines; the line breaks are not part of it. */
export function base64ToBytes(text: string): Uint8Array {
    const binary = atob(text.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}
