/**
 * Serves the Installed Build the way a shell does, for the browser suite that checks it
 * (playwright-client-installed.config.ts). What a shell answers is `installedAnswer` in
 * `installed-build.ts`, which the desktop app answers with too, and the same cases check Android's.
 *
 * Usage: node scripts/serve-installed.mjs <port>
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installedAnswer, NOT_FOUND_POLICY } from '../installed-build.ts'

const root = fileURLToPath(new URL('../build-installed/', import.meta.url))
const port = Number(process.argv[2])

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
}
const COMMON = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const has = (file) => existsSync(join(root, file)) && statSync(join(root, file)).isFile()

createServer((request, response) => {
    const answer = installedAnswer({
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://x').pathname,
        navigation: request.headers['sec-fetch-mode'] === 'navigate',
    }, has)
    if (answer.status !== 200) {
        response.writeHead(answer.status, { ...COMMON, 'Content-Type': 'text/plain', 'Content-Security-Policy': NOT_FOUND_POLICY }).end(answer.status === 404 ? 'Not found' : 'Method not allowed')
        return
    }
    response.writeHead(200, {
        ...COMMON,
        'Content-Type': TYPES[extname(answer.file)] ?? 'application/octet-stream',
        'Content-Security-Policy': readFileSync(join(root, answer.policyFile), 'utf8').trim(),
    })
    createReadStream(join(root, answer.file)).pipe(response)
}).listen(port, '127.0.0.1')
