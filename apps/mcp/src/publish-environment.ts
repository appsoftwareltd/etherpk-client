/**
 * The publisher's environment in Node (ADR 0082, ADR 0084): themes resolved the way the Client
 * resolves them (bundled, the graph's own, a url), KaTeX's stylesheet and fonts read from the
 * package this depends on, Mermaid through a real browser when one is available, and a site
 * folder over `fs` under the same rules as the browser's directory handle. Browser-free
 * counterpart of `host/browser-environment.ts`; the core is shared.
 */

import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { PublishEnvironment } from '$lib/document/publish/publish'
import type { SiteFolder } from '$lib/document/publish/host/site-writer'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import { createThemeLoader } from '$lib/document/publish/theme/sources'

import type { DiagramRenderer } from './diagrams'
import { fetchPublicText } from './public-fetch'

const require = createRequire(import.meta.url)

/** A url theme's files, from public https hosts only (see public-fetch.ts). */
const fetchText = (url: string): Promise<string> => fetchPublicText(url)

let katexAssetsPromise: Promise<Map<string, string | Uint8Array>> | null = null

/** `katex.min.css` plus its woff2 fonts under `fonts/`, as the stylesheet references them. */
async function katexAssets(): Promise<Map<string, string | Uint8Array>> {
    if (!katexAssetsPromise) {
        katexAssetsPromise = (async () => {
            const css = require.resolve('katex/dist/katex.min.css')
            const out = new Map<string, string | Uint8Array>([['katex.min.css', await readFile(css, 'utf8')]])
            const fonts = join(dirname(css), 'fonts')
            for (const name of await readdir(fonts)) {
                if (!name.endsWith('.woff2')) continue
                out.set(`fonts/${name}`, new Uint8Array(await readFile(join(fonts, name))))
            }
            return out
        })().catch((error: unknown) => {
            katexAssetsPromise = null
            throw error
        })
    }
    return katexAssetsPromise
}

export interface NodeEnvironmentDeps {
    /** The graph's own themes, by id. */
    graphTheme(id: string): Promise<GraphTheme | null>
    /** A browser to draw Mermaid with; absent, the environment offers no renderer and the caller must not publish diagrams. */
    renderer?: DiagramRenderer | null
}

export function createNodePublishEnvironment(deps: NodeEnvironmentDeps): PublishEnvironment {
    const renderer = deps.renderer
    return {
        loadTheme: createThemeLoader({ fetchText, graphTheme: deps.graphTheme }),
        ...(renderer ? { renderMermaid: (source: string) => renderer.render(source) } : {}),
        katexAssets,
    }
}

/** Whether a publish of these bodies needs a Mermaid renderer: a fenced block whose info string is `mermaid`. */
export function needsMermaid(bodies: Iterable<string>): boolean {
    for (const body of bodies) if (/^\s*(?:```|~~~)\s*mermaid\b/m.test(body)) return true
    return false
}

/** A directory on disk as the site writer's folder: relative `/` paths, `.git/` left alone, nothing outside the root. */
export function nodeSiteFolder(root: string): SiteFolder {
    const base = resolve(root)
    const at = (path: string): string => {
        const full = resolve(base, path)
        if (full !== base && !full.startsWith(base + sep)) throw new Error(`"${path}" is outside the publish folder.`)
        return full
    }
    const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
    return {
        async readText(path) {
            try {
                return await readFile(at(path), 'utf8')
            } catch (error) {
                if (missing(error)) return null
                throw error
            }
        },
        async readBytes(path) {
            try {
                return new Uint8Array(await readFile(at(path)))
            } catch (error) {
                if (missing(error)) return null
                throw error
            }
        },
        async writeFile(path, content) {
            const full = at(path)
            await mkdir(dirname(full), { recursive: true })
            await writeFile(full, content)
        },
        async remove(path) {
            await rm(at(path), { force: true })
        },
        async listFiles() {
            const out: string[] = []
            const walk = async (dir: string): Promise<void> => {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    if (entry.name === '.git') continue
                    const full = join(dir, entry.name)
                    if (entry.isDirectory()) await walk(full)
                    else out.push(relative(base, full).split(sep).join('/'))
                }
            }
            await mkdir(base, { recursive: true })
            await walk(base)
            return out
        },
    }
}
