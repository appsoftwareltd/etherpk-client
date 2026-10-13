import { describe, expect, it, vi } from 'vitest'

import { createPersonSettings } from '$lib/person-settings/person-settings'

import type { CatalogueEntry } from './catalogue'
import { createExtensionDirectory } from './directory'
import { type DirectoryExtension, type DirectoryRelease, releaseBase } from './directory-format'
import { createExtensionHost } from './host'
import { createInstalledExtensions } from './installed'
import { installedIds } from './installed-sync'
import { createExtensionSwitches } from './switches'
import { fakeClientServices, fakeGraphServices, memoryStorage } from './testing'

// Installing from the Extension Directory in the browser, over a real host, with the Client's
// server answered by a fake fetch. Every name here is invented.

const integrity = (fill: string) => `sha512-${fill.repeat(86)}==`
const release = (version: string, fill = 'A'): DirectoryRelease => ({ version, integrity: integrity(fill), minClientVersion: '0.9.0' })

const orchard: DirectoryExtension = {
    id: 'orchard',
    displayName: 'Orchard',
    publisher: 'example',
    description: 'Trees in rows.',
    repository: 'https://github.com/example/etherpk-extension-orchard',
    license: 'MIT',
    package: '@example/etherpk-extension-orchard',
    releases: [release('1.1.0', 'B'), release('1.0.0')],
}

function packageJson(version: string, id = 'orchard') {
    return { name: '@example/etherpk-extension-orchard', version, etherpk: { id, displayName: 'Orchard', publisher: 'example', minClientVersion: '0.9.0', main: './dist/main.js' } }
}

function setUp(answers: Record<string, () => Response> = {}, builtIns: CatalogueEntry[] = []) {
    const storage = memoryStorage()
    const activate = vi.fn()
    const host = createExtensionHost({ catalogue: { extensions: builtIns, broken: [] }, client: fakeClientServices(storage), switches: createExtensionSwitches(storage), importModule: async () => ({ activate }) })
    const installed = createInstalledExtensions(storage)
    const requests: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
        const url = String(input)
        requests.push(url)
        const answer = answers[url]
        if (answer) return answer()
        if (url === `${releaseBase('orchard', integrity('A'))}package.json`) return Response.json(packageJson('1.0.0'))
        if (url === `${releaseBase('orchard', integrity('B'))}package.json`) return Response.json(packageJson('1.1.0'))
        return new Response('missing', { status: 404 })
    }) as typeof fetch
    const settings = createPersonSettings(() => storage)
    const directory = createExtensionDirectory({ host, installed, settings, clientVersion: '0.9.6', fetch: fakeFetch, storage, now: () => 5_000 })
    return { host, installed, directory, requests, activate, storage, settings }
}

