/**
 * The rules of the Installed Build: the Client as a folder of static files for a Native App's
 * shell (apps/desktop, apps/android) to serve, with no server behind it. `scripts/build-installed.mjs`
 * does the building. What is decided is here, so that it is unit tested.
 *
 * What a shell is given, in `build-installed/`:
 *
 * - `index.html`: the shell page (ADR 0142), for a GET navigation that names no file here, where
 *   {@link isPageAddress} says so. It hands the address to the router. Any other address with no file is a
 *   404: a missing script or data file answered with a page would be run or parsed as one.
 * - `csp.txt`: the Content-Security-Policy header of `index.html`. A page with a policy of its own has
 *   `<its path>.csp.txt` beside it, as the page an EBook reads in does (ADR 0181).
 * - `service-worker.js`: the Theme editor's preview and nothing else (`src/service-worker/installed.ts`).
 *   The desktop app registers it.
 * - `_app/env.js` and the rest of the Client's files, at the addresses the page asks for.
 *
 * **Settings.** A Native App has no server to read settings from, so it carries those it was built
 * with, and anyone can read them out of it. Only the names below are carried, all optional, all unset
 * unless the build's environment sets them:
 *
 * | Build-time name | What it becomes |
 * | --- | --- |
 * | `INSTALLED_ACCOUNT_ISSUER` | The account site: its account, billing, pricing and legal links |
 * | `INSTALLED_MANAGED_SYNC_URL` | `PUBLIC_MANAGED_SYNC_URL` |
 * | `INSTALLED_WEB_CLIENT_URL` | The web Client the app names in what it writes for others: the demo, an invite |
 * | Any other public setting of `src/env.ts` | The same name |
 */
import { createHash } from 'node:crypto'

/** Every public setting the Client declares (`src/env.ts`), which `installed-build.test.ts` compares. */
export const PUBLIC_SETTINGS: ReadonlySet<string> = new Set([
    'PUBLIC_MANAGED_SYNC_URL',
    'PUBLIC_CUSTOM_SYNC_URL',
    'PUBLIC_DICTIONARY_URL',
    'PUBLIC_TELEMETRY_URL',
    'PUBLIC_TELEMETRY_WEBSITE_ID',
    'PUBLIC_TERMS_URL',
    'PUBLIC_PRIVACY_URL',
    'PUBLIC_MAP_STYLE_URL',
    'PUBLIC_MAP_STYLE_URL_DARK',
    'PUBLIC_PLACE_SEARCH_URL',
    'PUBLIC_POSTCODES_URL',
])

const ACCOUNT_ISSUER = 'INSTALLED_ACCOUNT_ISSUER'
const MANAGED_SYNC_URL = 'INSTALLED_MANAGED_SYNC_URL'
const WEB_CLIENT_URL = 'INSTALLED_WEB_CLIENT_URL'

/** A ceiling on the whole build, so a large dependency or a stray file is noticed. Raise it on purpose. */
export const SIZE_LIMIT_BYTES = 45 * 1024 * 1024

export interface InstalledSettings {
    accountIssuer: string | null
    /** The web Client's origin. */
    webClientUrl: string | null
    /** For the server the shell page is captured from. Holds names of {@link PUBLIC_SETTINGS} only. */
    publicEnvironment: Record<string, string>
}

type Environment = Readonly<Record<string, string | undefined>>

/** The settings to build with. Throws for a name that is not on the list and for an address an app must not use. */
export function installedSettings(environment: Environment): InstalledSettings {
    const publicEnvironment: Record<string, string> = {}
    let accountIssuer: string | null = null
    let webClientUrl: string | null = null
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined || !/^(?:INSTALLED|PUBLIC)_/.test(name)) continue
        if (name === ACCOUNT_ISSUER) accountIssuer = accountIssuerOf(value)
        else if (name === WEB_CLIENT_URL) webClientUrl = value === '' ? null : new URL(checkedAddress(name, value)).origin
        else if (name === MANAGED_SYNC_URL) {
            if (value !== '') publicEnvironment.PUBLIC_MANAGED_SYNC_URL = checkedAddress(name, value)
        } else publicEnvironment[listedName(name)] = name.endsWith('_URL') && value !== '' ? checkedAddress(name, value) : value
    }
    return { accountIssuer, webClientUrl, publicEnvironment }
}

