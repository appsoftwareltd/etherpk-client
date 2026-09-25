/**
 * Vite plugin, development only: serves the locally built dictionary set (`pnpm
 * dictionaries:build` writes `<repo>/.dictionaries/v1/`) at `/dev-dictionaries/`, which is where
 * a development Client looks when `PUBLIC_DICTIONARY_URL` is unset (spell-service-host.ts).
 *
 * Same origin as the Client, so nothing in the Content-Security-Policy changes for it, and the
 * production host (https://dictionaries.etherpk.com) is not needed to work on spell checking.
 * `apply: 'serve'` keeps it out of every build; the folder is in `.gitignore` and
 * `.dockerignore`, so it never reaches an image either.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const PREFIX = '/dev-dictionaries/'
const ROOT = resolve(import.meta.dirname, '../../.dictionaries')

const TYPES: Record<string, string> = {
    '.json': 'application/json',
    '.aff': 'text/plain; charset=utf-8',
    '.dic': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}

export function devDictionariesPlugin(): Plugin {
    return {
        name: 'etherpk-dev-dictionaries',
        apply: 'serve',
        configureServer(server) {
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
                    res.statusCode = 404
                    return res.end(`No ${url}: run "pnpm dictionaries:build" to build the local dictionary set.`)
                }
                res.setHeader('content-type', TYPES[extname(path)] ?? 'text/plain; charset=utf-8')
                createReadStream(path).pipe(res)
            })
        },
    }
}
