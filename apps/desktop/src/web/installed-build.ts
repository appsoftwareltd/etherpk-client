/**
 * Answering `app://etherpk` from the Installed Build, the Client as a folder of static files.
 *
 * What is answered is `installedAnswer`, the Installed Build's own rule: a file that is there with its
 * type and a policy, a navigation to one of the Client's addresses with the shell page, and a 404 for
 * everything else. An answer of HTML to a request for data or a script would be read as the wrong thing.
 */
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
// The rules of the folder this serves, which its maker keeps.
import { installedAnswer, NOT_FOUND_POLICY } from '@appsoftwareltd/etherpk-native-bridge/installed-serving'

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
}

/** The shell page's policy, which every file has but a page with its own beside it. */
const POLICY_FILE = 'csp.txt'
/** Compressed copies are for a web server, and source maps for a developer. A policy is read, not served. */
const NOT_SERVED = /\.(br|gz|map)$/

async function pathsIn(root: string, dir = ''): Promise<string[]> {
    const out: string[] = []
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.isDirectory()) out.push(...(await pathsIn(root, path)))
        else if (entry.isFile() && !NOT_SERVED.test(path)) out.push(path)
    }
    return out
}

export interface PageRequest { method: string; url: string; navigation: boolean }

export class InstalledBuild {
    private constructor(
        private readonly root: string,
        /** Every file there is. A path that is not one of these never reaches the disk. */
        private readonly files: ReadonlySet<string>,
        /** Every policy file's text, by its path. */
        private readonly policies: ReadonlyMap<string, string>,
    ) {}

    static async open(root: string): Promise<InstalledBuild> {
        const files = new Set(await pathsIn(root))
        const policies = new Map<string, string>()
        for (const path of files) if (path.endsWith(POLICY_FILE)) policies.set(path, (await readFile(join(root, path), 'utf8')).trim())
        if (!policies.get(POLICY_FILE) || !files.has('index.html')) throw new Error(`${root} is not an Installed Build.`)
        return new InstalledBuild(root, files, policies)
    }

    /** The file a request is for, or null. */
    fileFor(request: PageRequest): string | null {
        const answer = this.answerFor(request)
        return answer.status === 200 ? answer.file : null
    }

    private answerFor({ method, url, navigation }: PageRequest) {
        let path: string
        try {
            path = new URL(url).pathname
        } catch {
            return { status: 404 } as const
        }
        return installedAnswer({ method, path, navigation }, (file) => this.files.has(file))
    }

    async answer(request: PageRequest): Promise<Response> {
        const answer = this.answerFor(request)
        if (answer.status !== 200) {
            return new Response(answer.status === 404 ? 'Not found' : 'Method not allowed', {
                status: answer.status,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': NOT_FOUND_POLICY },
            })
        }
        const { file } = answer
        const headers: Record<string, string> = {
            'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            // A name with its content's hash in it never means anything else. The rest changes with an update.
            'Cache-Control': file.startsWith('_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache',
            // On every file, scripts too: a worker takes the policy its own script is answered with.
            'Content-Security-Policy': this.policies.get(answer.policyFile)!,
        }
        const body = request.method === 'HEAD' ? null : new Uint8Array(await readFile(join(this.root, file)))
        return new Response(body, { headers })
    }
}
