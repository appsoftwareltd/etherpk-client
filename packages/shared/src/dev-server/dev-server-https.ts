/**
 * Optional HTTPS for an app's Vite dev server, for testing it from another device through a TLS
 * proxy such as Tailscale Serve.
 *
 * Why the dev server needs HTTPS even behind a proxy that terminates TLS: SvelteKit's dev server
 * builds each request's origin from Vite's `server.https` setting and the Host header, not from the
 * proxy's forwarded headers. Over plain HTTP it sees `http://<host>` while the browser sends
 * `Origin: https://<host>`, and every same-origin check refuses the request. Serving HTTPS on the
 * hop from the proxy makes the origin come out right. The certificate on that hop can be
 * self-signed, because only the proxy sees it.
 *
 * Settings, all optional, read when `vite.config.ts` is loaded:
 *
 * - `DEV_SERVER_HTTPS_CERT` and `DEV_SERVER_HTTPS_KEY`: paths to a PEM certificate and its key.
 *   Both or neither. The files are read here, so a wrong path stops startup naming the setting.
 * - `DEV_SERVER_ALLOWED_HOSTS`: comma-separated host names for Vite's `server.allowedHosts`. Vite
 *   refuses a request, and the HMR WebSocket, whose Host header it does not know.
 *
 * Node-only, like `../build-stamp/resolve-build-info`, and imported relatively by the config files.
 */

import { readFileSync } from 'node:fs'

/** The part of Vite's `server` options this sets; spread it into the config's `server`. */
export interface DevServerHttps {
    https?: { cert: Buffer; key: Buffer }
    allowedHosts?: string[]
}

type Environment = Record<string, string | undefined>

function setting(env: Environment, name: string): string | undefined {
    const value = env[name]?.trim()
    return value ? value : undefined
}

function readSettingFile(name: string, path: string, readFile: (path: string) => Buffer): Buffer {
    try {
        return readFile(path)
    } catch (error) {
        throw new Error(`${name} names a file that cannot be read: ${path}`, { cause: error })
    }
}

export function devServerHttps(env: Environment = process.env, readFile: (path: string) => Buffer = readFileSync): DevServerHttps {
    const options: DevServerHttps = {}

    const certPath = setting(env, 'DEV_SERVER_HTTPS_CERT')
    const keyPath = setting(env, 'DEV_SERVER_HTTPS_KEY')
    if (certPath && !keyPath) throw new Error('DEV_SERVER_HTTPS_CERT is set without DEV_SERVER_HTTPS_KEY')
    if (keyPath && !certPath) throw new Error('DEV_SERVER_HTTPS_KEY is set without DEV_SERVER_HTTPS_CERT')
    if (certPath && keyPath) {
        options.https = {
            cert: readSettingFile('DEV_SERVER_HTTPS_CERT', certPath, readFile),
            key: readSettingFile('DEV_SERVER_HTTPS_KEY', keyPath, readFile),
        }
    }

    const allowedHosts = (setting(env, 'DEV_SERVER_ALLOWED_HOSTS') ?? '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    if (allowedHosts.length > 0) options.allowedHosts = allowedHosts

    return options
}
