import fc from 'fast-check'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '@appsoftwareltd/etherpk-native-bridge'
import { publicKeyFromSeed, type Release, signFeed } from './feed.ts'
import { installedAs, installerFor, replaceExecutable } from './installers.ts'
import { AppUpdates, CHECK_FAILED, DOWNLOAD_FAILED, INSTALL_FAILED, type Installer, INSTALLER_NOT_STARTED, InstallerNotStarted } from './updates.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-updates-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const seed = Buffer.alloc(32, 9)
const file = Buffer.from('the new app')
const release: Release = {
    version: '1.1.0', url: 'https://downloads.example/EtherPK.AppImage', sha512: createHash('sha512').update(file).digest('hex'),
    size: file.length, minimumVersion: '0.9.0', page: 'https://downloads.example/',
}

function world({ sequence = 5, served = file as Buffer, over = {} as Partial<Release>, installs = true, keys = [{ id: 'k', publicKey: publicKeyFromSeed(seed) }], installer }: {
    sequence?: number; served?: Buffer; over?: Partial<Release>; installs?: boolean; keys?: { id: string; publicKey: string }[]; installer?: Installer | null
} = {}) {
    const state = { sequence, served, over, offline: false, asked: [] as string[], installed: [] as string[], statuses: [] as UpdateStatus[], closes: true, logged: [] as string[] }
    const updates = new AppUpdates({
        feedUrl: 'https://downloads.example/stable.json', keys, channel: 'stable', current: '1.0.0', dir: join(dir, 'updates'),
        installer: installer === undefined ? { platform: 'linux-x64-appimage', installs, install: async (path) => { state.installed.push(await readFile(path, 'utf8')); return state.closes } } : installer,
        fetch: async (url) => {
            state.asked.push(url)
            if (state.offline) throw new TypeError('fetch failed')
            if (url.endsWith('.json')) {
                const payload = { schema: 1, sequence: state.sequence, expires: '2099-01-01T00:00:00.000Z', channels: { stable: { 'linux-x64-appimage': { ...release, ...state.over } } } }
                return new Response(signFeed(Buffer.from(JSON.stringify(payload)), [{ id: 'k', seed }]))
            }
            return new Response(new Uint8Array(state.served))
        },
        changed: (status) => state.statuses.push(status),
        log: (message) => { state.logged.push(message) },
    })
    return { updates, state }
}

