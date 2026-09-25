import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultConfigPath, listLogins, parseConfig, readConfig, selectServer, serialiseConfig, writeConfig, type HeadlessConfig } from './config'

const dirs: string[] = []
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-'))
    dirs.push(dir)
    return dir
}

const two: HeadlessConfig = {
    servers: {
        'https://sync.example.com': { pat: 'pat_a', vaultKey: 'k_a' },
        'https://sync.private.example': { pat: 'pat_b' },
    },
}

describe('the config file', () => {
    it('lives under the user config directory unless overridden', () => {
        expect(defaultConfigPath({ HOME: '/home/x' } as NodeJS.ProcessEnv).endsWith('/etherpk/mcp.json')).toBe(true)
        expect(defaultConfigPath({ XDG_CONFIG_HOME: '/cfg' } as NodeJS.ProcessEnv)).toBe('/cfg/etherpk/mcp.json')
        expect(defaultConfigPath({ ETHERPK_MCP_CONFIG: '/tmp/x.json' } as NodeJS.ProcessEnv)).toBe('/tmp/x.json')
    })

    it('round-trips several logins, strips trailing slashes from keys and drops an empty vault key', () => {
        expect(parseConfig(serialiseConfig(two))).toEqual(two)
        expect(parseConfig('{"servers":{"https://s/":{"pat":"p","vaultKey":""}}}')).toEqual({ servers: { 'https://s': { pat: 'p' } } })
    })

    it('refuses a file it cannot trust rather than half-reading it', () => {
        expect(parseConfig('not json')).toBeNull()
        expect(parseConfig('[]')).toBeNull()
        expect(parseConfig('{"servers":{"https://s":{}}}')).toBeNull()
        expect(parseConfig('{"servers":{"ftp://s":{"pat":"p"}}}')).toBeNull()
        expect(parseConfig('{"servers":[]}')).toBeNull()
    })

    it('is written owner-only, read back, and absent reads as no logins', async () => {
        const path = join(await scratch(), 'nested', 'mcp.json')
        expect(await readConfig(path)).toEqual({ servers: {} })
        await writeConfig(path, two)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect(await readConfig(path)).toEqual(two)
        expect(await readFile(path, 'utf8')).toContain('"vaultKey"')
    })
})

describe('choosing the server a command means', () => {
    it('is the only login when there is one and none is named', () => {
        const one: HeadlessConfig = { servers: { 'https://sync.example.com': { pat: 'p', vaultKey: 'k' } } }
        expect(selectServer(one)).toEqual({ ok: true, credentials: { syncServer: 'https://sync.example.com', pat: 'p', vaultKey: 'k' } })
    })

    it('is the named login, however the name is spelled at the end', () => {
        expect(selectServer(two, 'https://sync.private.example/')).toEqual({
            ok: true,
            credentials: { syncServer: 'https://sync.private.example', pat: 'pat_b' },
        })
    })

    it('refuses to guess between two logins, and says which exist', () => {
        expect(selectServer(two)).toEqual({ ok: false, reason: 'ambiguous', known: ['https://sync.example.com', 'https://sync.private.example'] })
    })

    it('says so when nothing is signed in, or the named server is not', () => {
        expect(selectServer({ servers: {} })).toEqual({ ok: false, reason: 'none' })
        expect(selectServer(two, 'https://elsewhere.example')).toEqual({
            ok: false,
            reason: 'unknown',
            syncServer: 'https://elsewhere.example',
            known: ['https://sync.example.com', 'https://sync.private.example'],
        })
    })

    it('lists logins with their server attached', () => {
        expect(listLogins(two).map((login) => login.syncServer)).toEqual(['https://sync.example.com', 'https://sync.private.example'])
    })
})

describe('the pre-0.3.0 config shape', () => {
    it('reads as one login under its server, so an older registration keeps serving', async () => {
        const { parseConfig } = await import('./config')
        const legacy = JSON.stringify({ syncServer: 'https://sync.example.test/', pat: 'pat-1', vaultKey: 'vk' })
        expect(parseConfig(legacy)).toEqual({ servers: { 'https://sync.example.test': { pat: 'pat-1', vaultKey: 'vk' } } })
        expect(parseConfig(JSON.stringify({ syncServer: 'https://sync.example.test', pat: 'pat-1' }))).toEqual({ servers: { 'https://sync.example.test': { pat: 'pat-1' } } })
        expect(parseConfig(JSON.stringify({ syncServer: 'ftp://x', pat: 'p' }))).toBeNull()
    })
})
