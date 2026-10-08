/**
 * A login's secrets, wherever they are kept: read for a command, saved by `login`, forgotten by
 * `logout`, and upgraded from a standard token to an agent token (ADR 0132) the first time a
 * newer Headless Client runs with a login an older one made.
 *
 * `config.ts` is the file's shape; `secret-store.ts` is the keychain. This module decides between
 * them: the keychain when `login` can write to it and read the same back, else the owner-only
 * file, and it says which, so the person knows where their keys are.
 */
import { accessTokenKind } from '@appsoftwareltd/etherpk-shared'

import { exchangeForAgentToken } from './agent-token'
import { inKeychain, readConfig, writeConfig, type HeadlessConfig, type ServerCredentials, type StoredLogin } from './config'
import { withFileLock } from './file-lock'
import type { LoginSecrets, SecretStore } from './secret-store'

/** The secrets of a stored login, from the file or the keychain. Rejects with words to act on. */
export async function loginCredentials(syncServer: string, stored: StoredLogin, keychain: SecretStore | null): Promise<ServerCredentials> {
    if (!inKeychain(stored)) return { syncServer, ...stored }
    if (!keychain) {
        throw new Error(`The login for ${syncServer} is in the system keychain, which this process was told not to use (ETHERPK_MCP_SECRETS=file) or cannot use on this system. Unset it, or run login again.`)
    }
    const secrets = await keychain.read(syncServer)
    if (!secrets) throw new Error(`${keychain.description} holds no login for ${syncServer}. Run login again.`)
    return { syncServer, pat: secrets.token, ...(secrets.vaultKey ? { vaultKey: secrets.vaultKey } : {}) }
}

function sameSecrets(a: LoginSecrets | null, b: LoginSecrets): boolean {
    return a !== null && a.token === b.token && (a.vaultKey ?? '') === (b.vaultKey ?? '')
}

/**
 * Save a login's secrets and write the config file. The keychain is used only once it has given
 * back exactly what it was given: a keychain that takes a write and loses it (a locked collection,
 * a tool that reports success it did not have) would otherwise leave the login unreadable.
 * Answers where the secrets went, in words for the person.
 */
export async function saveLogin(opts: {
    config: HeadlessConfig
    path: string
    syncServer: string
    secrets: LoginSecrets
    keychain: SecretStore | null
}): Promise<string> {
    const { config, path, syncServer, secrets, keychain } = opts
    if (keychain) {
        try {
            await keychain.write(syncServer, secrets)
            if (sameSecrets(await keychain.read(syncServer), secrets)) {
                config.servers[syncServer] = { keychain: true }
                await writeConfig(path, config)
                return keychain.description
            }
        } catch {
            // Unreachable or locked: the file below is where the secrets go instead.
        }
        await keychain.remove(syncServer).catch(() => {})
    }
    config.servers[syncServer] = { pat: secrets.token, ...(secrets.vaultKey ? { vaultKey: secrets.vaultKey } : {}) }
    await writeConfig(path, config)
    return path
}

/** Forget what the keychain holds for a login. A file-held login goes with the file entry. */
export async function forgetLoginSecrets(syncServer: string, stored: StoredLogin, keychain: SecretStore | null): Promise<void> {
    if (inKeychain(stored) && keychain) await keychain.remove(syncServer)
}

/**
 * A login an older Headless Client made holds a standard token, which reaches everything a
 * signed-in session does. Trade it for an agent token, which the Sync Server revokes the standard
 * one for, and save that in its place. Anything that stops the trade (a server from before agent
 * tokens, no network) leaves the login as it was, to be tried again on the next run.
 */
export async function upgradeToAgentToken(opts: {
    path: string
    credentials: ServerCredentials
    keychain: SecretStore | null
    name: string
    exchange?: typeof exchangeForAgentToken
    say: (line: string) => void
    /**
     * Does the server still accept this token? Asked after a failed exchange, which may have
     * revoked the old token on the server before its answer was lost.
     */
    stillWorks?: (token: string) => Promise<boolean>
}): Promise<ServerCredentials> {
    const { path, credentials, keychain, name, say } = opts
    if (accessTokenKind(credentials.pat) !== 'standard') return credentials
    const exchange = opts.exchange ?? exchangeForAgentToken
    try {
        return await withFileLock(path, async () => {
            // Read again under the lock: another process may have made the trade already.
            const config = await readConfig(path)
            const stored = config?.servers[credentials.syncServer]
            if (!config || !stored) return credentials
            const current = await loginCredentials(credentials.syncServer, stored, keychain)
            if (accessTokenKind(current.pat) !== 'standard') return current
            const agentToken = await exchange({ syncServer: current.syncServer, token: current.pat, name })
            if (!agentToken) return current
            const where = await saveLogin({
                config,
                path,
                syncServer: current.syncServer,
                secrets: { token: agentToken, ...(current.vaultKey ? { vaultKey: current.vaultKey } : {}) },
                keychain: inKeychain(stored) ? keychain : null,
            })
            say(`etherpk-mcp: replaced the access token for ${current.syncServer} with an agent token for this computer, kept in ${where}. An agent token can do only what an agent needs, and the old token has been revoked.`)
            return { ...current, pat: agentToken }
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (opts.stillWorks && !(await opts.stillWorks(credentials.pat).catch(() => true))) {
            say(`etherpk-mcp: could not replace the access token for ${credentials.syncServer} with an agent token (${reason}), and the old token no longer works. Make a setup code in EtherPK (a synced graph's Settings > Agents) and run login again.`)
        } else {
            say(`etherpk-mcp: could not replace the access token for ${credentials.syncServer} with an agent token this time (${reason}). It goes on working, and the next run tries again.`)
        }
        return credentials
    }
}
