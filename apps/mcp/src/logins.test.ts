import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readConfig, writeConfig, type HeadlessConfig } from './config'
import { forgetLoginSecrets, loginCredentials, saveLogin, upgradeToAgentToken } from './logins'
import { SecretStoreError, type LoginSecrets, type SecretStore } from './secret-store'

const SERVER = 'https://sync.example.com'
const STANDARD = `epk_pat_${'A'.repeat(43)}`
const AGENT = `epk_agt_${'B'.repeat(43)}`
const VAULT_KEY = 'V'.repeat(43)

const dirs: string[] = []
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function configPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-logins-'))
    dirs.push(dir)
    return join(dir, 'mcp.json')
}

/** A keychain in memory; `broken` makes every call fail as an unreachable keyring does. */
function memoryKeychain(opts: { broken?: boolean; garbles?: boolean } = {}): SecretStore & { items: Map<string, LoginSecrets> } {
    const items = new Map<string, LoginSecrets>()
    const fail = () => {
        throw new SecretStoreError('the test keychain is not available here.')
    }
    return {
        description: 'the test keychain',
        items,
        async read(syncServer) {
            if (opts.broken) fail()
            const held = items.get(syncServer) ?? null
            return held && opts.garbles ? { token: 'garbled' } : held
        },
        async write(syncServer, secrets) {
            if (opts.broken) fail()
            items.set(syncServer, secrets)
        },
        async remove(syncServer) {
            if (opts.broken) fail()
            items.delete(syncServer)
        },
    }
}

describe('saving a login', () => {
    it('keeps the secrets in the keychain and only the server in the file', async () => {
        const path = await configPath()
        const keychain = memoryKeychain()
        const config: HeadlessConfig = { servers: {} }

        const where = await saveLogin({ config, path, syncServer: SERVER, secrets: { token: AGENT, vaultKey: VAULT_KEY }, keychain })

        expect(where).toBe('the test keychain')
        expect(keychain.items.get(SERVER)).toEqual({ token: AGENT, vaultKey: VAULT_KEY })
        const text = await readFile(path, 'utf8')
        expect(text).not.toContain(AGENT)
        expect(text).not.toContain(VAULT_KEY)
        expect(await readConfig(path)).toEqual({ servers: { [SERVER]: { keychain: true } } })
    })

    it('falls back to the owner-only file when the keychain cannot be reached, and says where', async () => {
        const path = await configPath()
        const config: HeadlessConfig = { servers: {} }

        const where = await saveLogin({ config, path, syncServer: SERVER, secrets: { token: AGENT, vaultKey: VAULT_KEY }, keychain: memoryKeychain({ broken: true }) })

        expect(where).toBe(path)
        expect(await readConfig(path)).toEqual({ servers: { [SERVER]: { pat: AGENT, vaultKey: VAULT_KEY } } })
    })

    it('falls back to the file when the keychain does not give back what it was given', async () => {
        const path = await configPath()
        const keychain = memoryKeychain({ garbles: true })

        const where = await saveLogin({ config: { servers: {} }, path, syncServer: SERVER, secrets: { token: AGENT }, keychain })

        expect(where).toBe(path)
        expect(keychain.items.has(SERVER)).toBe(false)
    })

    it('uses the file when there is no keychain at all', async () => {
        const path = await configPath()
        expect(await saveLogin({ config: { servers: {} }, path, syncServer: SERVER, secrets: { token: AGENT }, keychain: null })).toBe(path)
    })
})

describe('reading a login back', () => {
    it('reads secrets from the file or the keychain, whichever holds them', async () => {
        const keychain = memoryKeychain()
        keychain.items.set(SERVER, { token: AGENT, vaultKey: VAULT_KEY })
        await expect(loginCredentials(SERVER, { keychain: true }, keychain)).resolves.toEqual({ syncServer: SERVER, pat: AGENT, vaultKey: VAULT_KEY })
        await expect(loginCredentials(SERVER, { pat: STANDARD }, null)).resolves.toEqual({ syncServer: SERVER, pat: STANDARD })
    })

    it('says what to do when the keychain cannot be reached or has lost the login', async () => {
        await expect(loginCredentials(SERVER, { keychain: true }, memoryKeychain({ broken: true }))).rejects.toThrow(/not available here/)
        await expect(loginCredentials(SERVER, { keychain: true }, memoryKeychain())).rejects.toThrow(/holds no login for https:\/\/sync.example.com/)
        await expect(loginCredentials(SERVER, { keychain: true }, null)).rejects.toThrow(/ETHERPK_MCP_SECRETS/)
    })
})

