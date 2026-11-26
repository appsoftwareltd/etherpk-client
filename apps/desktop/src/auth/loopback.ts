/**
 * The address on this computer a sign-in comes back to. It listens on 127.0.0.1 only, on a port the
 * system picks, for one sign-in, and answers one path.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Loopback {
    redirectUri: string
    close(): void
}

/** `taken` is whether the callback was this sign-in's. */
export type OnCallback = (query: URLSearchParams) => { taken: boolean; signedIn: boolean }

const page = (heading: string, words: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EtherPK</title>
<style>:root{color-scheme:light dark}body{font:1rem/1.5 system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 1rem}h1{font-size:1.25rem}</style><h1>${heading}</h1><p>${words}</p></html>`

const SIGNED_IN = page('You are signed in', 'Go back to EtherPK. You can close this page.')
const NOT_SIGNED_IN = page('You are not signed in', 'Go back to EtherPK to try again. You can close this page.')
const NOT_THIS = page('This page is not in use', 'Go back to EtherPK and sign in again.')

function answer(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        Connection: 'close',
    })
    response.end(body)
}

function callbackQuery(request: IncomingMessage, host: string): URLSearchParams | null {
    if (request.method !== 'GET' || request.headers.host !== host) return null
    const url = URL.canParse(request.url ?? '', `http://${host}`) ? new URL(request.url!, `http://${host}`) : null
    return url?.pathname === '/callback' ? url.searchParams : null
}

export async function listenForCallback(onCallback: OnCallback): Promise<Loopback> {
    let host = ''
    const server = createServer((request, response) => {
        const query = callbackQuery(request, host)
        if (query === null) return answer(response, 404, NOT_THIS)
        const { taken, signedIn } = onCallback(query)
        if (!taken) return answer(response, 400, NOT_THIS)
        answer(response, 200, signedIn ? SIGNED_IN : NOT_SIGNED_IN)
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
        redirectUri: `http://${host}/callback`,
        close() {
            server.close()
            // The answer being written is let finish. A connection a browser keeps open is not.
            server.closeIdleConnections()
        },
    }
}
