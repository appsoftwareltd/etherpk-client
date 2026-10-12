import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type DirectoryListing, releaseKey } from '$lib/extensions/directory-format'

import { createReleaseStore, registryName, releasePath } from './release-store'
import { integrityOf, packageTarball } from './testing'

// The Extension Directory's list and an npm registry, answered by a fake fetch, over a real cache
// folder. Every name and file here is invented.

const DIRECTORY = 'https://directory.example/directory.json'
const REGISTRY = 'https://registry.example'
const PACKAGE = '@example/etherpk-extension-garden'

function gardenPackage(overrides: Record<string, unknown> = {}): Uint8Array {
    return packageTarball({
        'package.json': JSON.stringify({ name: PACKAGE, version: '1.0.0', etherpk: { id: 'garden', main: './dist/main.js' }, ...overrides }),
        'dist/main.js': 'export function activate() {}',
        'dist/chunks/beds.js': 'export const beds = 2',
    })
}

function listingFor(integrity: string, id = 'garden'): DirectoryListing {
    return {
        version: 1,
        extensions: [
            {
                id,
                displayName: 'Garden',
                publisher: 'example',
                description: 'Beds and paths.',
                repository: 'https://github.com/example/etherpk-extension-garden',
                license: 'MIT',
                package: PACKAGE,
                releases: [{ version: '1.0.0', integrity, minClientVersion: '0.9.0' }],
            },
        ],
    }
}

interface World {
    listing: DirectoryListing | null
    /** What the registry says the version's integrity is, when it differs from the package's. */
    registryIntegrity?: string
    tarball: Uint8Array
    requests: string[]
    failListing: boolean
    /** Every request fails with this, as a request to a host that cannot be reached does. */
    unreachable?: Error
    /** The registry answers its record of the package with something that is not JSON. */
    garbledRecord?: boolean
}

function fakeFetch(world: World): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = String(input)
        world.requests.push(url)
        if (world.unreachable) throw world.unreachable
        if (url === DIRECTORY) {
            if (world.failListing || !world.listing) return new Response('down', { status: 503 })
            return Response.json(world.listing)
        }
        if (url === `${REGISTRY}/${registryName(PACKAGE)}`) {
            if (world.garbledRecord) return new Response('<html>an error page</html>')
            return Response.json({ name: PACKAGE, versions: { '1.0.0': { dist: { integrity: world.registryIntegrity ?? integrityOf(world.tarball), tarball: `${REGISTRY}/garden.tgz` } } } })
        }
        if (url === `${REGISTRY}/garden.tgz`) return new Response(world.tarball as Uint8Array<ArrayBuffer>)
        return new Response('missing', { status: 404 })
    }) as typeof fetch
}

let cacheDir: string
let clock: number
let world: World

beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'etherpk-release-store-'))
    clock = 1_000_000
    const tarball = gardenPackage()
    world = { listing: listingFor(integrityOf(tarball)), tarball, requests: [], failListing: false }
})

afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
})

function store(directoryUrl: string | null = DIRECTORY, extra: { allowTarball?: boolean; privateCache?: boolean } = {}) {
    return createReleaseStore({ directoryUrl, registryUrl: REGISTRY, cacheDir, fetch: fakeFetch(world), now: () => clock, ...extra })
}

const key = () => releaseKey(integrityOf(world.tarball))
const exists = (path: string) =>
    stat(path).then(
        () => true,
        () => false,
    )
const text = async (result: Awaited<ReturnType<ReturnType<typeof store>['file']>>) => (result.ok ? readFile(result.file, 'utf8') : `${result.status}: ${result.message}`)

describe('the Extension Directory list', () => {
    it('is off with no address, and serves nothing', async () => {
        const off = store(null)
        expect(await off.listing()).toEqual({ state: 'off' })
        expect((await off.file('garden', key(), 'dist/main.js')).ok).toBe(false)
        expect(world.requests).toEqual([])
    })

    it('is read once, used for ten minutes, then read again', async () => {
        const s = store()
        expect((await s.listing()).state).toBe('ok')
        await s.listing()
        expect(world.requests.filter((url) => url === DIRECTORY)).toHaveLength(1)
        clock += 10 * 60 * 1000
        await s.listing()
        expect(world.requests.filter((url) => url === DIRECTORY)).toHaveLength(2)
    })

    it('says why when it was never read, and keeps the last one read when it cannot be read again', async () => {
        world.failListing = true
        const s = store()
        expect(await s.listing()).toMatchObject({ state: 'unavailable', error: expect.stringMatching(/HTTP 503/) })
        world.failListing = false
        clock += 60 * 1000
        expect((await s.listing()).state).toBe('ok')
        world.failListing = true
        clock += 10 * 60 * 1000
        expect((await s.listing()).state).toBe('ok')
        // A server started afresh while the directory is down uses the copy kept on disk.
        expect((await store().listing()).state).toBe('ok')
    })
})

