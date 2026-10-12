/**
 * Where the Client's server finds the Extension Directory, the package registry its releases come
 * from, and where it keeps the releases it fetched (ADR 0123):
 *
 * - `EXTENSION_DIRECTORY_URL`: the address of `directory.json`. Unset, EtherPK's own directory. An
 *   empty value turns the directory off: nothing is offered and nothing is installed. A list the
 *   operator names may give a release's package by address (`tarball`). EtherPK's own never does,
 *   so from it the server fetches packages from the registry alone.
 * - `EXTENSION_REGISTRY_URL`: the npm registry. Unset, npm's own.
 * - `EXTENSION_CACHE_DIR`: a folder the server may write, which no one else may. Unset, a folder of
 *   this user's own in the system's temporary folder, used only while it is this user's alone
 *   (`privateCache`): a release missing from it is fetched and checked again.
 *
 * Pure, so it is tested without the server's environment (`store.ts` reads that).
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReleaseStoreOptions } from './release-store'

export const DEFAULT_DIRECTORY_URL = 'https://raw.githubusercontent.com/appsoftwareltd/etherpk-extension-directory/main/directory.json'
export const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

/** The temporary folder's name for this user's releases: one per user, so users never share one. */
function defaultCacheDir(): string {
    const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
    return join(tmpdir(), `etherpk-extensions-${user}`)
}

/** The release store's settings from these environment variables. */
export function directorySettings(
    env: Record<string, string | undefined>,
): Pick<ReleaseStoreOptions, 'directoryUrl' | 'registryUrl' | 'cacheDir' | 'privateCache' | 'allowTarball'> {
    const directory = env.EXTENSION_DIRECTORY_URL
    const cacheDir = env.EXTENSION_CACHE_DIR?.trim()
    return {
        directoryUrl: directory === undefined ? DEFAULT_DIRECTORY_URL : directory.trim() === '' ? null : directory.trim(),
        registryUrl: env.EXTENSION_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL,
        cacheDir: cacheDir || defaultCacheDir(),
        privateCache: !cacheDir,
        allowTarball: directory !== undefined && directory.trim() !== '',
    }
}