function listedName(name: string): string {
    // The managed server has a name of its own, so that a setting left over from running the web
    // Client never makes a Native App one of the managed service's.
    if (name === 'PUBLIC_MANAGED_SYNC_URL') throw new Error(`Set ${MANAGED_SYNC_URL}, not ${name}, for an Installed Build.`)
    if (PUBLIC_SETTINGS.has(name)) return name
    throw new Error(`${name} is not a setting an Installed Build carries. installed-build.ts lists those it does.`)
}

/**
 * The account site an app signs in to, as every part of a Native App names it: an https address (or
 * plain HTTP to this machine for a test build) with no name or password and no `/` at the end, since
 * the page, the desktop shell and the Android shell each compare it with the issuer the site names.
 * Null for an empty value, which leaves sign-in off. The shells read it from {@link SETTINGS_FILE}.
 */
export function accountIssuerOf(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? null : checkedAddress(ACCOUNT_ISSUER, trimmed).replace(/\/+$/, '')
}

/**
 * The settings of a build that its shells need too, beside `index.html`. Each shell's own build reads
 * the account site from it, so that the page and the shell cannot be built with two.
 */
export const SETTINGS_FILE = 'installed-settings.json'

export function settingsFileOf(settings: Pick<InstalledSettings, 'accountIssuer'>): string {
    return `${JSON.stringify({ accountIssuer: settings.accountIssuer }, null, 4)}\n`
}

/** https, or plain HTTP to this machine for a test build, with no name or password in it. */
function checkedAddress(name: string, value: string): string {
    const url = URL.canParse(value) ? new URL(value) : null
    const local = url?.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    if (!url || (url.protocol !== 'https:' && !local) || url.username || url.password) {
        throw new Error(`${name} must be an https address with no name or password in it.`)
    }
    return value
}

// How a shell answers a request to its own host lives beside the Native Bridge, which the desktop app
// reads it from without this module's build-time code.
export { installedAnswer, isPageAddress, NOT_FOUND_POLICY, type InstalledAnswer } from '@appsoftwareltd/etherpk-native-bridge/installed-serving'

/** Inline `<script>` blocks: the bytes between the tags are what a policy's hash is of. */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g
const NONCE_ATTRIBUTE = /(<(?:script|link|style)\b[^>]*?)\s+nonce="[^"]*"/g
const MANIFEST_LINK = /[ \t]*<link rel="manifest"[^>]*>\r?\n?/g

