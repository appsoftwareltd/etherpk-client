import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
    KEYCHAIN_SERVICE,
    decodeSecrets,
    encodeSecrets,
    macKeychainStore,
    runCommand,
    secretServiceStore,
    systemSecretStore,
    type CommandResult,
    type RunCommand,
} from './secret-store'

const SERVER = 'https://sync.example.com'
const SECRETS = { token: `epk_agt_${'B'.repeat(43)}`, vaultKey: 'C'.repeat(43) }

/** A runner that records each call and answers from `answer`. */
function recording(answer: (command: string, args: string[], input?: string) => Partial<CommandResult>) {
    const calls: Array<{ command: string; args: string[]; input?: string }> = []
    const run: RunCommand = async (command, args, options) => {
        calls.push({ command, args, input: options.input })
        return { code: 0, stdout: '', stderr: '', ...answer(command, args, options.input) }
    }
    return { run, calls }
}

describe('the keychain value', () => {
    it('round-trips with no character a command parser could split on', () => {
        const value = encodeSecrets(SECRETS)
        expect(value).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(decodeSecrets(value)).toEqual(SECRETS)
        expect(decodeSecrets(`${value}\n`)).toEqual(SECRETS)
        expect(decodeSecrets('not a value')).toBeNull()
    })
})

describe('the Secret Service store', () => {
    it('passes the secret on standard input, never as an argument', async () => {
        const { run, calls } = recording(() => ({}))
        await secretServiceStore(run).write(SERVER, SECRETS)
        const [call] = calls
        expect(call.command).toBe('secret-tool')
        expect(call.args.slice(0, 1)).toEqual(['store'])
        expect(call.args).toEqual(expect.arrayContaining(['service', KEYCHAIN_SERVICE, 'server', SERVER]))
        expect(call.args.join(' ')).not.toContain(SECRETS.token)
        expect(decodeSecrets(call.input ?? '')).toEqual(SECRETS)
    })

    it('reads what it wrote, and reads nothing for a server it holds nothing for', async () => {
        const stored = recording((_c, args) => (args[0] === 'lookup' ? { stdout: encodeSecrets(SECRETS) } : {}))
        await expect(secretServiceStore(stored.run).read(SERVER)).resolves.toEqual(SECRETS)

        const empty = recording(() => ({ code: 1 }))
        await expect(secretServiceStore(empty.run).read(SERVER)).resolves.toBeNull()
    })

    it('says plainly when the keyring cannot be reached', async () => {
        const missing = recording(() => ({ code: null, missing: true }))
        await expect(secretServiceStore(missing.run).read(SERVER)).rejects.toThrow('your desktop keyring (Secret Service) is not available here.')

        const locked = recording(() => ({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY\n' }))
        await expect(secretServiceStore(locked.run).write(SERVER, SECRETS)).rejects.toThrow(/could not save the login: Cannot autolaunch D-Bus/)
    })
})

describe('the macOS Keychain store', () => {
    it('adds the item through security -i, so the secret is never an argument', async () => {
        const { run, calls } = recording(() => ({}))
        await macKeychainStore(run).write(SERVER, SECRETS)
        const [call] = calls
        expect(call.command).toBe('/usr/bin/security')
        expect(call.args).toEqual(['-i'])
        expect(call.input).toBe(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${SERVER} -l ${KEYCHAIN_SERVICE} -w ${encodeSecrets(SECRETS)}\n`)
    })

    it('reads the item, and reads nothing when there is none', async () => {
        const stored = recording(() => ({ stdout: `${encodeSecrets(SECRETS)}\n` }))
        await expect(macKeychainStore(stored.run).read(SERVER)).resolves.toEqual(SECRETS)
        expect(stored.calls[0].args).toEqual(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', SERVER, '-w'])

        const none = recording(() => ({ code: 44 }))
        await expect(macKeychainStore(none.run).read(SERVER)).resolves.toBeNull()
    })
})

describe('which store this computer uses', () => {
    it('is the keychain on macOS and Linux, and the file elsewhere or when asked', () => {
        expect(systemSecretStore({ platform: 'darwin', env: {} })?.description).toBe('the macOS Keychain')
        expect(systemSecretStore({ platform: 'linux', env: {} })?.description).toBe('your desktop keyring (Secret Service)')
        expect(systemSecretStore({ platform: 'win32', env: {} })).toBeNull()
        expect(systemSecretStore({ platform: 'linux', env: { ETHERPK_MCP_SECRETS: 'file' } })).toBeNull()
    })
})

// The real runner against a stand-in `secret-tool` on the PATH: what reaches the command, on which
// stream, is the part the recording runner above cannot show.
describe.runIf(process.platform !== 'win32')('the command runner', () => {
    const dirs: string[] = []
    afterEach(async () => {
        await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    })

    it('feeds standard input, collects standard output and reports the exit code', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-secret-store-'))
        dirs.push(dir)
        const tool = join(dir, 'fake-tool')
        await writeFile(tool, '#!/bin/sh\ncat\necho "args:$*" >&2\nexit 3\n')
        await chmod(tool, 0o755)

        const result = await runCommand(tool, ['a', 'b'], { input: 'secret-on-stdin', timeoutMs: 5_000 })

        expect(result).toEqual({ code: 3, stdout: 'secret-on-stdin', stderr: 'args:a b\n' })
    })

    it('says a command that is not installed is missing, without throwing', async () => {
        const result = await runCommand('/nonexistent/etherpk-no-such-tool', [], { timeoutMs: 5_000 })
        expect(result.missing).toBe(true)
        expect(result.code).toBeNull()
    })
})
