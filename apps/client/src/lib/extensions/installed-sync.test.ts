import { describe, expect, it, vi } from 'vitest'

import { createPersonSettings } from '$lib/person-settings/person-settings'

import type { DirectoryState } from './directory'
import type { DirectoryExtension, DirectoryListing, DirectoryRelease } from './directory-format'
import type { InstalledRelease } from './installed'
import { createInstalledSync, installedSettingKey, planInstalled } from './installed-sync'
import { memoryStorage } from './testing'

// What a device does with the extensions a person installed (ADR 0123, amended 2026-10-12): the
// list follows the person, and each device runs the newest listed release its Client can run.

const integrity = (letter: string) => `sha512-${letter.repeat(86)}==`
const release = (version: string, letter: string, minClientVersion = '0.9.0'): DirectoryRelease => ({ version, integrity: integrity(letter), minClientVersion })

function extension(id: string, releases: DirectoryRelease[]): DirectoryExtension {
    return { id, displayName: id, publisher: 'example', description: '', repository: `https://example.com/${id}`, license: 'MIT', package: `@example/${id}`, releases }
}

const listing = (...extensions: DirectoryExtension[]): DirectoryListing => ({ version: 1, extensions })
const onDevice = (id: string, version: string, letter: string, next?: { version: string; letter: string }): InstalledRelease => ({
    id,
    version,
    integrity: integrity(letter),
    packageJson: {},
    ...(next ? { next: { version: next.version, integrity: integrity(next.letter), packageJson: {} } } : {}),
})

const plan = (input: Partial<Parameters<typeof planInstalled>[0]>) =>
    planInstalled({ intended: [], device: [], listing: null, clientVersion: '0.9.7', builtIns: [], ...input })

const ids = (items: { extension: DirectoryExtension; release: DirectoryRelease }[]) => items.map((item) => `${item.extension.id}@${item.release.version}`)

describe('the extensions a person installed, on one device', () => {
    it('installs one the person installed elsewhere, at the newest release this Client can run', () => {
        const orchard = extension('orchard', [release('1.2.0', 'C', '0.9.9'), release('1.1.0', 'B'), release('1.0.0', 'A')])
        expect(ids(plan({ intended: ['orchard'], listing: listing(orchard) }).install)).toEqual(['orchard@1.1.0'])
    })

    it('removes one the person removed, or that left with their account', () => {
        const result = plan({ intended: [], device: [onDevice('orchard', '1.0.0', 'A')], listing: listing(extension('orchard', [release('1.0.0', 'A')])) })
        expect(result.remove).toEqual(['orchard'])
        // Whether the directory can be read or not.
        expect(plan({ intended: [], device: [onDevice('orchard', '1.0.0', 'A')], listing: null }).remove).toEqual(['orchard'])
    })

    it('leaves one alone that runs the newest release it can', () => {
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.1.0', 'B')], listing: listing(extension('orchard', [release('1.1.0', 'B'), release('1.0.0', 'A')])) })
        expect(result).toMatchObject({ install: [], replace: [], stage: [], withdraw: [], remove: [], waiting: [], unlisted: [] })
    })
})

describe('updating', () => {
    it('stages a newer listed release, to take effect when the Client next starts', () => {
        const orchard = extension('orchard', [release('1.1.0', 'B'), release('1.0.0', 'A')])
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'A')], listing: listing(orchard) })
        expect(ids(result.stage)).toEqual(['orchard@1.1.0'])
        expect(result.replace).toEqual([])
    })

    it('stages it once', () => {
        const orchard = extension('orchard', [release('1.1.0', 'B'), release('1.0.0', 'A')])
        expect(plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'A', { version: '1.1.0', letter: 'B' })], listing: listing(orchard) }).stage).toEqual([])
    })

    it('replaces a withdrawn release at once with the newest listed one this Client can run', () => {
        const orchard = extension('orchard', [release('1.0.1', 'D'), release('1.0.0', 'A')])
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'X')], listing: listing(orchard) })
        expect(ids(result.replace)).toEqual(['orchard@1.0.1'])
        expect(result.stage).toEqual([])
    })

    it('waits for a newer Client when the newest release needs one, and says which', () => {
        const orchard = extension('orchard', [release('1.3.0', 'C', '0.9.8'), release('1.0.0', 'A')])
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'A')], listing: listing(orchard) })
        expect(result.stage).toEqual([])
        expect(result.waiting).toEqual([{ id: 'orchard', version: '1.3.0', needs: '0.9.8' }])
    })

    it('stops a withdrawn release that nothing listed can replace here, and says what the fix needs', () => {
        const orchard = extension('orchard', [release('1.3.0', 'C', '0.9.8')])
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'X')], listing: listing(orchard) })
        expect(result.withdraw).toEqual(['orchard'])
        expect(result.waiting).toEqual([{ id: 'orchard', version: '1.3.0', needs: '0.9.8' }])
    })

    it('stops one the directory no longer lists at all', () => {
        const result = plan({ intended: ['orchard'], device: [onDevice('orchard', '1.0.0', 'A')], listing: listing() })
        expect(result.withdraw).toEqual(['orchard'])
        expect(result.unlisted).toEqual(['orchard'])
    })
})

describe('what a device cannot know or do', () => {
    it('installs, updates and stops nothing while the directory cannot be read', () => {
        const result = plan({ intended: ['orchard', 'pear'], device: [onDevice('orchard', '1.0.0', 'A')], listing: null })
        expect(result).toMatchObject({ install: [], replace: [], stage: [], withdraw: [], remove: [], waiting: [], unlisted: [] })
    })

    it('says so of one the person installed that the directory does not list, or that needs a newer Client', () => {
        const pear = extension('pear', [release('2.0.0', 'P', '0.9.9')])
        const result = plan({ intended: ['orchard', 'pear'], listing: listing(pear) })
        expect(result.unlisted).toEqual(['orchard'])
        expect(result.waiting).toEqual([{ id: 'pear', version: '2.0.0', needs: '0.9.9' }])
        expect(result.install).toEqual([])
    })

    it('never takes an id one of the Client’s own extensions has', () => {
        const kanban = extension('kanban', [release('1.0.0', 'K')])
        expect(plan({ intended: ['kanban'], listing: listing(kanban), builtIns: ['kanban'] }).install).toEqual([])
    })
})

