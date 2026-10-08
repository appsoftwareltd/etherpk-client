/**
 * Where the Headless Client keeps a login's secrets (ADR 0072, amended): the agent token and the
 * vault key. The system keychain when this computer has one it can reach, else the login file.
 *
 * The keychain keeps the secrets out of any file. An agent searching this user's files for the
 * notes, or a backup of the home directory, then finds the login file holding only the server's
 * address. It does not keep them from a program that asks the keychain on purpose while it runs
 * as this user, which any of this user's programs may do on Linux, and which the `security` tool
 * may do on macOS. ADR 0132's agent token is what limits what such a program could do with them.
 *
 * Two keychains, reached through the command each system ships, so the package has no native
 * dependency:
 *
 * - **macOS**: the login keychain, through `/usr/bin/security`. The secret goes in on standard
 *   input (`security -i`), never on a command line another process could list.
 * - **Linux**: the desktop's Secret Service (GNOME Keyring, KWallet), through `secret-tool` from
 *   libsecret, which reads the secret from standard input. A machine without it, or without a
 *   desktop session to reach, uses the file.
 *
 * Windows, and any other system, uses the file. `ETHERPK_MCP_SECRETS=file` chooses the file
 * everywhere (a server with no desktop session, a test).
 */
import { spawn } from 'node:child_process'

/** What one login keeps secret. */
export interface LoginSecrets {
    /** The access token: an agent token, or a standard one on a server from before them. */
    token: string
    /** The vault key, base64url. Absent until `login` has unlocked the account. */
    vaultKey?: string
}

export interface SecretStore {
    /** The keychain in words for a person: "the macOS Keychain". */
    readonly description: string
    /** The secrets kept for this server, or null when there are none. Rejects when the keychain cannot be reached. */
    read(syncServer: string): Promise<LoginSecrets | null>
    write(syncServer: string, secrets: LoginSecrets): Promise<void>
    /** Forget the secrets for this server; nothing kept is not a failure. */
    remove(syncServer: string): Promise<void>
}

export interface CommandResult {
    /** The exit code, or null when the command could not run at all (`missing`) or was stopped. */
    code: number | null
    stdout: string
    stderr: string
    /** The command is not installed. */
    missing?: boolean
}

export type RunCommand = (command: string, args: string[], options: { input?: string; timeoutMs: number }) => Promise<CommandResult>

export class SecretStoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SecretStoreError'
    }
}

/** The keychain item's service name. Also what the agent's instructions tell it not to read. */
export const KEYCHAIN_SERVICE = 'etherpk-mcp'

/**
 * A keychain prompt (a locked keyring asking for its password) is answered by a person, so give
 * one time; a command that has not answered by then is treated as failing.
 */
const TIMEOUT_MS = 30_000

/**
 * The secrets as one keychain value: base64url of their JSON, so the value has no space, quote or
 * newline that `security -i`'s own command parser or a line read could split.
 */
export function encodeSecrets(secrets: LoginSecrets): string {
    return Buffer.from(JSON.stringify(secrets)).toString('base64url')
}

export function decodeSecrets(value: string): LoginSecrets | null {
    try {
        const parsed = JSON.parse(Buffer.from(value.trim(), 'base64url').toString('utf8')) as { token?: unknown; vaultKey?: unknown }
        if (typeof parsed.token !== 'string' || parsed.token === '') return null
        return { token: parsed.token, ...(typeof parsed.vaultKey === 'string' && parsed.vaultKey !== '' ? { vaultKey: parsed.vaultKey } : {}) }
    } catch {
        return null
    }
}

function failed(store: string, action: string, result: CommandResult): SecretStoreError {
    if (result.missing) return new SecretStoreError(`${store} is not available here.`)
    if (result.code === null) return new SecretStoreError(`${store} did not answer while trying to ${action}. If it asked for a password, unlock it and try again.`)
    const said = result.stderr.trim().split('\n')[0]
    return new SecretStoreError(`${store} could not ${action}${said ? `: ${said}` : ''}.`)
}

