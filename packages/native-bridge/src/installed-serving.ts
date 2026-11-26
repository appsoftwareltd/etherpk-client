/**
 * How a Native App's shell answers a request to its own host, from the Installed Build's files. The
 * Client's build (`apps/client/installed-build.ts`), its reference server and the desktop app use it;
 * Android follows the same rules in Kotlin. All are checked against
 * `test-vectors/installed-build-serving.json`.
 */

/**
 * Whether an address that names no file here is the app's to show, for a shell to answer with
 * `index.html`. A workspace address may end in a file's name (`/folder/Recipes/f/soup.md`, a page called
 * "Version 1.2"), so only outside a workspace does a dot in the last part mean a file.
 */
export function isPageAddress(pathname: string): boolean {
    if (/^\/(?:api|auth|_app|extensions|demo-graph|__native|__etherpk-[a-z]+)(?:\/|$)/.test(pathname)) return false
    return /^\/(?:graph|folder|g)\//.test(pathname) || !/\.[^/]*$/.test(pathname)
}

/** The policy of an answer that is not a file of the build: nothing it holds may run or load. */
export const NOT_FOUND_POLICY = "default-src 'none'"

/**
 * What a shell answers for one request to its own host, `path` as it was sent, still escaped. The
 * desktop app and the reference server answer with this. Android answers with the same rules in
 * Kotlin, and all three are checked against `packages/native-bridge/test-vectors/installed-build-serving.json`.
 *
 * - A file of the build is answered as it is. Its policy is its own `<path>.csp.txt` for a page that
 *   has one, and `csp.txt` for everything else, scripts too: a worker takes the policy its own
 *   script is answered with, so a script answered with none would run a worker with none.
 * - A GET navigation to an address of the app gets `index.html`, with `csp.txt`.
 * - Anything else is a 404, a method that writes a 405, each with {@link NOT_FOUND_POLICY}.
 *
 * `has` says whether the build holds a file. It is only asked of a path that stays inside the build and
 * is not a policy file, which is a file of the build's making and not of the app.
 */
export type InstalledAnswer = { status: 200; file: string; policyFile: string } | { status: 404 | 405 }

export function installedAnswer(request: { method: string; path: string; navigation: boolean }, has: (file: string) => boolean): InstalledAnswer {
    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405 }
    let file: string
    try {
        file = decodeURIComponent(request.path).replace(/^\//, '')
    } catch {
        return { status: 404 }
    }
    if (isBuildFileName(file) && has(file)) return { status: 200, file, policyFile: file.endsWith('.html') && has(`${file}.${POLICY_FILE}`) ? `${file}.${POLICY_FILE}` : POLICY_FILE }
    if (request.navigation && isPageAddress(request.path)) return { status: 200, file: SHELL_PAGE, policyFile: POLICY_FILE }
    return { status: 404 }
}

const SHELL_PAGE = 'index.html'
const POLICY_FILE = 'csp.txt'

/** A path that may be looked for among the build's files: inside it, plainly written, and not a policy. */
function isBuildFileName(path: string): boolean {
    const parts = path.split('/')
    // A policy file is read where `has` is asked of it above, never served.
    if (path.endsWith(POLICY_FILE)) return false
    return parts.every((part) => part !== '' && part !== '.' && part !== '..' && ![...part].some((char) => char === '\\' || char < ' '))
}