describe('forgetting a login', () => {
    it('removes its keychain item, and leaves a file-held login to the file', async () => {
        const keychain = memoryKeychain()
        keychain.items.set(SERVER, { token: AGENT })
        await forgetLoginSecrets(SERVER, { keychain: true }, keychain)
        expect(keychain.items.has(SERVER)).toBe(false)
        await expect(forgetLoginSecrets(SERVER, { pat: AGENT }, memoryKeychain({ broken: true }))).resolves.toBeUndefined()
    })
})

describe('upgrading a stored standard token to an agent token', () => {
    it('exchanges it once, keeps the vault key, and saves where the login was kept', async () => {
        const path = await configPath()
        await writeConfig(path, { servers: { [SERVER]: { pat: STANDARD, vaultKey: VAULT_KEY } } })
        const exchange = vi.fn(async () => AGENT)
        const say = vi.fn()

        const upgraded = await upgradeToAgentToken({ path, credentials: { syncServer: SERVER, pat: STANDARD, vaultKey: VAULT_KEY }, keychain: null, name: 'Agent on desk', exchange, say })

        expect(upgraded).toEqual({ syncServer: SERVER, pat: AGENT, vaultKey: VAULT_KEY })
        expect(exchange).toHaveBeenCalledWith({ syncServer: SERVER, token: STANDARD, name: 'Agent on desk' })
        expect(await readConfig(path)).toEqual({ servers: { [SERVER]: { pat: AGENT, vaultKey: VAULT_KEY } } })
        expect(say).toHaveBeenCalledWith(expect.stringContaining('agent token'))
    })

    it('leaves an agent token alone, asking nothing of the server', async () => {
        const exchange = vi.fn()
        const credentials = { syncServer: SERVER, pat: AGENT }
        await expect(upgradeToAgentToken({ path: await configPath(), credentials, keychain: null, name: 'n', exchange, say: vi.fn() })).resolves.toBe(credentials)
        expect(exchange).not.toHaveBeenCalled()
    })

    it('uses the token another process already swapped in, rather than exchanging a revoked one', async () => {
        const path = await configPath()
        await writeConfig(path, { servers: { [SERVER]: { pat: AGENT, vaultKey: VAULT_KEY } } })
        const exchange = vi.fn()

        const upgraded = await upgradeToAgentToken({ path, credentials: { syncServer: SERVER, pat: STANDARD, vaultKey: VAULT_KEY }, keychain: null, name: 'n', exchange, say: vi.fn() })

        expect(upgraded.pat).toBe(AGENT)
        expect(exchange).not.toHaveBeenCalled()
    })

    it('goes on with the standard token on a server from before agent tokens, or when the exchange fails', async () => {
        const path = await configPath()
        await writeConfig(path, { servers: { [SERVER]: { pat: STANDARD } } })
        const credentials = { syncServer: SERVER, pat: STANDARD }

        await expect(upgradeToAgentToken({ path, credentials, keychain: null, name: 'n', exchange: async () => null, say: vi.fn() })).resolves.toEqual(credentials)
        await expect(
            upgradeToAgentToken({ path, credentials, keychain: null, name: 'n', exchange: async () => { throw new Error('offline') }, say: vi.fn() }),
        ).resolves.toEqual(credentials)
        expect(await readConfig(path)).toEqual({ servers: { [SERVER]: { pat: STANDARD } } })
    })
})

describe('a failed upgrade that may have revoked the old token', () => {
    it('says the old token no longer works when the server refuses it', async () => {
        const path = await configPath()
        await writeConfig(path, { servers: { [SERVER]: { pat: STANDARD } } })
        const say = vi.fn()

        await upgradeToAgentToken({
            path,
            credentials: { syncServer: SERVER, pat: STANDARD },
            keychain: null,
            name: 'n',
            exchange: async () => {
                throw new Error('the answer was lost')
            },
            say,
            stillWorks: async () => false,
        })

        expect(say).toHaveBeenCalledWith(expect.stringContaining('the old token no longer works'))
        expect(say).not.toHaveBeenCalledWith(expect.stringContaining('It goes on working'))
    })
})
