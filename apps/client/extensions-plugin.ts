/**
 * Vite plugin: the loaded Built-in Extensions (ADR 0121, ADR 0122), served and shipped from the
 * Client's own origin.
 *
 * A loaded extension is a prebuilt bundle in an npm package. The Client's package.json names each
 * under `etherpk.builtInExtensions`, as VS Code's product.json names its built-in extensions, and
 * the lockfile pins the exact release. This plugin:
 *
 * - **tells the Client about them** through `virtual:etherpk-loaded-extensions`: each package's
 *   package.json (its manifest) and the address its root is served at,
 *   `/extensions/<id>/<version>/`. The Client checks the manifests itself (catalogue.ts).
 * - **serves them in development** from the dev server's own origin.
 * - **ships them in the build**: every file under the folders the manifest's `main` and `styles`
 *   sit in is emitted into the Client's output at that address.
 *
 * The bundle is imported from the Client's own origin, so the Content Security Policy stays
 * `script-src 'self'`.
 *
 * In development, `ETHERPK_DEV_EXTENSIONS` names more extension folders, separated by commas,
 * absolute or relative to apps/client. They are loaded like built-in ones, and one with the id of
 * a built-in replaces it: how an extension in its own repository is developed against a Client.
 * Nothing reads the variable in a build.
 */
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const VIRTUAL_ID = 'virtual:etherpk-loaded-extensions'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const PREFIX = '/extensions/'

const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
}

export interface LoadedExtension {
    /** The package's package.json, parsed: the Client reads the manifest from it. */
    packageJson: Record<string, unknown>
    /** Where the package's root is served, ending in `/`. */
    base: string
    /** The package's folder on disk. */
    directory: string
    /** The top-level folders of the package that are served: those `main` and `styles` sit in. */
    folders: string[]
}

/** Read the loaded extensions: the ones the Client's package.json names, then the dev folders. */
export function readLoadedExtensions(clientRoot: string, devFolders: readonly string[] = []): LoadedExtension[] {
    const clientPackage = readJson(join(clientRoot, 'package.json'))
    const named = (clientPackage.etherpk as { builtInExtensions?: unknown } | undefined)?.builtInExtensions
    const builtIn = Array.isArray(named) ? named.filter((name): name is string => typeof name === 'string') : []
    const byId = new Map<string, LoadedExtension>()
    const read = (directory: string) => {
        const extension = describe(directory)
        byId.set(idOf(extension.packageJson) ?? directory, extension)
    }
    // A workspace package is a symlink into the repository: served from where it really is.
    for (const name of builtIn) {
        let directory: string
        try {
            directory = realpathSync(join(clientRoot, 'node_modules', ...name.split('/')))
        } catch {
            throw new Error(`The Client's package.json names ${name} under etherpk.builtInExtensions, but it is not installed. Run pnpm install.`)
        }
        read(directory)
    }
    for (const folder of devFolders) read(resolve(clientRoot, folder))
    return [...byId.values()]
}

function describe(directory: string): LoadedExtension {
    const packageJson = readJson(join(directory, 'package.json'))
    const manifest = (packageJson.etherpk ?? {}) as { id?: unknown; main?: unknown; styles?: unknown }
    const id = typeof manifest.id === 'string' ? manifest.id : 'unknown'
    const version = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
    const paths = [manifest.main, ...(Array.isArray(manifest.styles) ? manifest.styles : [])].filter((path): path is string => typeof path === 'string')
    const folders = [...new Set(paths.map((path) => path.replace(/^\.\//, '').split('/')[0]).filter((folder) => folder !== '' && folder !== '..'))]
    return { packageJson, base: `${PREFIX}${id}/${version}/`, directory, folders }
}

function idOf(packageJson: Record<string, unknown>): string | undefined {
    const id = (packageJson.etherpk as { id?: unknown } | undefined)?.id
    return typeof id === 'string' ? id : undefined
}

function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Every file under the extension's served folders, as paths relative to its root. */
function servedFiles(extension: LoadedExtension): string[] {
    const files: string[] = []
    const walk = (relativePath: string) => {
        const full = join(extension.directory, relativePath)
        for (const entry of readdirSync(full, { withFileTypes: true })) {
            const child = `${relativePath}/${entry.name}`
            if (entry.isDirectory()) walk(child)
            else if (entry.isFile()) files.push(child)
        }
    }
    for (const folder of extension.folders) {
        try {
            if (statSync(join(extension.directory, folder)).isDirectory()) walk(folder)
        } catch {
            // A folder that does not exist yet (the extension is not built) ships nothing; the
            // Client then says its bundle could not be fetched.
        }
    }
    return files
}

/** The served file a request names, or null when it names nothing an extension serves. */
function fileFor(extensions: readonly LoadedExtension[], url: string): string | null {
    const extension = extensions.find((candidate) => url.startsWith(candidate.base))
    if (!extension) return null
    const path = resolve(extension.directory, decodeURIComponent(url.slice(extension.base.length)))
    const allowed = extension.folders.some((folder) => path.startsWith(join(extension.directory, folder) + sep))
    return allowed ? path : null
}

export function extensionsPlugin(): Plugin {
    let extensions: LoadedExtension[] = []
    let serverSide = false
    return {
        name: 'etherpk-extensions',
        configResolved(config) {
            const devFolders = config.command === 'serve' ? (process.env.ETHERPK_DEV_EXTENSIONS ?? '').split(',').map((folder) => folder.trim()).filter(Boolean) : []
            extensions = readLoadedExtensions(config.root, devFolders)
            serverSide = Boolean(config.build.ssr)
        },
        resolveId(id) {
            return id === VIRTUAL_ID ? RESOLVED_ID : undefined
        },
        load(id) {
            if (id !== RESOLVED_ID) return undefined
            for (const extension of extensions) this.addWatchFile(join(extension.directory, 'package.json'))
            return `export default ${JSON.stringify(extensions.map(({ packageJson, base }) => ({ packageJson, base })))}`
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url?.split('?')[0] ?? ''
                if (!url.startsWith(PREFIX)) return next()
                const path = fileFor(extensions, url)
                let found = false
                try {
                    found = path !== null && statSync(path).isFile()
                } catch {
                    found = false
                }
                if (!path || !found) {
                    res.statusCode = 404
                    return res.end(`No ${url}: is the extension built?`)
                }
                res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream')
                // A rebuilt extension keeps its address in development, so nothing may be cached.
                res.setHeader('cache-control', 'no-store')
                createReadStream(path).pipe(res)
            })
        },
        generateBundle() {
            // The client build ships the files: the server build has no use for them.
            const consumer = (this as { environment?: { config?: { consumer?: string } } }).environment?.config?.consumer
            if (consumer === 'server' || (consumer === undefined && serverSide)) return
            for (const extension of extensions) {
                for (const file of servedFiles(extension)) {
                    this.emitFile({
                        type: 'asset',
                        fileName: `${extension.base.slice(1)}${file}`,
                        source: readFileSync(join(extension.directory, file)),
                    })
                }
            }
        },
    }
}
