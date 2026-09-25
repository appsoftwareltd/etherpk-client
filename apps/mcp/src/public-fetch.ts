/**
 * Fetching text from the public internet, and nowhere else: the only network reads a tool makes
 * with an address it did not choose itself (a theme published at a URL, and every file its
 * manifest lists). The URL comes from a document or a tool argument, so a collaborator or a
 * prompt-injected agent could otherwise point this process at a service on the local machine or
 * the network it sits on, and read the answer back through `read_theme_file`.
 *
 * The rules: https only, no credentials in the URL, every address the host resolves to must be
 * public, redirects are followed by hand and each hop checked the same way, and a response is cut
 * off by a deadline and a size cap. The address check runs inside the socket's own DNS lookup, so
 * the address connected to is the address checked; resolving first and connecting afterwards
 * would let a second resolution answer differently.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns'
import type { IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

/** Ranges no theme is served from: loopback, private, link-local, shared, reserved, documentation, multicast. */
const blocked = new BlockList()
for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

/** Whether an IP address is one on the public internet. Anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address)
    if (family === 4) return !blocked.check(address, 'ipv4')
    if (family !== 6) return false
    // An IPv4 address written in IPv6 form, dotted or in hex, is judged as the IPv4 address it is.
    // (BlockList cannot hold an IPv4-mapped rule: it applies one to plain IPv4 checks too.)
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
    if (dotted) return isPublicAddress(dotted[1])
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
    if (hex) {
        const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)]
        return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return !blocked.check(address, 'ipv6')
}

type Lookup = (hostname: string, options: LookupAllOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void

export interface PublicFetchDeps {
    /** How host names resolve; the system resolver by default. */
    lookup?: Lookup
    /** How an https request is made; `node:https` by default. */
    request?: typeof httpsRequest
    /** The longest a fetch may take, redirects included. */
    timeoutMs?: number
    /** The most bytes one response may carry. */
    maxBytes?: number
    maxRedirects?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Far above any real theme file, and a bound on what one response can hold in memory. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3

class NotPublicError extends Error {
    readonly code = 'ENOTPUBLIC'
}

/** A lookup that answers only when every address the name resolves to is public. */
function publicOnly(lookup: Lookup) {
    return (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
        lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error)
            const refused = addresses.find((entry) => !isPublicAddress(entry.address))
            if (refused || addresses.length === 0) {
                return callback(new NotPublicError(`${hostname} resolves to ${refused?.address ?? 'no address'}, which is not a public address.`))
            }
            if (options.all) callback(null, addresses)
            else callback(null, addresses[0].address, addresses[0].family)
        })
    }
}

function checkUrl(url: URL): void {
    if (url.protocol !== 'https:') throw new Error(`Only https URLs can be fetched, not ${url.protocol}//${url.host}.`)
    if (url.username || url.password) throw new Error('A URL with credentials in it cannot be fetched.')
}

type Hop = { redirect: URL } | { text: string }

function fetchOnce(url: URL, deps: Required<PublicFetchDeps>, deadline: number): Promise<Hop> {
    return new Promise<Hop>((resolve, reject) => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return reject(new Error(`Fetching ${url.href} took longer than ${deps.timeoutMs / 1000} seconds.`))
        const req = deps.request(
            url,
            { method: 'GET', lookup: publicOnly(deps.lookup) as never, headers: { accept: '*/*', 'user-agent': 'etherpk-mcp' } },
            (res: IncomingMessage) => {
                const status = res.statusCode ?? 0
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume()
                    return resolve({ redirect: new URL(res.headers.location, url) })
                }
                if (status < 200 || status >= 300) {
                    res.resume()
                    return reject(new Error(`${status} ${res.statusMessage ?? ''}`.trim()))
                }
                const chunks: Buffer[] = []
                let size = 0
                res.on('data', (chunk: Buffer) => {
                    size += chunk.byteLength
                    if (size > deps.maxBytes) {
                        req.destroy(new Error(`${url.href} is larger than ${deps.maxBytes} bytes.`))
                        return
                    }
                    chunks.push(chunk)
                })
                res.on('end', () => {
                    clearTimeout(timer)
                    if (size <= deps.maxBytes) resolve({ text: Buffer.concat(chunks).toString('utf8') })
                })
                res.on('error', reject)
            },
        )
        const timer = setTimeout(() => req.destroy(new Error(`Fetching ${url.href} took longer than ${deps.timeoutMs / 1000} seconds.`)), remaining)
        req.on('error', (error: Error) => {
            clearTimeout(timer)
            reject(error)
        })
        req.end()
    })
}

/** The text at a public https URL, under the rules at the top of this module. */
export async function fetchPublicText(href: string, options: PublicFetchDeps = {}): Promise<string> {
    const deps: Required<PublicFetchDeps> = {
        lookup: options.lookup ?? (dnsLookup as unknown as Lookup),
        request: options.request ?? httpsRequest,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    }
    const deadline = Date.now() + deps.timeoutMs
    let url = new URL(href)
    for (let hops = 0; ; hops += 1) {
        checkUrl(url)
        const hop = await fetchOnce(url, deps, deadline)
        if ('text' in hop) return hop.text
        if (hops >= deps.maxRedirects) throw new Error(`${href} redirected more than ${deps.maxRedirects} times.`)
        url = hop.redirect
    }
}