function inlineScriptHashes(html: string): string[] {
    return [...new Set([...html.matchAll(INLINE_SCRIPT)].map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`))]
}

/**
 * A page a server rendered, and its policy, as static files. Each response a server gives has a nonce
 * of its own. A file has one for ever, which anything that reads the file knows, so the scripts are
 * named by their hashes instead. The report address goes too: there is no server to report to.
 */
export function staticPage(html: string, policy: string): { html: string; policy: string } {
    const page = html.replace(NONCE_ATTRIBUTE, '$1').replace(MANIFEST_LINK, '')
    const directives = policy.split(';').map((directive) => directive.trim()).filter((directive) => directive !== '' && !directive.startsWith('report-uri '))
    const at = directives.findIndex((directive) => directive.startsWith('script-src '))
    if (at === -1) throw new Error('The page’s policy has no script-src, so its scripts cannot be named.')
    const kept = directives[at].split(/\s+/).filter((source) => !/^'(?:nonce|sha256)-/.test(source))
    directives[at] = [...kept, ...inlineScriptHashes(page)].join(' ')
    // form-action is not inherited from default-src. A form that is not the page's own to handle
    // would carry the app's window off to wherever it names.
    if (!directives.some((directive) => directive.startsWith('form-action'))) directives.push("form-action 'self'")
    return { html: page, policy: directives.join('; ') }
}

/** The settings SvelteKit wrote into a page or `_app/env.js`: an object literal of strings and `void 0`. */
export function bakedEnvironment(text: string): Record<string, string | undefined> {
    const literal = /\benv\s*[:=]\s*\{((?:\s*"?[A-Z0-9_]+"?\s*:\s*(?:void 0|"(?:[^"\\]|\\.)*")\s*,?)*)\s*\}/.exec(text)
    if (!literal) throw new Error('No env object was found, so the settings in it cannot be checked.')
    const found: Record<string, string | undefined> = {}
    for (const [, name, value] of literal[1].matchAll(/"?([A-Z0-9_]+)"?\s*:\s*(void 0|"(?:[^"\\]|\\.)*")/g)) {
        found[name] = value === 'void 0' ? undefined : (JSON.parse(value) as string)
    }
    return found
}

/** Pictures of the public pages and of the browser's install dialog, and files only a web server has a use for. */
const LEFT_OUT = [/^marketing\//, /^screenshots\//, /^(?:site\.webmanifest|robots\.txt|service-worker\.js)$/]
/** Copies for a server to send, and source maps. */
const NOT_FOR_A_SHELL = /\.(?:br|gz|map)$/

/** Whether a file of `build/client` goes into the Installed Build. Its service worker is another one. */
export function isShippedFile(path: string): boolean {
    return !NOT_FOR_A_SHELL.test(path) && !LEFT_OUT.some((pattern) => pattern.test(path))
}

const NEEDED = ['index.html', 'csp.txt', SETTINGS_FILE, '_app/env.js', 'service-worker.js', '__etherpk-ebook/reader.html', '__etherpk-ebook/reader.html.csp.txt']

export interface BuildCheck {
    /** Private settings of the machine that built it, by name: their values must be in no file. */
    secrets: Readonly<Record<string, string>>
    sizeLimit: number
}

/** What is wrong with a finished build, in words. Empty when nothing is. Never repeats a secret. */
export function checkInstalledBuild(files: ReadonlyMap<string, string | Uint8Array>, { secrets, sizeLimit }: BuildCheck): string[] {
    const text = (path: string) => asText(files.get(path) ?? '')
    return [
        ...NEEDED.filter((path) => !files.has(path)).map((path) => `${path} is missing.`),
        ...[...files.keys()].filter((path) => NOT_FOR_A_SHELL.test(path)).map((path) => `${path} should not ship.`),
        ...pageProblems(text('index.html'), text('csp.txt'), files),
        ...['index.html', '_app/env.js'].flatMap((path) => settingProblems(path, text(path))),
        ...secretProblems(files, secrets),
        ...sizeProblems(files, sizeLimit),
    ]
}

function pageProblems(html: string, policy: string, files: ReadonlyMap<string, unknown>): string[] {
    const loaded = [...html.matchAll(/(?:src|href)="\/([^"]+)"|import\("\/([^"]+)"\)/g)].map((match) => match[1] ?? match[2])
    return [
        ...(/\snonce=/.test(html) || policy.includes("'nonce-") ? ['A nonce is left in the page or its policy.'] : []),
        ...inlineScriptHashes(html).filter((hash) => !policy.includes(hash)).map((hash) => `The policy does not name the inline script with the hash ${hash}.`),
        ...loaded.filter((path) => /\.[a-z0-9]+$/.test(path) && !files.has(path)).map((path) => `The page loads ${path}, which is missing.`),
    ]
}

function settingProblems(path: string, text: string): string[] {
    try {
        return Object.keys(bakedEnvironment(text)).filter((name) => !PUBLIC_SETTINGS.has(name)).map((name) => `${path} carries ${name}, which is not a public setting.`)
    } catch (error) {
        return [`${path}: ${(error as Error).message}`]
    }
}

function secretProblems(files: ReadonlyMap<string, string | Uint8Array>, secrets: Readonly<Record<string, string>>): string[] {
    return Object.entries(secrets).flatMap(([name, value]) =>
        [...files].filter(([, content]) => asText(content).includes(value)).map(([path]) => `${path} holds the value of ${name}.`),
    )
}

function sizeProblems(files: ReadonlyMap<string, string | Uint8Array>, limit: number): string[] {
    const total = [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0)
    return total > limit ? [`The build is ${total} bytes, over the ${limit} it may be.`] : []
}

/** Bytes one for one, so that a value is found in a binary file as well. */
function asText(content: string | Uint8Array): string {
    return typeof content === 'string' ? content : Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('latin1')
}