describe('keeping a device in step', () => {
    const orchard = extension('orchard', [release('1.1.0', 'B'), release('1.0.0', 'A')])
    const pear = extension('pear', [release('2.0.0', 'P')])

    function setUp(options: { state?: DirectoryState; device?: InstalledRelease[]; installs?: string[]; failing?: string } = {}) {
        const storage = memoryStorage()
        const settings = createPersonSettings(() => storage)
        for (const id of options.installs ?? []) settings.set(installedSettingKey(id), 'installed')
        const device = [...(options.device ?? [])]
        const calls: string[] = []
        const directory = {
            load: vi.fn(async (): Promise<DirectoryState> => options.state ?? { state: 'ok', listing: listing(orchard, pear) }),
            installRelease: vi.fn(async (chosen: DirectoryExtension, version: DirectoryRelease) => {
                if (chosen.id === options.failing) throw new Error('The Client’s server could not be reached.')
                calls.push(`install ${chosen.id}@${version.version}`)
                const at = device.findIndex((kept) => kept.id === chosen.id)
                device.splice(at === -1 ? device.length : at, at === -1 ? 0 : 1, { id: chosen.id, version: version.version, integrity: version.integrity, packageJson: {} })
            }),
            stageRelease: vi.fn(async (chosen: DirectoryExtension, version: DirectoryRelease) => void calls.push(`stage ${chosen.id}@${version.version}`)),
            removeFromDevice: vi.fn((id: string, { clearStorage }: { clearStorage: boolean }) => void calls.push(`${clearStorage ? 'remove' : 'stop'} ${id}`)),
        }
        const notify = vi.fn()
        const timers: (() => void)[] = []
        const sync = createInstalledSync({
            directory,
            installed: { list: () => device },
            settings,
            clientVersion: '0.9.7',
            builtIns: [],
            notify,
            setInterval: (run) => timers.push(run),
            clearInterval: () => {},
        })
        return { sync, settings, directory, calls, notify, timers }
    }

    it('installs what the person installed elsewhere, and says so once', async () => {
        const { sync, calls, notify } = setUp({ installs: ['orchard', 'pear'] })
        await sync.run()
        expect(calls).toEqual(['install orchard@1.1.0', 'install pear@2.0.0'])
        expect(notify).toHaveBeenCalledExactlyOnceWith('Installed from your account: orchard and pear.')
    })

    it('removes what is no longer the person’s with what it kept, and stops a withdrawn release keeping it', async () => {
        const withdrawn = { state: 'ok' as const, listing: listing(orchard, extension('pear', [release('2.0.0', 'P', '0.9.9')])) }
        const { sync, calls, notify } = setUp({ installs: ['pear'], device: [onDevice('orchard', '1.0.0', 'A'), onDevice('pear', '1.0.0', 'X')], state: withdrawn })
        await sync.run()
        expect(calls).toEqual(['remove orchard', 'stop pear'])
        expect(sync.reports()).toEqual({ pear: { withdrawn: true, waiting: { version: '2.0.0', needs: '0.9.9' } } })
        expect(notify).not.toHaveBeenCalled()
    })

    it('replaces a withdrawn release and stages a newer one, announcing neither', async () => {
        const { sync, calls, notify } = setUp({ installs: ['orchard', 'pear'], device: [onDevice('orchard', '1.0.0', 'A'), onDevice('pear', '1.0.0', 'X')] })
        await sync.run()
        expect(calls).toEqual(['install pear@2.0.0', 'stage orchard@1.1.0'])
        expect(notify).not.toHaveBeenCalled()
    })

    it('says which release runs from the next start, and when the running one was updated', async () => {
        const staged = { ...onDevice('orchard', '1.0.0', 'A', { version: '1.1.0', letter: 'B' }), updatedAt: 7_000 }
        const { sync } = setUp({ installs: ['orchard'], device: [staged] })
        await sync.run()
        expect(sync.reports()).toEqual({ orchard: { staged: '1.1.0', updatedAt: 7_000 } })
    })

    it('says why an install failed, and tries again on the next run', async () => {
        const { sync, calls } = setUp({ installs: ['orchard', 'pear'], failing: 'pear' })
        await sync.run()
        expect(calls).toEqual(['install orchard@1.1.0'])
        expect(sync.reports()).toEqual({ pear: { failure: 'The Client’s server could not be reached.' } })
    })

    it('runs as it starts, when the person’s extensions change and every hour, and never two at once', async () => {
        const { sync, settings, directory, calls, timers } = setUp()
        const stop = sync.start()
        // Another setting changing is not a reason to run.
        settings.set('extension.orchard.theme', 'dark')
        // Two changes while the first run is under way: one more run follows it, seeing both.
        settings.set(installedSettingKey('orchard'), 'installed')
        settings.set(installedSettingKey('pear'), 'installed')
        await vi.waitFor(() => expect(directory.load).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(calls).toEqual(['install orchard@1.1.0', 'install pear@2.0.0']))
        timers[0]()
        await vi.waitFor(() => expect(directory.load).toHaveBeenCalledTimes(3))
        stop()
        settings.set(installedSettingKey('orchard'), null)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(directory.load).toHaveBeenCalledTimes(3)
    })
})
