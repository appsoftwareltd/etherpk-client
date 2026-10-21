/**
 * An in-memory GitHub for the calls a [[Publish Repository]] makes, for tests: the unit tests
 * stub `fetch` with {@link FakeGitHub.fetch}, the Client's Playwright spec answers
 * `api.github.com` from it through `page.route`, and the Headless Client's spec serves it over
 * HTTP. One fake, so the three agree on what GitHub does.
 *
 * It keeps git's own rules where the publisher relies on them: a blob is named by its content as
 * git names it, so an unchanged file keeps its name; a tree entry with `sha: null` deletes the
 * path, and deleting a path that is not there fails the whole request; the git database
 * endpoints answer 409 on a repository with no commits; and a branch moves only forward unless
 * forced. What it answers when GitHub refuses (a bad token, no access, a protected branch, a rate
 * limit) is what GitHub's documentation and answers seen in use say, which is as far as a fake
 * can know it.
 *
 * Relative imports only: the Playwright suites load it with no `$lib` alias.
 */
import { base64ToBytes, bytesToBase64 } from '../github-api'
import { gitBlobSha } from '../git-blob-sha'

type Access = 'read' | 'write'

interface TreeEntry {
    mode: string
    sha: string
}

interface Commit {
    tree: string
    parents: string[]
    message: string
}

interface Repository {
    owner: string
    name: string
    blobs: Map<string, Uint8Array>
    /** Flat: path → entry. A real tree nests, which nothing here needs. */
    trees: Map<string, Map<string, TreeEntry>>
    commits: Map<string, Commit>
    refs: Map<string, string>
    protectedBranches: Set<string>
}

export interface FakeRequest {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string | null
}

export interface FakeResponse {
    status: number
    headers: Record<string, string>
    body: string
}

export interface RecordedRequest {
    method: string
    path: string
    body: unknown
}

/** What every answer carries: GitHub allows any origin and exposes the rate limit headers. */
const CORS_HEADERS: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
    'access-control-expose-headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Used, Location',
}

const textEncoder = new TextEncoder()

class Refusal extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly headers: Record<string, string> = {},
    ) {
        super(message)
    }
}

export class FakeGitHub {
    readonly requests: RecordedRequest[] = []
    private readonly repositories = new Map<string, Repository>()
    private readonly tokens = new Map<string, Map<string, Access>>()
    private counter = 0
    private pendingRateLimits: { count: number; retryAfter: number } = { count: 0, retryAfter: 0 }
    private refUpdateHook: (() => Promise<void> | void) | null = null
    /** When set, a recursive tree is listed as truncated, as GitHub does past 100,000 entries. */
    truncateTrees = false

    constructor(readonly baseUrl = 'https://api.github.com') {}

    // ── Setting it up ────────────────────────────────────────────────────────────────────

    /** Let `token` reach `fullName` (`owner/name`), read-only or read and write. */
    allow(token: string, fullName: string, access: Access = 'write'): void {
        const repos = this.tokens.get(token) ?? new Map<string, Access>()
        repos.set(fullName, access)
        this.tokens.set(token, repos)
    }