describe("serving a listed release from the Client's origin", () => {
    it('fetches, checks and unpacks it the first time, then serves it from the cache', async () => {
        const s = store()
        expect(await text(await s.file('garden', key(), 'dist/main.js'))).toBe('export function activate() {}')
        expect(await text(await s.file('garden', key(), 'dist/chunks/beds.js'))).toBe('export const beds = 2')
        expect(world.requests.filter((url) => url.endsWith('.tgz'))).toHaveLength(1)
    })

    it('downloads once for requests that arrive together', async () => {
        const s = store()
        const results = await Promise.all([s.file('garden', key(), 'dist/main.js'), s.file('garden', key(), 'package.json'), s.file('garden', key(), 'dist/chunks/beds.js')])
        expect(results.every((result) => result.ok)).toBe(true)
        expect(world.requests.filter((url) => url.endsWith('.tgz'))).toHaveLength(1)
    })

    it('refuses a package whose bytes are not the listed hash, and keeps nothing of it', async () => {
        const listed = gardenPackage()
        world.listing = listingFor(integrityOf(listed))
        world.tarball = gardenPackage({ description: 'changed after review' })
        world.registryIntegrity = integrityOf(listed)
        const result = await store().file('garden', releaseKey(integrityOf(listed)), 'dist/main.js')
        expect(result).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/not the one the Extension Directory lists/) })
    })

    it("refuses a release when the registry's record names another hash", async () => {
        world.registryIntegrity = integrityOf(gardenPackage({ description: 'another' }))
        expect(await store().file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/not the release the Extension Directory lists/) })
    })

    it('refuses a package whose package.json names another extension', async () => {
        world.tarball = gardenPackage({ etherpk: { id: 'orchard' } })
        world.listing = listingFor(integrityOf(world.tarball))
        expect(await store().file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/does not name the extension "garden"/) })
    })

    it('refuses a package larger than the limit', async () => {
        const s = createReleaseStore({ directoryUrl: DIRECTORY, registryUrl: REGISTRY, cacheDir, fetch: fakeFetch(world), now: () => clock, limits: { packedBytes: 10 } })
        expect(await s.file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/larger than the Client accepts/) })
    })

    it('serves nothing for a release it does not list, and stops serving one taken out of the list', async () => {
        const s = store()
        expect(await s.file('garden', 'f'.repeat(32), 'dist/main.js')).toMatchObject({ ok: false, status: 404 })
        expect((await s.file('garden', key(), 'dist/main.js')).ok).toBe(true)
        world.listing = { version: 1, extensions: [] }
        clock += 10 * 60 * 1000
        expect(await s.file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 410, message: 'This release is no longer in the Extension Directory.' })
    })

    it('serves only files inside the package', async () => {
        const s = store()
        for (const path of ['../garden.json', 'dist/../../outside', '/dist/main.js', 'complete', 'dist/missing.js']) {
            expect((await s.file('garden', key(), path)).ok, path).toBe(false)
        }
    })
})

