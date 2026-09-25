/**
 * Vite plugin: the [[Demo Graph]] bundle manifest as a virtual module (ADR 0069).
 *
 * Walks `static/demo-graph`, hands the bytes to the pure manifest builder, and serves the
 * result as `virtual:demo-graph`. The files themselves are ordinary static assets and are
 * served from `/demo-graph/...`; only the LIST is derived here, so it can never drift from the
 * committed files and nothing generated is committed. A bundle that fails validation fails
 * the build, which is where an authoring mistake belongs.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

// Relative rather than through `$lib`: this runs in the config process, before the alias exists.
import { buildDemoBundleManifest, type BundleSource } from './src/lib/demo/bundle-manifest'

const VIRTUAL_ID = 'virtual:demo-graph'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
export const DEMO_BUNDLE_DIRECTORY = 'static/demo-graph'

/** The asset store's hash: the first eight hex digits of SHA-256 (asset-store.ts). */
function assetHash(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 8)
}

async function walk(root: string, directory = root): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const paths: string[] = []
    for (const entry of entries) {
        const full = join(directory, entry.name)
        if (entry.isDirectory()) paths.push(...(await walk(root, full)))
        else if (entry.isFile()) paths.push(full)
    }
    return paths
}

export async function readDemoBundle(root: string): Promise<BundleSource[]> {
    const paths = await walk(root)
    return Promise.all(
        paths.map(async (full) => ({
            path: relative(root, full).split(sep).join('/'),
            bytes: new Uint8Array(await readFile(full)),
        })),
    )
}

export function demoGraphPlugin(directory = DEMO_BUNDLE_DIRECTORY): Plugin {
    let root = resolve(directory)
    return {
        name: 'etherpk-demo-graph',
        configResolved(config) {
            root = resolve(config.root, directory)
        },
        resolveId(id) {
            return id === VIRTUAL_ID ? RESOLVED_ID : undefined
        },
        async load(id) {
            if (id !== RESOLVED_ID) return undefined
            const sources = await readDemoBundle(root)
            // Absolute: the dev server resolves watched files as module URLs, and a relative path
            // is reported as an unresolvable import of the virtual module.
            for (const source of sources) this.addWatchFile(resolve(root, source.path))
            const manifest = buildDemoBundleManifest(sources, assetHash)
            return `export default ${JSON.stringify(manifest)}`
        },
    }
}