    /** A repository, empty unless `files` are given, which are committed to `branch`. */
    async createRepository(fullName: string, options: { files?: Record<string, string | Uint8Array>; branch?: string } = {}): Promise<void> {
        const [owner, name] = fullName.split('/')
        this.repositories.set(fullName, { owner, name, blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), protectedBranches: new Set() })
        if (options.files) await this.push(fullName, options.branch ?? 'main', options.files)
    }

    /** Someone else's push: a commit on top of the branch (or its first) changing `files`; null deletes one. */
    async push(fullName: string, branch: string, files: Record<string, string | Uint8Array | null>, message = 'A push from elsewhere'): Promise<string> {
        const repo = this.repo(fullName)
        const head = repo.refs.get(branch)
        const entries = new Map(head ? this.treeOf(repo, head) : [])
        for (const [path, content] of Object.entries(files)) {
            if (content === null) entries.delete(path)
            else entries.set(path, { mode: '100644', sha: await this.storeBlob(repo, typeof content === 'string' ? textEncoder.encode(content) : content) })
        }
        const sha = this.storeCommit(repo, { tree: await this.storeTree(repo, entries), parents: head ? [head] : [], message })
        repo.refs.set(branch, sha)
        return sha
    }

    protect(fullName: string, branch: string): void {
        this.repo(fullName).protectedBranches.add(branch)
    }

    /** The next `count` writes are refused as GitHub's secondary rate limit, asking for `retryAfter` seconds. */
    rateLimitWrites(count: number, retryAfter = 30): void {
        this.pendingRateLimits = { count, retryAfter }
    }

    /** Run `hook` once, just before the next branch update: how a test moves the branch under a publish. */
    beforeNextRefUpdate(hook: () => Promise<void> | void): void {
        this.refUpdateHook = hook
    }

    // ── Reading it back ──────────────────────────────────────────────────────────────────

    /** The files on a branch, by path. */
    files(fullName: string, branch = 'main'): Map<string, Uint8Array> {
        const repo = this.repo(fullName)
        const head = repo.refs.get(branch)
        const out = new Map<string, Uint8Array>()
        if (!head) return out
        for (const [path, entry] of this.treeOf(repo, head)) out.set(path, repo.blobs.get(entry.sha) as Uint8Array)
        return out
    }

    text(fullName: string, path: string, branch = 'main'): string | null {
        const bytes = this.files(fullName, branch).get(path)
        return bytes ? new TextDecoder().decode(bytes) : null
    }

    /** The branch's commits, newest first. */
    history(fullName: string, branch = 'main'): { sha: string; message: string; parents: string[] }[] {
        const repo = this.repo(fullName)
        const out: { sha: string; message: string; parents: string[] }[] = []
        let sha = repo.refs.get(branch)
        while (sha) {
            const commit = repo.commits.get(sha) as Commit
            out.push({ sha, message: commit.message, parents: commit.parents })
            sha = commit.parents[0]
        }
        return out
    }

    hasBranch(fullName: string, branch: string): boolean {
        return this.repo(fullName).refs.has(branch)
    }

    // ── Answering ────────────────────────────────────────────────────────────────────────

    /** `fetch` over the fake, for unit tests. */
    readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((value, key) => (headers[key] = value))
        const answer = await this.handle({ method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : null })
        return new Response(answer.status === 204 ? null : answer.body, { status: answer.status, headers: answer.headers })
    }) as typeof fetch

    async handle(request: FakeRequest): Promise<FakeResponse> {
        const method = request.method.toUpperCase()
        if (method === 'OPTIONS') return { status: 204, headers: { ...CORS_HEADERS }, body: '' }
        const url = new URL(request.url)
        const path = url.pathname.slice(new URL(this.baseUrl).pathname.replace(/\/$/, '').length)
        const body = request.body ? JSON.parse(request.body) : undefined
        this.requests.push({ method, path, body })
        try {
            const json = await this.route(method, path, url.searchParams, body, request.headers ?? {})
            return { status: json.status, headers: { 'content-type': 'application/json', ...CORS_HEADERS }, body: JSON.stringify(json.body) }
        } catch (error) {
            if (!(error instanceof Refusal)) throw error
            return {
                status: error.status,
                headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...error.headers },
                body: JSON.stringify({ message: error.message, documentation_url: 'https://docs.github.com/rest' }),
            }
        }
    }

    private async route(method: string, path: string, query: URLSearchParams, body: Record<string, unknown> | undefined, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
        const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path)
        if (!match) throw new Refusal(404, 'Not Found')
        const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
        const rest = match[3] ?? ''
        const write = method !== 'GET'
        const repo = this.authorise(fullName, headers, write)
        if (write && this.pendingRateLimits.count > 0) {
            this.pendingRateLimits.count--
            throw new Refusal(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', { 'retry-after': String(this.pendingRateLimits.retryAfter) })
        }
        const empty = repo.refs.size === 0
        let m: RegExpExecArray | null

        if (rest === '' && method === 'GET') return { status: 200, body: { full_name: fullName, default_branch: 'main', private: true } }

        if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
            if (empty) throw new Refusal(409, 'Git Repository is empty.')
            const branch = decodeBranch(m[1])
            const sha = repo.refs.get(branch)
            if (!sha) throw new Refusal(404, 'Not Found')
            return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } }
        }

        if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
            const commit = repo.commits.get(m[1])
            if (!commit) throw new Refusal(404, 'Not Found')
            return { status: 200, body: { sha: m[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })), message: commit.message } }
        }

        if ((m = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
            const tree = repo.trees.get(m[1])
            if (!tree) throw new Refusal(404, 'Not Found')
            return { status: 200, body: { sha: m[1], tree: listTree(tree, query.get('recursive') !== null), truncated: this.truncateTrees } }
        }

        if ((m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
            const blob = repo.blobs.get(m[1])
            if (!blob) throw new Refusal(404, 'Not Found')
            // GitHub wraps its base64 at 60 characters; the client has to cope.
            return { status: 200, body: { sha: m[1], size: blob.length, encoding: 'base64', content: bytesToBase64(blob).replace(/(.{60})/g, '$1\n') } }
        }

        if (rest === '/git/blobs' && method === 'POST') {
            if (empty) throw new Refusal(409, 'Git Repository is empty.')
            const { content, encoding } = body as { content: string; encoding?: string }
            const bytes = encoding === 'base64' ? base64ToBytes(content) : textEncoder.encode(content)
            return { status: 201, body: { sha: await this.storeBlob(repo, bytes) } }
        }

        if (rest === '/git/trees' && method === 'POST') {
            if (empty) throw new Refusal(409, 'Git Repository is empty.')
            const { base_tree: baseTree, tree } = body as { base_tree?: string; tree: { path: string; mode: string; type: string; sha?: string | null; content?: string }[] }
            if (!Array.isArray(tree) || tree.length === 0) throw new Refusal(422, 'Invalid tree info')
            const base = baseTree ? repo.trees.get(baseTree) : new Map<string, TreeEntry>()
            if (!base) throw new Refusal(422, 'Invalid tree info')
            const entries = new Map(base)
            for (const entry of tree) {
                if (entry.content !== undefined && entry.sha !== undefined) throw new Refusal(422, 'Only one of content or sha may be given')
                if (entry.sha === null) {
                    if (!entries.delete(entry.path)) throw new Refusal(422, `GitRPC::BadObjectState - path ${entry.path} does not exist`)
                } else if (entry.content !== undefined) {
                    entries.set(entry.path, { mode: entry.mode, sha: await this.storeBlob(repo, textEncoder.encode(entry.content)) })
                } else {
                    if (!entry.sha || !repo.blobs.has(entry.sha)) throw new Refusal(422, 'Invalid tree info')
                    entries.set(entry.path, { mode: entry.mode, sha: entry.sha })
                }
            }
            return { status: 201, body: { sha: await this.storeTree(repo, entries), truncated: false } }
        }

        if (rest === '/git/commits' && method === 'POST') {
            if (empty) throw new Refusal(409, 'Git Repository is empty.')
            const { message, tree, parents } = body as { message: string; tree: string; parents?: string[] }
            if (!repo.trees.has(tree)) throw new Refusal(422, 'Tree SHA does not exist')
            for (const parent of parents ?? []) if (!repo.commits.has(parent)) throw new Refusal(422, 'Parent SHA does not exist or is not a commit object')
            const sha = this.storeCommit(repo, { tree, parents: parents ?? [], message })
            return { status: 201, body: { sha, html_url: `https://github.com/${fullName}/commit/${sha}`, tree: { sha: tree } } }
        }

        if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
            const branch = decodeBranch(m[1])
            const hook = this.refUpdateHook
            this.refUpdateHook = null
            await hook?.()
            const { sha, force } = body as { sha: string; force?: boolean }
            const current = repo.refs.get(branch)
            if (!current) throw new Refusal(422, 'Reference does not exist')
            if (repo.protectedBranches.has(branch)) throw new Refusal(422, `Protected branch update failed for refs/heads/${branch}.`)
            if (!force && !this.descendsFrom(repo, sha, current)) throw new Refusal(422, 'Update is not a fast forward')
            repo.refs.set(branch, sha)
            return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } }
        }

        if (rest === '/git/refs' && method === 'POST') {
            const { ref, sha } = body as { ref: string; sha: string }
            if (empty) throw new Refusal(409, 'Git Repository is empty.')
            const branch = ref.replace(/^refs\/heads\//, '')
            if (repo.refs.has(branch)) throw new Refusal(422, 'Reference already exists')
            if (!repo.commits.has(sha)) throw new Refusal(422, 'Object does not exist')
            repo.refs.set(branch, sha)
            return { status: 201, body: { ref, object: { sha, type: 'commit' } } }
        }

        if ((m = /^\/contents\/(.+)$/.exec(rest)) && method === 'PUT') {
            const filePath = decodeBranch(m[1])
            const { message, content, branch = 'main' } = body as { message: string; content: string; branch?: string }
            if (!empty && !repo.refs.has(branch)) throw new Refusal(404, `Branch ${branch} not found`)
            const sha = await this.push(fullName, branch, { [filePath]: base64ToBytes(content) }, message)
            return { status: 201, body: { commit: { sha, html_url: `https://github.com/${fullName}/commit/${sha}` } } }
        }

        throw new Refusal(404, 'Not Found')
    }

    // ── Inside ───────────────────────────────────────────────────────────────────────────

    private repo(fullName: string): Repository {
        const repo = this.repositories.get(fullName)
        if (!repo) throw new Error(`No repository ${fullName} in the fake`)
        return repo
    }

    /** GitHub's answers for a token: 401 when it is not one, 404 when it cannot see the repository, 403 when it cannot write. */
    private authorise(fullName: string, headers: Record<string, string>, write: boolean): Repository {
        const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1] ?? ''
        const access = this.tokens.get(auth.replace(/^(Bearer|token)\s+/i, ''))
        if (!access) throw new Refusal(401, 'Bad credentials')
        const level = access.get(fullName)
        const repo = this.repositories.get(fullName)
        if (!level || !repo) throw new Refusal(404, 'Not Found')
        if (write && level !== 'write') throw new Refusal(403, 'Resource not accessible by personal access token')
        return repo
    }

    private async storeBlob(repo: Repository, bytes: Uint8Array): Promise<string> {
        const sha = await gitBlobSha(bytes)
        repo.blobs.set(sha, bytes)
        return sha
    }

    private async storeTree(repo: Repository, entries: Map<string, TreeEntry>): Promise<string> {
        const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1))
        const sha = await gitBlobSha(`tree ${JSON.stringify(sorted)}`)
        repo.trees.set(sha, new Map(sorted))
        return sha
    }

    private storeCommit(repo: Repository, commit: Commit): string {
        const sha = (++this.counter).toString(16).padStart(40, 'c')
        repo.commits.set(sha, commit)
        return sha
    }

    private treeOf(repo: Repository, commitSha: string): Map<string, TreeEntry> {
        const commit = repo.commits.get(commitSha) as Commit
        return repo.trees.get(commit.tree) as Map<string, TreeEntry>
    }

    private descendsFrom(repo: Repository, sha: string, ancestor: string): boolean {
        const queue = [sha]
        while (queue.length > 0) {
            const next = queue.shift() as string
            if (next === ancestor) return true
            queue.push(...(repo.commits.get(next)?.parents ?? []))
        }
        return false
    }
}

function decodeBranch(path: string): string {
    return path.split('/').map(decodeURIComponent).join('/')
}

/** A flat tree as GitHub lists it: the files, and with `recursive` the folders between them too. */
function listTree(tree: Map<string, TreeEntry>, recursive: boolean): { path: string; mode: string; type: string; sha: string }[] {
    const out: { path: string; mode: string; type: string; sha: string }[] = []
    const folders = new Set<string>()
    for (const [path, entry] of tree) {
        const parts = path.split('/')
        if (!recursive && parts.length > 1) {
            if (!folders.has(parts[0])) out.push({ path: parts[0], mode: '040000', type: 'tree', sha: '0'.repeat(40) })
            folders.add(parts[0])
            continue
        }
        for (let i = 1; i < parts.length; i++) {
            const folder = parts.slice(0, i).join('/')
            if (!folders.has(folder)) out.push({ path: folder, mode: '040000', type: 'tree', sha: '0'.repeat(40) })
            folders.add(folder)
        }
        out.push({ path, mode: entry.mode, type: 'blob', sha: entry.sha })
    }
    return out
}
