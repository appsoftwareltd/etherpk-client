/** Fetching a release to the app's own folder, and proving it is the file the signed feed named. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Release } from './feed.ts'

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

/** No bytes for this long ends the download. It can be started again. */
const STALLED_AFTER_MS = 60_000

export async function isRelease(path: string, release: Release): Promise<boolean> {
    const stats = await stat(path).catch(() => null)
    if (stats?.size !== release.size) return false
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    return hash.digest('hex') === release.sha512
}

/** The file's path once it is whole and checked. A file that was fetched before is not fetched again. */
export async function downloadRelease(release: Release, dir: string, fetcher: Fetcher, progress: (received: number) => void): Promise<string> {
    await mkdir(dir, { recursive: true })
    // The name says nothing the server chose: it is the checksum.
    const suffix = new URL(release.url).pathname.endsWith('.exe') ? '.exe' : '.bin'
    const name = `${release.sha512.slice(0, 32)}${suffix}`
    await clearOthers(dir, name)
    const path = join(dir, name)
    if (await isRelease(path, release)) return path
    try {
        await fetchInto(path, release, fetcher, progress)
        if (!(await isRelease(path, release))) throw new Error('The download is not the file the feed names.')
        return path
    } catch (error) {
        await rm(path, { force: true })
        throw error
    }
}

async function clearOthers(dir: string, keep: string): Promise<void> {
    for (const name of await readdir(dir)) if (name !== keep) await rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
}

async function fetchInto(path: string, release: Release, fetcher: Fetcher, progress: (received: number) => void): Promise<void> {
    const abort = new AbortController()
    let stalled = setTimeout(() => abort.abort(), STALLED_AFTER_MS)
    const handle = await open(path, 'w', 0o700)
    try {
        const response = await fetcher(release.url, { signal: abort.signal })
        if (!response.ok || !response.body) throw new Error(`The download was answered with ${response.status}.`)
        let received = 0
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            clearTimeout(stalled)
            stalled = setTimeout(() => abort.abort(), STALLED_AFTER_MS)
            received += chunk.length
            if (received > release.size) throw new Error('The download is longer than the feed says.')
            await handle.writeFile(chunk)
            progress(received)
        }
        await handle.sync()
    } finally {
        clearTimeout(stalled)
        await handle.close()
    }
}
