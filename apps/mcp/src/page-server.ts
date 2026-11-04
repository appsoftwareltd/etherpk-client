/**
 * A server for the pages the Headless Client draws pictures in (map-pictures.ts,
 * drawing-pictures.ts): on the loopback address, answering one page and the files named to it and
 * nothing else, so a page's workers, chunks and fonts load over http as they do in the Client. Open
 * only for a publish that draws something.
 */
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
}

/** A file built beside this module in the published package (dist/), or in dist/ when run from source. */
export function builtPath(...path: string[]): string {
    const here = dirname(fileURLToPath(import.meta.url))
    return here.endsWith('dist') ? join(here, ...path) : join(here, '..', 'dist', ...path)
}

/** Every file under `folder`, by the path a page asks for it at. Empty when the folder is missing. */
export async function filesUnder(folder: string): Promise<Map<string, string>> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
    return new Map(files.map((file) => [`/${relative(folder, file).split(sep).join('/')}`, file]))
}

/** The server: `html` at `/page.html`, and each of `files` at its path. */
export async function servePage(html: string, files: ReadonlyMap<string, string>): Promise<{ server: Server; origin: string }> {
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (path === '/page.html') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html)
            return
        }
        const file = files.get(path)
        if (!file) {
            response.writeHead(404).end()
            return
        }
        readFile(file).then(
            (bytes) => response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(bytes),
            () => response.writeHead(404).end(),
        )
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The page server has no port.')
    return { server, origin: `http://127.0.0.1:${address.port}` }
}
