/**
 * A file of a release installed from the Extension Directory (ADR 0123), from the Client's own
 * origin, so the Content Security Policy stays `script-src 'self'`. The release store fetches the
 * release from the package registry the first time, checks it against the hash the directory
 * lists, and answers from its cache after that.
 *
 * The address names the release by its hash, so its files never change. Even so a browser is told
 * to ask again each time (`no-cache`, answered with 304 while nothing changed), because the answer
 * also depends on the release still being listed: a release taken out of the directory is refused
 * (410) on the next load, not a year later.
 *
 * A Built-in Extension's files are under `/extensions/<id>/<version>/`, which the build ships as
 * static files and the dev server's plugin serves, so they never reach this route.
 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { json } from '@sveltejs/kit'

import { releaseStore } from '$lib/server/extension-directory/store'

import type { RequestHandler } from './$types'

const TYPES: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
}

async function serve(params: { id: string; key: string; path: string }, request: Request, body: boolean): Promise<Response> {
    const found = await releaseStore().file(params.id, params.key, params.path)
    if (!found.ok) return json({ message: found.message }, { status: found.status, headers: { 'cache-control': 'no-store' } })
    const etag = `"${params.key}"`
    const headers = {
        'content-type': TYPES[extname(found.file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        etag,
        'x-content-type-options': 'nosniff',
    }
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    if (!body) return new Response(null, { headers: { ...headers, 'content-length': String(found.size) } })
    return new Response(new Uint8Array(await readFile(found.file)), { headers })
}

export const GET: RequestHandler = ({ params, request }) => serve(params, request, true)
export const HEAD: RequestHandler = ({ params, request }) => serve(params, request, false)
