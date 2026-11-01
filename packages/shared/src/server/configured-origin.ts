/**
 * The `ORIGIN` setting for the apps' Node servers.
 *
 * SvelteKit builds each request's URL from an origin and the path, and its CSRF check compares a
 * form post's `Origin` header with that origin. The Node adapter took the origin from `ORIGIN`
 * until adapter-node 6, which reads only a value fixed when the image is built (`paths.origin`),
 * then the headers `PROTOCOL_HEADER` and `HOST_HEADER` name, then `https` and the `Host` header.
 * One published image serves every self-hoster, so a build-time value cannot hold their address,
 * and a server reached over plain HTTP, or behind a proxy that rewrites `Host`, would refuse its
 * own form posts.
 *
 * So the servers keep `ORIGIN` themselves: when it is set, the adapter is pointed at two headers of
 * ours, and every request is stamped with them before the adapter sees it. A value a visitor sends
 * in either header is overwritten. With `ORIGIN` unset, nothing changes.
 */
import type { IncomingMessage } from 'node:http'

/** The headers the adapter reads the origin from when `ORIGIN` is set. */
export const ORIGIN_PROTOCOL_HEADER = 'x-etherpk-origin-protocol'
export const ORIGIN_HOST_HEADER = 'x-etherpk-origin-host'

export interface ConfiguredOrigin {
    /** `http` or `https`, without the colon, as the adapter expects it. */
    protocol: string
    /** The host and any port. */
    host: string
}

/** `ORIGIN` read, or null when it is unset. A value that is not an HTTP or HTTPS origin throws. */
export function parseConfiguredOrigin(value: string | undefined): ConfiguredOrigin | null {
    const trimmed = value?.trim()
    if (!trimmed) return null
    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        throw new Error(`ORIGIN must be an origin such as https://sync.example.com, not "${trimmed}"`)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`ORIGIN must be an HTTP or HTTPS origin with no path, such as https://sync.example.com, not "${trimmed}"`)
    }
    return { protocol: url.protocol.slice(0, -1), host: url.host }
}

/**
 * Prepare the adapter for `ORIGIN`, and return what stamps a request with it, or null when
 * `ORIGIN` is unset. Call it before the adapter's handler loads: the adapter reads its header
 * settings once, when it loads. Run the stamp first on every request, ahead of the adapter
 * (`server.prependListener('request', stamp)`).
 */
export function configureOrigin(environment: Record<string, string | undefined>): ((req: IncomingMessage) => void) | null {
    const origin = parseConfiguredOrigin(environment.ORIGIN)
    if (!origin) return null
    environment.PROTOCOL_HEADER = ORIGIN_PROTOCOL_HEADER
    environment.HOST_HEADER = ORIGIN_HOST_HEADER
    // The port is part of ORIGIN's host. A port header would add a second one.
    delete environment.PORT_HEADER
    return (req) => {
        req.headers[ORIGIN_PROTOCOL_HEADER] = origin.protocol
        req.headers[ORIGIN_HOST_HEADER] = origin.host
    }
}