describe('updates', () => {
    it('are off with no key, no feed or no known installation, and ask nobody', async () => {
        for (const parts of [{ keys: [] }, { installer: null }]) {
            const { updates, state } = world(parts)
            expect(await updates.check()).toEqual({ state: 'off' })
            expect(state.asked).toEqual([])
        }
    })
    it('offer, fetch and install a newer version, in two steps the person takes', async () => {
        const { updates, state } = world()
        expect(await updates.check()).toEqual({ state: 'available', version: '1.1.0', install: true, required: false, page: release.page })
        await updates.install()
        expect(updates.status()).toEqual({ state: 'ready', version: '1.1.0' })
        expect(state.installed).toEqual([])
        await updates.install()
        expect(state.installed).toEqual(['the new app'])
    })
    it('say when the version running is too old', async () => {
        expect(await world({ over: { minimumVersion: '1.0.1' } }).updates.check()).toMatchObject({ required: true })
    })
    it('offer nothing for the version running', async () => {
        expect(await world({ over: { version: '1.0.0' } }).updates.check()).toEqual({ state: 'idle' })
    })
    it('refuse a file that is not the one signed for, and leave none of it', async () => {
        for (const served of [Buffer.from('the bad app'), Buffer.from('the new app and more'), Buffer.from('the')]) {
            const { updates, state } = world({ served })
            await updates.check()
            await updates.install()
            expect(updates.status()).toEqual({ state: 'failed', message: DOWNLOAD_FAILED })
            expect(await readdir(join(dir, 'updates'))).toEqual([])
            expect(state.installed).toEqual([])
        }
    })
    it('refuse a file that changed after it was fetched', async () => {
        const { updates, state } = world()
        await updates.check()
        await updates.install()
        const [name] = await readdir(join(dir, 'updates'))
        await writeFile(join(dir, 'updates', name), 'the BAD app')
        await updates.install()
        expect(state.installed).toEqual([])
        expect(updates.status()).toEqual({ state: 'failed', message: INSTALL_FAILED })
    })
    it('never take an older feed, a restart later either', async () => {
        await world({ sequence: 9 }).updates.check()
        const { updates } = world({ sequence: 8 })
        expect(await updates.check()).toEqual({ state: 'failed', message: CHECK_FAILED })
    })
    it('keep what is on offer when a later look fails', async () => {
        const { updates, state } = world()
        await updates.check()
        state.offline = true
        expect(await updates.check()).toMatchObject({ state: 'available' })
    })
    it('can be tried again after a failure', async () => {
        const { updates, state } = world()
        state.offline = true
        expect(await updates.check()).toMatchObject({ state: 'failed' })
        state.offline = false
        expect(await updates.check()).toMatchObject({ state: 'available' })
        state.offline = true
        await updates.install()
        expect(updates.status()).toMatchObject({ state: 'failed' })
        state.offline = false
        await updates.install()
        expect(updates.status()).toMatchObject({ state: 'ready' })
    })
    it('fetch once when asked twice at once', async () => {
        const { updates, state } = world()
        await Promise.all([updates.check(), updates.check()])
        await Promise.all([updates.install(), updates.install()])
        expect(state.asked).toHaveLength(2)
    })
    it('send the person to the page where they install it', async () => {
        const { updates } = world({ installs: false })
        expect(await updates.check()).toMatchObject({ install: false })
        await expect(updates.install()).rejects.toMatchObject({ failure: 'NotSupportedError' })
    })
    it('install once when asked twice at once', async () => {
        const { updates, state } = world()
        await updates.check()
        await updates.install()
        await Promise.all([updates.install(), updates.install()])
        expect(state.installed).toEqual(['the new app'])
    })
    it('say so when the installer did not start, and can be tried again', async () => {
        const { updates } = world({ installer: { platform: 'linux-x64-appimage', installs: true, install: async () => { throw new InstallerNotStarted('stopped') } } })
        await updates.check()
        await updates.install()
        await updates.install()
        expect(updates.status()).toEqual({ state: 'failed', message: INSTALLER_NOT_STARTED })
        await updates.install()
        expect(updates.status()).toMatchObject({ state: 'ready' })
    })
    it('offer nothing from the first feed after the highest sequence was lost, and say so in the log', async () => {
        for (const kept of ['{"sequence": "nine"}', 'not json', '{"sequence": -1}']) {
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, 'update-sequence.json'), kept)
            const { updates, state } = world({ sequence: 3 })
            expect(await updates.check()).toEqual({ state: 'idle' })
            expect(state.logged).toContain('The highest update sequence is not readable.')
            expect(JSON.parse(await readFile(join(dir, 'update-sequence.json'), 'utf8'))).toEqual({ sequence: 3 })
            expect(await updates.check()).toMatchObject({ state: 'available' })
            expect(await world({ sequence: 2 }).updates.check()).toEqual({ state: 'failed', message: CHECK_FAILED })
        }
    })
    it('stay ready when a window would not close', async () => {
        const { updates, state } = world()
        state.closes = false
        await updates.check()
        await updates.install()
        await updates.install()
        expect(updates.status()).toMatchObject({ state: 'ready' })
    })
})

