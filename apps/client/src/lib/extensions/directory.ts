/**
 * The Extension Directory in the browser (ADR 0123): its list, as the Client's server read it, and
 * putting a release on this device, staging a newer one, and taking one away.
 *
 * Fetching a release asks the Client's server for its package.json at the release's own address
 * (`/extensions/<id>/<key>/`). That request is what makes the server fetch the release from the
 * package registry and check it against the hash the directory lists, so a release that fails the
 * check is never installed: its message is what the person is told. The package is then read and
 * checked as a built-in is (`admitInstalled`), kept on the device, and started in the open graph.
 *
 * Installing and removing are the person's, so they also go into the person's settings, which
 * follow them to their other devices (installed-sync.ts). What the device does to keep in step with
 * those settings (`installRelease`, `stageRelease`, `removeFromDevice`) touches this device alone.
 */
import { extensionDataKey, type PersonSettings } from '$lib/person-settings/person-settings'

import { admitInstalled, type Catalogue } from './catalogue'
import { type DirectoryExtension, type DirectoryListing, type DirectoryRelease, releaseBase } from './directory-format'
import type { ExtensionHost } from './host'
import type { InstalledExtensions, ReleaseRecord } from './installed'
import { INSTALLED_SETTING_VALUE, installedSettingKey } from './installed-sync'

export type DirectoryState = { state: 'off' } | { state: 'ok'; listing: DirectoryListing } | { state: 'unavailable'; error: string }

export interface ExtensionDirectory {
    readonly clientVersion: string
    /** The list as the Client's server last read it. */
    load(signal?: AbortSignal): Promise<DirectoryState>
    /** The person installs a listed release: on this device, and in their settings. Throws, saying why, when it cannot. */
    install(extension: DirectoryExtension, release: DirectoryRelease): Promise<void>
    /**
     * The person removes an extension: from this device with what it kept, from their settings, and
     * with the records it kept with them (ADR 0140), which every device of theirs then clears.
     */
    remove(id: string): void
    /** Put a listed release on this device and start it, in place of any other release of it. */
    installRelease(extension: DirectoryExtension, release: DirectoryRelease): Promise<void>
    /** Fetch and check a newer release of an installed extension, to run from the Client's next start. */
    stageRelease(extension: DirectoryExtension, release: DirectoryRelease): Promise<void>
    /** Stop an extension and take it off this device, and with `clearStorage` what it kept here. */
    removeFromDevice(id: string, options: { clearStorage: boolean }): void
}

export interface ExtensionDirectoryOptions {
    host: ExtensionHost
    installed: InstalledExtensions
    /** The person's settings, where the extensions they installed, and the records they keep, are kept. */
    settings: Pick<PersonSettings, 'keys' | 'set'>
    clientVersion: string
    fetch?: typeof fetch
    /** Where installed extensions keep their values (`etherpk-<id>:<key>`), cleared on removal. */
    storage?: Storage
    now?: () => number
}

/** The message a refusing response carries (`{ message }`), or its status. */
async function refusal(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { message?: unknown }
        if (typeof body.message === 'string' && body.message !== '') return body.message
    } catch {
        // Not JSON: say what the status says.
    }
    return `the Client's server answered ${response.status}.`
}

export function createExtensionDirectory(options: ExtensionDirectoryOptions): ExtensionDirectory {
    const { host, installed, clientVersion, settings } = options
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
    const now = options.now ?? Date.now

    /** A listed release's package.json from the Client's server, read and checked as this Client would run it. */
    async function fetchRelease(extension: DirectoryExtension, release: DirectoryRelease) {
        const base = releaseBase(extension.id, release.integrity)
        let response: Response
        try {
            response = await fetcher(`${base}package.json`, { cache: 'no-cache' })
        } catch {
            throw new Error("The Client's server could not be reached. Check your connection and try again.")
        }
        if (!response.ok) throw new Error(await refusal(response))
        let packageJson: unknown
        try {
            packageJson = await response.json()
        } catch {
            throw new Error('Its package.json could not be read.')
        }
        const record: ReleaseRecord & { id: string } = { id: extension.id, version: release.version, integrity: release.integrity, packageJson }
        const current = host.catalogue.extensions.find((entry) => entry.id === extension.id)
        if (current && !current.installed) throw new Error(`An extension that comes with EtherPK has the id "${extension.id}".`)
        // An update is checked against the other extensions, as the release it replaces would be.
        const others: Catalogue = { extensions: host.catalogue.extensions.filter((entry) => entry.id !== extension.id), broken: [] }
        const admitted = admitInstalled(others, { ...record, base }, clientVersion)
        if (!admitted.ok) throw new Error(admitted.errors.join(' '))
        return { record, entry: admitted.entry, current }
    }

    function clearStorageOf(id: string) {
        const storage = options.storage
        if (!storage) return
        try {
            const keys: string[] = []
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i)
                if (key?.startsWith(`etherpk-${id}:`)) keys.push(key)
            }
            for (const key of keys) storage.removeItem(key)
        } catch {
            // A browser refusing storage has nothing of it to clear.
        }
    }

    const directory: ExtensionDirectory = {
        clientVersion,
        async load(signal) {
            const response = await fetcher('/api/extensions/directory', { signal, cache: 'no-store' })
            if (!response.ok) return { state: 'unavailable', error: await refusal(response) }
            return (await response.json()) as DirectoryState
        },
        async install(extension, release) {
            await directory.installRelease(extension, release)
            // After it is on the device, so keeping in step finds nothing left to do.
            settings.set(installedSettingKey(extension.id), INSTALLED_SETTING_VALUE)
        },
        remove(id) {
            directory.removeFromDevice(id, { clearStorage: true })
            settings.set(installedSettingKey(id), null)
            // What it kept with the person, such as a sign-in to another service: no use to anyone
            // once it is gone. The person's answers to its settings stay, for a reinstall.
            for (const key of settings.keys(extensionDataKey(id, ''))) settings.set(key, null)
        },
        async installRelease(extension, release) {
            const { record, entry, current } = await fetchRelease(extension, release)
            const before = installed.list().find((kept) => kept.id === extension.id)
            if (current) host.remove(extension.id)
            installed.put({ ...record, ...(before && before.integrity !== record.integrity ? { updatedAt: now() } : {}) })
            await host.add(entry)
        },
        async stageRelease(extension, release) {
            const { record } = await fetchRelease(extension, release)
            installed.stage(extension.id, { version: record.version, integrity: record.integrity, packageJson: record.packageJson })
        },
        removeFromDevice(id, { clearStorage }) {
            host.remove(id)
            installed.remove(id)
            if (clearStorage) clearStorageOf(id)
        },
    }
    return directory
}
