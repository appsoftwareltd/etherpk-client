/**
 * The rules the service worker (`src/service-worker.ts`) follows to start the Client with no
 * network (ADR 0142), kept here so they are unit tested apart from the worker's plumbing.
 *
 * The Client's pages are rendered by its server, so a cached copy of one page cannot simply be
 * served at another address: the page carries its route and params for hydration. Instead the
 * worker keeps one page made for the purpose, the shell (`/offline-shell`), and serves it for any
 * app page it cannot fetch. The shell hydrates as itself and then hands the real address to the
 * router, which loads that route in the browser. The root and `(app)` layouts' server data, which
 * the shell carries, depends on nothing in the address, so the router has no reason to fetch it
 * again.
 */

/** The page the worker keeps, and serves for an app page it cannot fetch. */
export const SHELL_PATH = '/offline-shell'

const APP_CACHE_PREFIX = 'etherpk-app-'

/** Extension release files, kept across app versions: a release's address names its contents. */
export const EXTENSION_CACHE = 'etherpk-extension-files'

/**
 * The list of files a build ships for its loaded Built-in Extensions, written by the build
 * (`extensions-plugin.ts`). SvelteKit's list of build files leaves them out, so the worker
 * fetches this list when it installs and caches each file with the version's own.
 */
export const BUILT_IN_EXTENSION_FILES = '/extensions/built-in-files.json'

/** The cache holding one app version's files and its shell. */
export function appCacheName(version: string): string {
    return `${APP_CACHE_PREFIX}${version}`
}

/**
 * The pages a person opens to work: the root resolver, the Graphs page, the Share Target and
 * every workspace address. Each is served by the shell when it cannot be fetched. The public
 * pages, sign-in, the server routes, the demo (whose graph is fetched from the server) and the
 * dev harnesses are left to the network.
 */
export function isAppPagePath(pathname: string): boolean {
    return pathname === '/' || pathname === '/graphs' || pathname === '/share' || /^\/g\/[^/]+(\/.*)?$/.test(pathname)
}

/** A build file whose name carries its hash, so a cached copy is always the right one. */
export function isImmutableAppFile(pathname: string): boolean {
    return pathname.startsWith('/_app/immutable/')
}

/**
 * A web worker's script. The files a worker loads itself (the index's SQLite wasm and its OPFS
 * proxy, the spell checker's wasm) are not on SvelteKit's list of build files, but each worker
 * script names them by their full path, so the service worker reads them out of the scripts
 * (`referencedAppFiles`) and caches them with the rest.
 */
export function isWorkerScript(pathname: string): boolean {
    return /^\/_app\/immutable\/workers\/[^/]+\.js$/.test(pathname)
}

/**
 * The app caches to delete when `current` activates. The cache made just before it is kept as
 * well, because a tab opened before the update still runs that version and loads its route
 * files as it goes. `keys` is in creation order, which is the order `caches.keys()` returns.
 */
export function appCachesToDelete(keys: readonly string[], current: string): string[] {
    const older = keys.filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== current)
    return older.slice(0, -1)
}

/**
 * Every `/_app/immutable/` file a text names: a page's stylesheets, preloads and entry imports,
 * or the files a worker script loads.
 */
export function referencedAppFiles(text: string): string[] {
    // A path ends at a quote of any kind (minified scripts use backticks), a space, a bracket or a comma.
    return [...new Set(text.match(/\/_app\/immutable\/[^"'`\s),]+/g) ?? [])]
}

/**
 * Remove the shell from every app cache, as signing out does: it carries the signed-in page's
 * layout data. The next app page fetched online caches a new one. Does nothing where the page has
 * no Cache API.
 */
export async function forgetShell(): Promise<void> {
    if (typeof caches === 'undefined') return
    for (const key of await caches.keys()) {
        if (key.startsWith(APP_CACHE_PREFIX)) await (await caches.open(key)).delete(SHELL_PATH)
    }
}

/**
 * True when `html` is a page this version can start from: it loads app files, and every one is a
 * file this version caches. A page from a newer deployment names files this version never
 * cached, and served offline it would load nothing.
 */
export function shellMatchesBuild(html: string, appFiles: ReadonlySet<string>): boolean {
    const referenced = referencedAppFiles(html)
    return referenced.length > 0 && referenced.every((file) => appFiles.has(file))
}

/**
 * What to do with a cached extension file after the server answered `status`. A release taken
 * out of the directory is refused (410), so its cached copy must go too, or it would still load
 * offline. A 304 or a failure says nothing new about the file.
 */
export function extensionFileStatus(status: number): 'keep' | 'forget' | 'leave' {
    if (status === 200) return 'keep'
    if (status === 404 || status === 410) return 'forget'
    return 'leave'
}