describe('installers', () => {
    it('know how the app was installed', () => {
        expect(installedAs({}, 'win32', 'x64', 'C:\\x', true)).toBe('windows-x64')
        expect(installedAs({ APPIMAGE: '/a' }, 'linux', 'x64', '/tmp/.mount/etherpk', true)).toBe('linux-x64-appimage')
        expect(installedAs({}, 'linux', 'x64', '/opt/EtherPK/etherpk', true)).toBe('linux-x64-deb')
        expect(installedAs({}, 'linux', 'x64', '/home/someone/etherpk', true)).toBe(null)
        expect(installedAs({ APPIMAGE: '/a' }, 'linux', 'x64', '/x', false)).toBe(null)
        expect(installedAs({}, 'linux', 'arm64', '/opt/EtherPK/etherpk', true)).toBe(null)
        // The Nix package runs the .deb's files from the store, which only Nix changes, so no update is offered.
        expect(installedAs({}, 'linux', 'x64', '/nix/store/0000-etherpk-1.0.1/lib/etherpk/etherpk', true)).toBe(null)
        // nixpkgs' AppImage wrapper exports APPIMAGE empty.
        expect(installedAs({ APPIMAGE: '' }, 'linux', 'x64', '/nix/store/0000-etherpk-1.0.1/etherpk', true)).toBe(null)
    })
    it('property: a Linux copy that is no AppImage and not in /opt/EtherPK is offered no updates', () => {
        const path = fc.oneof(
            fc.constantFrom('/nix/store/0000-etherpk/lib/etherpk/etherpk', '/opt/EtherPKX/etherpk', '/opt/etherpk/etherpk', '/usr/lib/etherpk/etherpk', 'opt/EtherPK/etherpk'),
            fc.array(fc.string({ minLength: 1 }), { maxLength: 4 }).map((parts) => `/${parts.join('/')}`),
            fc.string(),
        )
        fc.assert(fc.property(path, fc.constantFrom(undefined, ''), (executable, appImage) => {
            fc.pre(!executable.startsWith('/opt/EtherPK/'))
            const env = appImage === undefined ? {} : { APPIMAGE: appImage }
            expect(installedAs(env, 'linux', 'x64', executable, true)).toBe(null)
        }), { seed: 20261127, numRuns: Number(process.env.UPDATE_FUZZ_RUNS ?? 300) })
    })
    it('replace an AppImage whole, executable, and start the new one', async () => {
        const [source, target] = [join(dir, 'new.bin'), join(dir, 'Apps', 'EtherPK.AppImage')]
        await mkdir(join(dir, 'Apps'))
        await writeFile(source, 'new')
        await writeFile(target, 'old')
        const did: string[] = []
        const installer = await installerFor('linux-x64-appimage', { APPIMAGE: target }, { closeAll: async () => { did.push('close'); return true }, reopen: () => did.push('reopen'), quit: () => did.push('quit'), relaunch: (path) => did.push(path) })
        expect(await installer.install(source)).toBe(true)
        expect(await readFile(target, 'utf8')).toBe('new')
        if (process.platform !== 'win32') expect((await stat(target)).mode & 0o111).toBe(0o111)
        expect(await readdir(join(dir, 'Apps'))).toEqual(['EtherPK.AppImage'])
        expect(did).toEqual(['close', target, 'quit'])
    })
    for (const outcome of ['spawn', 'error'] as const) {
        it(`on Windows, quit only once the installer is running (${outcome})`, async () => {
            const did: string[] = []
            const life = { closeAll: async () => { did.push('close'); return true }, reopen: () => did.push('reopen'), quit: () => did.push('quit'), relaunch: () => did.push('relaunch') }
            const spawner = () => {
                const child = Object.assign(new EventEmitter(), { unref: () => did.push('unref') }) as unknown as ChildProcess
                setTimeout(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', Object.assign(new Error('blocked'), { code: 'EACCES' }))), 0)
                return child
            }
            const installer = await installerFor('windows-x64', {}, life, spawner)
            if (outcome === 'spawn') {
                expect(await installer.install('C:\\EtherPK.exe')).toBe(true)
                expect(did).toEqual(['close', 'unref', 'quit'])
            } else {
                await expect(installer.install('C:\\EtherPK.exe')).rejects.toBeInstanceOf(InstallerNotStarted)
                expect(did).toEqual(['close', 'reopen'])
            }
        })
    }
    it('leave the old file when the new one cannot be copied', async () => {
        await writeFile(join(dir, 'EtherPK.AppImage'), 'old')
        await expect(replaceExecutable(join(dir, 'missing'), join(dir, 'EtherPK.AppImage'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readdir(dir)).toEqual(['EtherPK.AppImage'])
    })
})