describe('the Extension Directory in the browser', () => {
    it("reads the list as the Client's server gives it, or says why it cannot", async () => {
        const listing = { state: 'ok', listing: { version: 1, extensions: [orchard] } }
        const { directory } = setUp({ '/api/extensions/directory': () => Response.json(listing) })
        expect(await directory.load()).toEqual(listing)
        const down = setUp({ '/api/extensions/directory': () => Response.json({ message: 'The server is restarting.' }, { status: 503 }) })
        expect(await down.directory.load()).toEqual({ state: 'unavailable', error: 'The server is restarting.' })
    })

    it('installs a listed release: fetched from its own address, kept on the device, started in the open graph, and the person’s', async () => {
        const { host, installed, directory, requests, activate, settings } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        expect(requests).toContain(`${releaseBase('orchard', integrity('A'))}package.json`)
        expect(installed.list()).toEqual([{ id: 'orchard', version: '1.0.0', integrity: integrity('A'), packageJson: packageJson('1.0.0') }])
        expect(host.status('orchard')).toEqual({ state: 'running' })
        expect(activate).toHaveBeenCalledTimes(1)
        // In the person's settings, so it follows them to their other devices.
        expect(installedIds(settings)).toEqual(['orchard'])
    })

    it("says why, and keeps nothing, when the Client's server refuses the release", async () => {
        const refused = `${releaseBase('orchard', integrity('A'))}package.json`
        const { installed, directory, settings } = setUp({ [refused]: () => Response.json({ message: 'The package downloaded for it is not the one the Extension Directory lists.' }, { status: 502 }) })
        await expect(directory.install(orchard, release('1.0.0'))).rejects.toThrow('The package downloaded for it is not the one the Extension Directory lists.')
        expect(installed.list()).toEqual([])
        expect(installedIds(settings)).toEqual([])
    })

    it('refuses a package that is not the release listed, and an id an extension that comes with EtherPK has', async () => {
        const wrong = `${releaseBase('orchard', integrity('A'))}package.json`
        const { directory, installed } = setUp({ [wrong]: () => Response.json(packageJson('1.0.0', 'garden')) })
        await expect(directory.install(orchard, release('1.0.0'))).rejects.toThrow(/"garden", not "orchard"/)
        expect(installed.list()).toEqual([])

        const builtIn: CatalogueEntry = { id: 'orchard', source: 'compiled-in', module: { activate: () => {} }, package: { name: 'orchard', version: '0.9.6', manifest: { id: 'orchard', displayName: 'Orchard', publisher: 'App Software', main: './src/extension.ts' } } }
        await expect(setUp({}, [builtIn]).directory.install(orchard, release('1.0.0'))).rejects.toThrow(/comes with EtherPK/)
    })

    it('replaces an installed release with another at once, saying when', async () => {
        const { host, installed, directory } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        await directory.installRelease(orchard, release('1.1.0', 'B'))
        expect(installed.list()).toMatchObject([{ version: '1.1.0', updatedAt: 5_000 }])
        expect(host.catalogue.extensions.find((entry) => entry.id === 'orchard')?.installed?.version).toBe('1.1.0')
        expect(host.status('orchard')).toEqual({ state: 'running' })
    })

    it('stages a newer release, checked and fetched, leaving the running one running', async () => {
        const { host, installed, directory, requests } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        await directory.stageRelease(orchard, release('1.1.0', 'B'))
        expect(requests).toContain(`${releaseBase('orchard', integrity('B'))}package.json`)
        expect(installed.list()).toMatchObject([{ version: '1.0.0', next: { version: '1.1.0', integrity: integrity('B') } }])
        expect(host.catalogue.extensions.find((entry) => entry.id === 'orchard')?.installed?.version).toBe('1.0.0')
    })

    it('removes an extension: stopped, forgotten, what it kept on the device cleared, and no longer the person’s', async () => {
        const { host, installed, directory, storage, settings } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        storage.setItem('etherpk-orchard:trees', '12')
        storage.setItem('etherpk-garden:beds', '3')
        directory.remove('orchard')
        expect(installed.list()).toEqual([])
        expect(host.catalogue.extensions.map((entry) => entry.id)).not.toContain('orchard')
        expect(storage.getItem('etherpk-orchard:trees')).toBeNull()
        expect(storage.getItem('etherpk-garden:beds')).toBe('3')
        expect(installedIds(settings)).toEqual([])
    })

    it('clears the records the extension kept with the person, on every device, and keeps the person’s answers to its settings', async () => {
        const { host, directory, settings } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        settings.set('extension-data.orchard.accounts', '["gardener@example.com"]')
        settings.set('extension-data.orchard.calendars', '{}')
        settings.set('extension-data.garden.beds', '3')
        settings.set('extension.orchard.client-id', 'orchard-client')
        directory.remove('orchard')
        expect(settings.keys('extension-data.')).toEqual(['extension-data.garden.beds'])
        expect(settings.get('extension.orchard.client-id')).toBe('orchard-client')
        // Cleared rather than forgotten, so the clearing reaches the person's other devices.
        expect(settings.merge('https://sync.example a1', {})).toMatchObject({ 'extension-data.orchard.accounts': { value: null } })
    })

    it('stops an extension on this device alone, keeping what it holds when asked to', async () => {
        const { host, installed, directory, storage, settings } = setUp()
        await host.start(fakeGraphServices().services)
        await directory.install(orchard, release('1.0.0'))
        storage.setItem('etherpk-orchard:trees', '12')
        directory.removeFromDevice('orchard', { clearStorage: false })
        expect(installed.list()).toEqual([])
        expect(host.catalogue.extensions.map((entry) => entry.id)).not.toContain('orchard')
        expect(storage.getItem('etherpk-orchard:trees')).toBe('12')
        // Still the person's: it comes back when a release this Client can run is listed.
        expect(installedIds(settings)).toEqual(['orchard'])
    })
})
