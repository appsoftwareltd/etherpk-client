/**
 * Vite plugin, development only: serves the locally built postcode set (`pnpm postcodes:build`
 * writes `<repo>/.postcodes/`) at `/dev-postcodes/`, which is where a development Client looks when
 * `PUBLIC_POSTCODES_URL` is unset (the maps extension's `postcode-search.ts`).
 *
 * Same origin as the Client, so nothing in the Content-Security-Policy changes for it, and the map
 * host (https://maps.etherpk.com/postcodes) is not needed to work on postcode search. `apply:
 * 'serve'` keeps it out of every build; the folder is in `.gitignore` and `.dockerignore`, so it
 * never reaches an image either.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const PREFIX = '/dev-postcodes/'
const ROOT = resolve(import.meta.dirname, '../../.postcodes')
const BUILD_HINT = 'run "pnpm postcodes:build" to build the local postcode set (Map Host.md says where its sources come from)'

const TYPES: Record<string, string> = {
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
}

export function devPostcodesPlugin(): Plugin {
    return {
        name: 'etherpk-dev-postcodes',
        apply: 'serve',
        configureServer(server) {
            let warned = false
            server.middlewares.use(async (req, res, next) => {
                const url = req.url?.split('?')[0] ?? ''
                if (!url.startsWith(PREFIX)) return next()
                const path = resolve(ROOT, decodeURIComponent(url.slice(PREFIX.length)))
                // Never outside the folder, whatever the request spells.
                if (!path.startsWith(ROOT + sep)) {
                    res.statusCode = 400
                    return res.end()
                }
                try {
                    if (!(await stat(path)).isFile()) throw new Error('not a file')
                } catch {
                    // A search finds no postcode without the set, so the terminal says why, once.
                    if (!warned && !(await stat(ROOT).then(() => true, () => false))) {
                        warned = true
                        server.config.logger.warn(`No local postcode set in ${ROOT}: ${BUILD_HINT}.`)
                    }
                    res.statusCode = 404
                    return res.end(`No ${url}: ${BUILD_HINT}.`)
                }
                res.setHeader('content-type', TYPES[extname(path)] ?? 'text/plain; charset=utf-8')
                createReadStream(path).pipe(res)
            })
        },
    }
}
