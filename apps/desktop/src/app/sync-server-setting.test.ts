import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COPY } from '../copy.ts'
import { readSyncServerSetting, SYNC_SERVER_VARIABLE, type SyncServerProblem, syncServerProblemDetail } from './sync-server-setting.ts'

let dir: string
let file: string
let logged: string[]
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'etherpk-settings-'))
    file = join(dir, 'settings.json')
    logged = []
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const read = (env: Record<string, string | undefined> = {}) => readSyncServerSetting({ env, file, log: (message) => { logged.push(message) } })

describe('the Sync Server a person sets for the desktop app', () => {
    it('is none, and no fault, when neither the variable nor the file is there', async () => {
        expect(await read()).toEqual({ server: null, problem: null })
        expect(logged).toEqual([])
    })

    it('is read from the settings file, as an origin', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://sync.example.test/' }))
        expect(await read()).toEqual({ server: 'https://sync.example.test', problem: null })
    })

    it('is taken from the environment before the file', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://file.example.test' }))
        expect(await read({ [SYNC_SERVER_VARIABLE]: 'https://env.example.test' })).toEqual({ server: 'https://env.example.test', problem: null })
    })

    it('falls back to the file when the variable is set to nothing', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://file.example.test' }))
        expect((await read({ [SYNC_SERVER_VARIABLE]: '  ' })).server).toBe('https://file.example.test')
    })

    it('is none from a file that sets something else', async () => {
        await writeFile(file, JSON.stringify({}))
        expect(await read()).toEqual({ server: null, problem: null })
    })

    it('is refused, with where it came from, when the variable is not a Sync Server address', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://file.example.test' }))
        const setting = await read({ [SYNC_SERVER_VARIABLE]: 'http://sync.example.test' })
        // A wrong value in the variable is not quietly replaced by the file's: the person meant the variable.
        expect(setting).toEqual({ server: null, problem: { kind: 'not-a-server', from: 'environment', value: 'http://sync.example.test' } })
        expect(logged.join('\n')).toContain('http://sync.example.test')
    })

    it('is refused when the file holds an address that is not one', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://sync.example.test/sync' }))
        expect(await read()).toEqual({ server: null, problem: { kind: 'not-a-server', from: 'file', value: 'https://sync.example.test/sync', file } })
    })

    it('is refused when the file\'s value is not text', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 42 }))
        expect(await read()).toEqual({ server: null, problem: { kind: 'not-a-server', from: 'file', value: '42', file } })
    })

    it('is refused when the file is not JSON, or not an object', async () => {
        await writeFile(file, '{ "syncServer": ')
        expect(await read()).toEqual({ server: null, problem: { kind: 'not-json', from: 'file', file } })
        expect(logged).toHaveLength(1)
        await writeFile(file, '["https://sync.example.test"]')
        expect((await read()).problem).toEqual({ kind: 'not-json', from: 'file', file })
    })

    it('is refused when the file is there and cannot be read', async () => {
        if (process.getuid?.() === 0) return
        await writeFile(file, JSON.stringify({ syncServer: 'https://sync.example.test' }))
        await chmod(file, 0o000)
        expect((await read()).problem).toEqual({ kind: 'unreadable', from: 'file', file })
    })

    it('leaves other keys alone, and logs them once', async () => {
        await writeFile(file, JSON.stringify({ syncServer: 'https://sync.example.test', theme: 'dark', zoom: 2 }))
        expect((await read()).server).toBe('https://sync.example.test')
        expect(logged).toHaveLength(1)
        expect(logged[0]).toContain('theme, zoom')
    })
})

describe('what the person is told of a setting that was not used', () => {
    const managed = (problem: SyncServerProblem) => syncServerProblemDetail(problem, true)

    it('names the value, where it came from, what EtherPK did instead and how to correct it', () => {
        const fromEnv = managed({ kind: 'not-a-server', from: 'environment', value: 'http://sync.example.test' })
        expect(fromEnv).toContain(SYNC_SERVER_VARIABLE)
        expect(fromEnv).toContain('http://sync.example.test')
        expect(fromEnv).toContain('Managed Sync')
        expect(fromEnv).toContain('https://')
        const fromFile = managed({ kind: 'not-a-server', from: 'file', value: 'sync', file: '/home/person/.config/EtherPK/settings.json' })
        expect(fromFile).toContain('/home/person/.config/EtherPK/settings.json')
        expect(fromFile).toContain('syncServer')
        expect(managed({ kind: 'not-json', from: 'file', file: 'C:\\settings.json' })).toContain('C:\\settings.json')
        expect(managed({ kind: 'unreadable', from: 'file', file: 'C:\\settings.json' })).toContain('C:\\settings.json')
    })

    it('says no managed server where the app was built without one', () => {
        expect(syncServerProblemDetail({ kind: 'not-json', from: 'file', file: 'x' }, false)).not.toContain('Managed Sync')
    })

    it('has a title of its own', () => {
        expect(COPY.syncServerNotUsedTitle).toMatch(/Sync Server/)
    })
})