/** The Secret Service through libsecret's `secret-tool`. */
export function secretServiceStore(run: RunCommand): SecretStore {
    const description = 'your desktop keyring (Secret Service)'
    const attributes = (syncServer: string) => ['service', KEYCHAIN_SERVICE, 'server', syncServer]
    return {
        description,
        async read(syncServer) {
            const result = await run('secret-tool', ['lookup', ...attributes(syncServer)], { timeoutMs: TIMEOUT_MS })
            // `lookup` exits 1, saying nothing, when there is no such item.
            if (result.code === 1 && result.stdout.trim() === '' && result.stderr.trim() === '') return null
            if (result.code !== 0) throw failed(description, 'read the login', result)
            return decodeSecrets(result.stdout)
        },
        async write(syncServer, secrets) {
            const result = await run(
                'secret-tool',
                ['store', `--label=EtherPK Headless Client (${syncServer})`, ...attributes(syncServer)],
                { input: encodeSecrets(secrets), timeoutMs: TIMEOUT_MS },
            )
            if (result.code !== 0) throw failed(description, 'save the login', result)
        },
        async remove(syncServer) {
            const result = await run('secret-tool', ['clear', ...attributes(syncServer)], { timeoutMs: TIMEOUT_MS })
            if (result.code !== 0 && !result.missing) throw failed(description, 'forget the login', result)
        },
    }
}

/** The macOS login keychain through `/usr/bin/security`. */
export function macKeychainStore(run: RunCommand): SecretStore {
    const description = 'the macOS Keychain'
    const item = (syncServer: string) => ['-s', KEYCHAIN_SERVICE, '-a', syncServer]
    return {
        description,
        async read(syncServer) {
            const result = await run('/usr/bin/security', ['find-generic-password', ...item(syncServer), '-w'], { timeoutMs: TIMEOUT_MS })
            // 44 is errSecItemNotFound.
            if (result.code === 44) return null
            if (result.code !== 0) throw failed(description, 'read the login', result)
            return decodeSecrets(result.stdout)
        },
        async write(syncServer, secrets) {
            // On standard input, as one interactive command: `-w <secret>` as an argument would put
            // the secret where any process can list it. -U replaces an item already there.
            const command = ['add-generic-password', '-U', ...item(syncServer), '-l', KEYCHAIN_SERVICE, '-w', encodeSecrets(secrets)].join(' ')
            const result = await run('/usr/bin/security', ['-i'], { input: `${command}\n`, timeoutMs: TIMEOUT_MS })
            if (result.code !== 0) throw failed(description, 'save the login', result)
        },
        async remove(syncServer) {
            const result = await run('/usr/bin/security', ['delete-generic-password', ...item(syncServer)], { timeoutMs: TIMEOUT_MS })
            if (result.code !== 0 && result.code !== 44 && !result.missing) throw failed(description, 'forget the login', result)
        },
    }
}

/**
 * The keychain this computer offers, or null when the login file is where secrets go: another
 * system, or `ETHERPK_MCP_SECRETS=file`. A keychain returned here may still turn out to be
 * unreachable; `login` checks by writing and reading back before it relies on one.
 */
export function systemSecretStore(opts: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run?: RunCommand }): SecretStore | null {
    if (opts.env.ETHERPK_MCP_SECRETS?.trim().toLowerCase() === 'file') return null
    const run = opts.run ?? runCommand
    if (opts.platform === 'darwin') return macKeychainStore(run)
    if (opts.platform === 'linux') return secretServiceStore(run)
    return null
}

/** Run a command with no shell, feeding `input` to its standard input. Never rejects. */
export function runCommand(command: string, args: string[], options: { input?: string; timeoutMs: number }): Promise<CommandResult> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>
        try {
            child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: options.timeoutMs })
        } catch {
            resolve({ code: null, stdout: '', stderr: '', missing: true })
            return
        }
        let stdout = ''
        let stderr = ''
        let missing = false
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
        child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') missing = true
        })
        child.on('close', (code) => resolve({ code: missing ? null : code, stdout, stderr, ...(missing ? { missing } : {}) }))
        // A command that is missing never reads its input; the write then fails, which is fine.
        child.stdin?.on('error', () => {})
        child.stdin?.end(options.input ?? '')
    })
}
