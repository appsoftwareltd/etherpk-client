/**
 * The [[Extension Directory]]'s list as the Client reads it (ADR 0123): `directory.json`, built in the
 * directory's own repository from one entry per extension, each listing the releases a person
 * reviewed, pinned by their npm integrity hash. Read on the Client's server, which fetches and
 * serves listed releases, and in the browser, which offers them in Settings.
 *
 * A release's package comes from the package registry by its name and version, or, in a directory
 * a self-hoster runs, from the address its `tarball` gives, so such a directory can be plain files.
 *
 * A release's **key** names it in the address it is served at, `/extensions/<id>/<key>/`: the first
 * 32 hexadecimal characters of its SHA-512 digest, so the address names exactly the reviewed bytes
 * and never changes. Shorter than the whole digest, which the server still checks in full.
 */
import { z } from 'zod'

import { compareVersions } from './catalogue'

const VERSION = /^\d+\.\d+\.\d+$/
const ID = /^[a-z][a-z0-9-]*$/
/** `sha512-` and the base64 of a 64-byte digest. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/

const releaseSchema = z.object({
    version: z.string().regex(VERSION),
    integrity: z.string().regex(INTEGRITY),
    minClientVersion: z.string().regex(VERSION),
    /**
     * Where the release's package is, in a directory a self-hoster runs: an address, absolute or
     * relative to the list's own, in place of the package registry. EtherPK's own directory gives
     * none: its releases come from npm.
     */
    tarball: z.string().min(1).optional(),
})

/**
 * Whether an address is https. A listed source address must be, and Settings checks again before
 * it links to one, so no other scheme reaches a link the person presses.
 */
export function isHttpsAddress(value: string): boolean {
    try {
        return new URL(value).protocol === 'https:'
    } catch {
        return false
    }
}

const httpsAddress = z.string().refine(isHttpsAddress, 'must be an https address')

const extensionSchema = z.object({
    id: z.string().regex(ID),
    displayName: z.string().min(1),
    publisher: z.string().min(1),
    description: z.string(),
    repository: httpsAddress,
    license: z.string().min(1),
    package: z.string().min(1),
    releases: z.array(releaseSchema).min(1),
})

const listingSchema = z.object({
    version: z.literal(1),
    extensions: z.array(extensionSchema),
})

export type DirectoryRelease = z.infer<typeof releaseSchema>
export type DirectoryExtension = z.infer<typeof extensionSchema>
export type DirectoryListing = z.infer<typeof listingSchema>

/** `directory.json` read and checked, or why it is not a directory list. */
export function parseDirectoryListing(value: unknown): { ok: true; listing: DirectoryListing } | { ok: false; error: string } {
    const parsed = listingSchema.safeParse(value)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return { ok: false, error: `not an Extension Directory list (${issue.path.join('.') || 'the file'}: ${issue.message})` }
    }
    // One entry per extension: a release is found by its extension's id.
    const seen = new Set<string>()
    for (const extension of parsed.data.extensions) {
        if (seen.has(extension.id)) return { ok: false, error: `not an Extension Directory list (the extension "${extension.id}" is listed twice)` }
        seen.add(extension.id)
    }
    return { ok: true, listing: parsed.data }
}

/** The key a release is served under: the first 32 hexadecimal characters of its SHA-512 digest. */
export function releaseKey(integrity: string): string {
    const bytes = atob(integrity.slice('sha512-'.length))
    let hex = ''
    for (let i = 0; i < 16; i++) hex += bytes.charCodeAt(i).toString(16).padStart(2, '0')
    return hex
}

/** Where a release's files are served on the Client's own origin, ending in `/`. */
export function releaseBase(id: string, integrity: string): string {
    return `/extensions/${id}/${releaseKey(integrity)}/`
}

/** The listed release with this key, and its extension, or null. */
export function findRelease(listing: DirectoryListing, id: string, key: string): { extension: DirectoryExtension; release: DirectoryRelease } | null {
    const extension = listing.extensions.find((candidate) => candidate.id === id)
    const release = extension?.releases.find((candidate) => releaseKey(candidate.integrity) === key)
    return extension && release ? { extension, release } : null
}

/** The newest release this Client can run, or null when every release needs a newer Client. */
export function newestRelease(extension: DirectoryExtension, clientVersion: string): DirectoryRelease | null {
    const runnable = extension.releases.filter((release) => compareVersions(release.minClientVersion, clientVersion) <= 0)
    runnable.sort((a, b) => compareVersions(b.version, a.version))
    return runnable[0] ?? null
}