describe('a directory a self-hoster runs, whose releases give their package by address', () => {
    it('can be a folder of plain files: the list and the packages beside it, read from disk', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'etherpk-directory-folder-'))
        try {
            await writeFile(join(folder, 'garden-1.0.0.tgz'), world.tarball)
            const listing = listingFor(integrityOf(world.tarball))
            listing.extensions[0].releases[0].tarball = 'garden-1.0.0.tgz'
            await writeFile(join(folder, 'directory.json'), JSON.stringify(listing))
            const s = createReleaseStore({ directoryUrl: pathToFileURL(join(folder, 'directory.json')).href, registryUrl: REGISTRY, cacheDir, fetch: fakeFetch(world), now: () => clock, allowTarball: true })
            expect(await text(await s.file('garden', key(), 'dist/main.js'))).toBe('export function activate() {}')
            // Nothing went to the network: no registry, no list.
            expect(world.requests).toEqual([])
        } finally {
            await rm(folder, { recursive: true, force: true })
        }
    })

    it('fetches a package from the https address the list gives, not the registry', async () => {
        world.listing!.extensions[0].releases[0].tarball = `${REGISTRY}/garden.tgz`
        expect((await store(DIRECTORY, { allowTarball: true }).file('garden', key(), 'dist/main.js')).ok).toBe(true)
        expect(world.requests.some((url) => url.includes(registryName(PACKAGE)))).toBe(false)
    })

    it('never reads a file: address that a list from the network gives', async () => {
        world.listing!.extensions[0].releases[0].tarball = 'file:///etc/garden.tgz'
        expect(await store(DIRECTORY, { allowTarball: true }).file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/does not fetch from: file:/) })
    })

    it('takes a package address only from a list its operator chose, never from EtherPK’s own', async () => {
        world.listing!.extensions[0].releases[0].tarball = 'https://elsewhere.example/garden.tgz'
        expect(await store().file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/package address/) })
        expect(world.requests.some((url) => url.startsWith('https://elsewhere.example/'))).toBe(false)
    })
})

describe('the folder releases are kept in', () => {
    it('is used only when it is this user’s own, so files another user put there are never served', async () => {
        // A folder anyone may write, holding a release that looks whole but was never checked.
        await chmod(cacheDir, 0o777)
        const planted = join(cacheDir, 'releases', 'garden', key())
        await mkdir(join(planted, 'files', 'dist'), { recursive: true })
        await writeFile(join(planted, 'files', 'dist', 'main.js'), 'export const planted = true')
        await writeFile(join(planted, 'files', 'package.json'), '{}')
        await writeFile(join(planted, 'complete'), '{}')
        expect(await text(await store(DIRECTORY, { privateCache: true }).file('garden', key(), 'dist/main.js'))).toBe('export function activate() {}')
    })

    it('loses releases half-written before a restart, once they are an hour old', async () => {
        const stale = join(cacheDir, 'releases', 'garden', 'f'.repeat(32) + '.abc.partial')
        const fresh = join(cacheDir, 'releases', 'garden', 'e'.repeat(32) + '.def.partial')
        await mkdir(stale, { recursive: true })
        await mkdir(fresh, { recursive: true })
        await utimes(stale, new Date(0), new Date(0))
        clock = 60 * 60 * 1000 + 1
        await utimes(fresh, new Date(clock - 1000), new Date(clock - 1000))
        await store().listing()
        expect(await exists(stale)).toBe(false)
        expect(await exists(fresh)).toBe(true)
    })
})

describe('what a failure says', () => {
    it("says that the list could not be fetched, never the server's own details", async () => {
        world.unreachable = new Error('getaddrinfo ENOTFOUND build.internal.example')
        const state = await store().listing()
        expect(state).toMatchObject({ state: 'unavailable', error: expect.stringMatching(/could not be fetched/) })
        expect(JSON.stringify(state)).not.toContain('internal.example')
    })

    it('says a list kept in a folder could not be read, never its path', async () => {
        const state = await store(pathToFileURL(join(cacheDir, 'missing', 'directory.json')).href).listing()
        expect(state).toMatchObject({ state: 'unavailable', error: expect.stringMatching(/could not be read/) })
        expect(JSON.stringify(state)).not.toContain(cacheDir)
    })

    it('answers a registry record that is not JSON as a release that could not be fetched', async () => {
        world.garbledRecord = true
        expect(await store().file('garden', key(), 'dist/main.js')).toMatchObject({ ok: false, status: 502, message: expect.stringMatching(/registry's record/) })
    })
})

describe('naming a release and its files', () => {
    it('writes a scoped package name as a registry address takes it', () => {
        expect(registryName('@example/etherpk-extension-garden')).toBe('@example%2fetherpk-extension-garden')
        expect(registryName('etherpk-extension-garden')).toBe('etherpk-extension-garden')
    })

    it('takes a path inside a package and nothing else', () => {
        expect(releasePath('dist/main.js')).toBe('dist/main.js')
        for (const path of ['', '/a', 'a//b', './a', 'a/../b', 'a\\b']) expect(releasePath(path), path).toBeNull()
    })
})
