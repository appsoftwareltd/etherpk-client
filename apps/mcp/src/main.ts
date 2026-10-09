/**
 * `etherpk-mcp`: the [[Headless Client]]'s command line (ADR 0072).
 *
 *   etherpk-mcp login  --sync-server <url> [--code <setup code> | --pat <token>] [--recovery-code]
 *   etherpk-mcp graphs [--sync-server <url>]
 *   etherpk-mcp serve  --graph <id or name> [--sync-server <url>] [--no-semantic]
 *   etherpk-mcp serve  --folder <path> [--no-semantic]
 *   etherpk-mcp running
 *   etherpk-mcp stop   [--graph <id or name> [--sync-server <url>] | --folder <path> | --all]
 *   etherpk-mcp logout [--sync-server <url> | --all]
 *   etherpk-mcp semantic setup | status | remove
 *   etherpk-mcp publish (--graph <id or name> | --folder <path>) --publication <id> [--out <dir>]
 *   etherpk-mcp diagrams setup | status
 *
 * One config file holds a login per Sync Server (ADR 0075). `--sync-server` names the one a
 * command means and may be left out while there is only one login.
 *
 * `serve` speaks MCP over stdio, so everything for the human goes to stderr; stdout belongs
 * to the agent. `login` and `graphs` are interactive and print to stdout.
 *
 * A graph is served on a computer by one background process, the graph's host, however many
 * agents use it (ADR 0072, amended 2026-10-08). `serve` relays its agent's session to the host and
 * starts the host when none is running; `host` is the command it starts, not one for people.
 */

import { createInterface } from 'node:readline/promises'
import { hostname } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { unlink } from 'node:fs/promises'

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { accessTokenKind, looksLikeAgentSetupCode } from '@appsoftwareltd/etherpk-shared'

// Inlined by Vite at build time, so the bundle carries the version and needs no file at runtime.
import pkg from '../package.json'

import { EnvelopeError, fromBase64Url, mergeKeyringEpochs, toBase64Url, type KeyVault } from '$lib/crypto'
import { createGraphNamePublisher } from '$lib/sync/graph-name-envelope'
import { readKeyHandouts } from '$lib/sync/key-handouts'

import { connectAccount, openAccountVault, resolveGraphById, type HeadlessAccount } from './account'
import { exchangeForAgentToken, redeemSetupCode, revokeHeldToken } from './agent-token'
import {
    defaultConfigPath,
    emptyConfig,
    listLogins,
    normaliseSyncServer,
    readConfig,
    selectServer,
    writeConfig,
    type HeadlessConfig,
    type ServerCredentials,
    type ServerSelection,
    type StoredLogin,
} from './config'
import { describeConnectionFailure } from './connection-errors'
import { forgetLoginSecrets, loginCredentials, saveLogin, upgradeToAgentToken } from './logins'
import { systemSecretStore } from './secret-store'

import { MODEL, loadEmbeddingModel, removeSemantic, semanticSetupStatus, setupSemantic, whenSemanticSetUp } from './embedder'
import { watchFolder } from './folder-watch'
import { describeGraphLabel, findGraphByName, graphLabel, resolveGraphLabel, type MetaNameReader } from './graph-labels'
import { readGraphName } from './graph-names'
import { runGraphHost, type HostedGraph, type PublishRequest } from './graph-host'
import { openHeadlessFolder } from './headless-folder'
import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { requestHost, runningHosts, spawnHostProcess, stopHosts, type HostLauncher } from './host-client'
import { hostEndpoint, hostLogPath, type HostTarget } from './host-endpoint'
import { HOST_PROTOCOL, publishSettings, withPublishSettings, type HostReply, type HostStatus } from './host-protocol'
import { createRelay, type Backend } from './host-relay'
import {
    ApprovalAbandoned,
    approvalWaitControls,
    sleepUnlessAborted,
    unlockByDeviceApproval,
    unlockByRecoveryCode,
    type QuitSignal,
} from './login'
import { createMcpServer } from './mcp-server'
import { chromiumStatus, setupDiagrams } from './diagrams'
import { defaultPublishFoldersPath, publishFolderOf, publishGraphKey, readPublishFolders, withPublishFolder, writePublishFolders } from './publish-folders'
import { cliPublishOutput, findPublication, publish as publishTool } from './publish-tools'
import { ToolError } from './tools'
import { createNodeDirectoryAdapter, isGraphFolder } from './node-directory-adapter'
import { describeGraphStore, folderCacheDir, folderKey, graphCacheDir, listGraphStores, removeCacheRoot, removeServerCache, removeUnlistedGraphCaches, stampGraphCacheOwner } from './persistence'
import { bindServeLifetime } from './serve-lifetime'
import { SocketTransport } from './socket-transport'

const VERSION: string = pkg.version

/**
 * How the user invokes this program, so every hint is one they can paste. Through npx - the way
 * the Agents tab, the README and the docs all say - the bin is never on their PATH, and an npx
 * run executes out of npm's `_npx` cache; a global install (`npm install -g`) runs from
 * anywhere else and does have `etherpk-mcp` on the PATH, so it gets the short spelling.
 */
const CMD = /[\\/]_npx[\\/]/.test(process.argv[1] ?? '') ? 'npx @appsoftwareltd/etherpk-mcp' : 'etherpk-mcp'

const USAGE = `etherpk-mcp - EtherPK Headless Client (an MCP server over one synced graph)

  ${CMD} login --sync-server <url> [--code <setup code>] [--recovery-code]
      Sign this machine in as a device of your account. Make a setup code in EtherPK
      (a synced graph's Settings > Agents, or <url>/account/tokens) and pass it with --code:
      it works once, within 10 minutes, and gets this machine an agent token of its own,
      which can do only what an agent needs. Then unlock your Encryption Keys by Device
      Approval: open EtherPK in a browser connected to the account with its Encryption Keys
      unlocked, approve there if it shows the same code, then press y. Press r while waiting,
      or pass --recovery-code, to type your Recovery Code instead (or ETHERPK_RECOVERY_CODE,
      for a scripted setup).
      For a script, --pat <token> or ETHERPK_PAT takes an account-wide access token instead,
      which login swaps for an agent token and revokes.
      The token and Encryption Keys are kept in the system keychain where there is one (macOS
      Keychain, or a Linux desktop's keyring through secret-tool), else in the config file below.
  ${CMD} graphs [--sync-server <url>]
      List the synced graphs each logged-in account can reach, by name and id.
  ${CMD} serve --graph <id or name> [--sync-server <url>] [--no-semantic]
      Serve one synced graph to an agent over stdio. For Claude Code:
        claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server <url> --graph <id>
      Once "semantic setup" has run on this computer, serve also keeps a search-by-meaning
      store of the graph current (the agent's search tool gains mode: semantic) - pass
      --no-semantic to leave it off for this registration.
      Any number of agents can serve the same graph at once. The first one starts the graph's
      background process, which holds the graph open, and every serve passes its agent's
      session to that process.
  ${CMD} serve --folder <path> [--no-semantic]
      Serve a local graph folder the same way: no sign-in, no server. The agent gets search,
      backlinks, tasks and format-safe edits over the folder's markdown, alongside the files
      themselves. Edits made in an editor or by the agent directly are picked up as they land.
      The folder must already be a graph (open it in EtherPK once) - its index is kept under
      the cache directory, never in the folder.
  ${CMD} running
      List the graphs served on this computer: each one's background process, its agents and
      its log. A background process stops on its own once no agent has used it for five
      minutes (ETHERPK_MCP_HOST_IDLE_SECONDS sets another time).
  ${CMD} stop [--graph <id or name> [--sync-server <url>] | --folder <path> | --all]
      Stop the background process of one graph, or of every graph (the default). Each saves
      its graph first. An agent still connected starts a new one on its next call.
  ${CMD} logout [--sync-server <url> | --all]
      Revoke that server's token on the server, and forget it, the Encryption Keys and the
      cached graphs on this machine. The background processes serving that server's graphs
      stop first.
  ${CMD} semantic setup
      Let the agent search by meaning. Installs a ~300 MB native runtime (onnxruntime-node,
      with your npm) and downloads a 23 MB embedding model into the cache directory, once
      per computer. Nothing leaves this computer when the model runs - notes are never sent
      to a service to be embedded.
  ${CMD} semantic status | remove
      Whether it is set up here, or delete it (logout --all deletes it too).
  ${CMD} publish (--graph <id or name> | --folder <path>) --publication <id> [--out <dir>]
      Publish one publication of a graph to a folder on this machine and print the report.
      --out sets the publish folder for that graph and publication and is remembered: from
      then on this command without --out, and the agent's publish tool, write to the same
      folder (the agent cannot choose one). The folder's owned files (.html at the top,
      assets/, theme/, the search, feed and report files) are rewritten and their strays
      removed - everything else in it is left alone. Publishing writes files - deploying them
      (a git push, say) is yours. Run it from cron for a site that republishes itself.
  ${CMD} diagrams setup
      Let a publish draw Mermaid diagrams and maps. Downloads a Chromium (about 170 MB) into the
      cache directory with Playwright's installer, once per computer - a publish whose pages hold
      diagrams or maps refuses until this has run. Set ETHERPK_CHROMIUM=<path> to use a browser
      already on this machine instead (NixOS needs this).
  ${CMD} diagrams status
      Which browser a publish would use, if any.

This machine can hold logins for several Sync Servers at once. The --sync-server flag says
which one a command means, and can be left out while there is only one. The config file is
${defaultConfigPath()} (override with
ETHERPK_MCP_CONFIG) - cached graphs live under ~/.cache/etherpk/mcp (override with
ETHERPK_MCP_CACHE_DIR). ETHERPK_MCP_SECRETS=file keeps tokens and Encryption Keys in the config file
even where there is a keychain.
Docs: https://docs.etherpk.com/using-ai-agents-with-your-notes
`

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

/**
 * Ask on the terminal; `hint` says how to give the answer when there is none (a script, or
 * an agent starting the process), since each question has its own option or variable.
 */
async function ask(question: string, { secret = false, hint }: { secret?: boolean; hint: string }): Promise<string> {
    if (!process.stdin.isTTY) fail(`${question.replace(/:\s*$/, '')}: no terminal to ask on - ${hint}.`)
    if (!secret) {
        const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
        try {
            return (await rl.question(question)).trim()
        } finally {
            rl.close()
        }
    }
    // A secret is read in raw mode so the terminal never echoes it: readline has no echo-off,
    // and a token or Recovery Code in scrollback is exactly what this command exists to avoid.
    process.stderr.write(question)
    return new Promise<string>((resolve, reject) => {
        const stdin = process.stdin
        let typed = ''
        const finish = (outcome: () => void) => {
            stdin.setRawMode(false)
            stdin.pause()
            stdin.off('data', onData)
            process.stderr.write('\n')
            outcome()
        }
        const onData = (chunk: Buffer) => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\u0003') return finish(() => reject(new Error('Cancelled.')))
                if (char === '\r' || char === '\n') return finish(() => resolve(typed.trim()))
                if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
                else typed += char
            }
        }
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onData)
    })
}

async function loadConfig(path: string): Promise<HeadlessConfig> {
    const config = await readConfig(path)
    if (!config) fail(`${path} is not a config file this version understands. Run: ${CMD} login --sync-server <url> (it will be rewritten - nothing else is affected).`)
    return config
}

/** The login a command means, or an error saying why there is none, in words the user can act on. */
function selectLogin(config: HeadlessConfig, wanted: string | undefined): { syncServer: string; stored: StoredLogin } {
    const selection: ServerSelection = selectServer(config, wanted)
    if (selection.ok) return { syncServer: selection.syncServer, stored: selection.stored }
    switch (selection.reason) {
        case 'none':
            throw new Error(`Not logged in on this machine. Run: ${CMD} login --sync-server <url>`)
        case 'unknown':
            throw new Error(`Not logged in to ${selection.syncServer}. Logged in to: ${selection.known.join(', ') || '(none)'}. Run: ${CMD} login --sync-server ${selection.syncServer}`)
        case 'ambiguous':
            throw new Error(`Logged in to more than one Sync Server here: ${selection.known.join(', ')}. Say which with --sync-server <url>.`)
    }
}

/** `selectLogin` for a command, which says why and exits. */
function requireServer(config: HeadlessConfig, wanted: string | undefined): { syncServer: string; stored: StoredLogin } {
    try {
        return selectLogin(config, wanted)
    } catch (error) {
        return fail(describeError(error))
    }
}

/** The config file, or an error saying it cannot be read: for a process with nobody to exit to. */
async function readConfigOrThrow(path: string): Promise<HeadlessConfig> {
    const config = await readConfig(path)
    if (!config) throw new Error(`${path} is not a config file this version understands. Run: ${CMD} login --sync-server <url>`)
    return config
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** The keychain this process keeps logins in, or null for the config file (`secret-store.ts`). */
function keychain() {
    return systemSecretStore({ platform: process.platform, env: process.env })
}

/**
 * What the agent token is called on the Access tokens page and in presence: "Agent on <host>",
 * cut to the 100 characters a token name may have.
 */
function agentTokenName(): string {
    return `Agent on ${hostname()}`.slice(0, 100)
}

/**
 * A stored login's token and keys, for a command that uses them. A standard token left by an
 * older version is swapped for an agent token on the way (ADR 0132): the first run of a newer
 * Headless Client narrows what an older login can do, with nothing for the person to do.
 */
async function credentialsFor(login: { syncServer: string; stored: StoredLogin }): Promise<ServerCredentials> {
    const store = keychain()
    const credentials = await loginCredentials(login.syncServer, login.stored, store)
    return upgradeToAgentToken({
        path: defaultConfigPath(),
        credentials,
        keychain: store,
        name: agentTokenName(),
        say: (line) => console.error(line),
        stillWorks: (token) => tokenStillWorks(login.syncServer, token),
    })
}

/** Does the Sync Server still accept this token? A probe after a failed exchange. */
async function tokenStillWorks(syncServer: string, token: string): Promise<boolean> {
    try {
        const response = await fetch(`${syncServer}/api/v1/sync/me`, { headers: { authorization: `Bearer ${token}` } })
        return response.ok
    } catch {
        // Unreachable: no evidence the token was revoked, so say what was true when it last worked.
        return true
    }
}

/** A failed login request in words: the server's own refusal, or why it could not be reached. */
function describeLoginFailure(error: unknown, syncServer: string): string {
    return describeConnectionFailure(error, syncServer) ?? (error instanceof Error ? error.message : String(error))
}

async function login(args: { 'sync-server'?: string; pat?: string; code?: string; 'recovery-code'?: boolean }): Promise<void> {
    const path = defaultConfigPath()
    // A file this version cannot read is replaced, not refused: the old shape held one login,
    // and the user is about to make one.
    const config = (await readConfig(path)) ?? emptyConfig()
    const known = Object.keys(config.servers)
    const syncServer = normaliseSyncServer(args['sync-server'] ?? (known.length === 1 ? known[0] : await ask('Sync Server URL: ', { hint: 'pass --sync-server <url>' })))
    if (!/^https?:\/\//.test(syncServer)) fail('The Sync Server must be an http(s) URL.')
    const previous = config.servers[syncServer]
    const given = (
        args.code ??
        args.pat ??
        process.env.ETHERPK_PAT ??
        (await ask("Setup code (make one in EtherPK: a synced graph's Settings > Agents): ", { secret: true, hint: 'pass --code <setup code>' }))
    ).trim()
    if (!given) fail("A setup code is required. Make one in EtherPK: a synced graph's Settings > Agents.")

    // A setup code is the usual way in, and becomes this computer's agent token at once. An
    // access token (a script, or a server from before setup codes) is used to unlock and then
    // exchanged, so the long-lived token a person pasted is revoked once the agent has its own.
    const name = agentTokenName()
    let token: string
    let redeemed = false
    if (looksLikeAgentSetupCode(given)) {
        token = await redeemSetupCode({ syncServer, code: given, name }).catch((error: unknown) => fail(describeLoginFailure(error, syncServer)))
        redeemed = true
    } else if (accessTokenKind(given) !== null) {
        token = given
    } else {
        fail("That is neither a setup code (epk_setup_...) nor an access token (epk_pat_...). Make a setup code in EtherPK: a synced graph's Settings > Agents.")
    }

    // A token minted for this login and not kept is revoked, so a failed login leaves none behind.
    const abandon = async (error: unknown): Promise<never> => {
        if (redeemed) await revokeHeldToken({ syncServer, token })
        throw error
    }
    const account = await connectAccount({ syncServer, pat: token }).catch(abandon)
    console.log(`Connected to ${syncServer} as ${account.principal.email ?? account.principal.name ?? account.principal.id}.`)

    // ETHERPK_RECOVERY_CODE serves a box set up by a script, where there is no terminal to type
    // into and no tab to approve from; the variable is read once and never written anywhere.
    const byRecoveryCode = async () =>
        unlockByRecoveryCode(account.api, process.env.ETHERPK_RECOVERY_CODE ?? (await ask('Recovery Code: ', { secret: true, hint: 'set ETHERPK_RECOVERY_CODE' })))
    const vaultKey = await (args['recovery-code'] ? byRecoveryCode() : approveOrFallBack(account, byRecoveryCode)).catch(abandon)

    if (accessTokenKind(token) === 'standard') {
        const given = token
        const agentToken = await exchangeForAgentToken({ syncServer, token, name }).catch(async (error: unknown) => {
            // The exchange may have reached the server and revoked the token before failing.
            if (!(await tokenStillWorks(syncServer, given))) {
                fail(`Could not swap the access token for an agent token (${describeLoginFailure(error, syncServer)}), and the access token you gave no longer works. Run login again with a setup code.`)
            }
            console.log(`Could not swap the access token for an agent token (${describeLoginFailure(error, syncServer)}), so this computer keeps the access token you gave. Run login again to try again.`)
            return undefined
        })
        if (agentToken) {
            token = agentToken
            console.log(`The access token you gave has been revoked. This computer now holds an agent token of its own, which can do only what an agent needs. If you used that access token anywhere else, make a new one at ${syncServer}/account/tokens.`)
        } else if (agentToken === null) {
            console.log('This Sync Server runs an older version of EtherPK that cannot give agent tokens, so this computer keeps the access token you gave.')
        }
    }

    // The token this computer held before, if it held one for this server, is not needed now.
    if (previous) {
        const before = await loginCredentials(syncServer, previous, keychain()).catch(() => null)
        if (before && before.pat !== token && (await revokeHeldToken({ syncServer, token: before.pat }))) {
            console.log(`Revoked the token this computer held for ${syncServer} before this login.`)
        }
    }

    const where = await saveLogin({ config, path, syncServer, secrets: { token, vaultKey: toBase64Url(vaultKey) }, keychain: keychain() })
    console.log(
        where === path
            ? `Encryption Keys unlocked and kept in ${path} (owner-only). Anyone who can read your files on this machine can read this account, as with a signed-in browser. Never let an agent read, print or search that file.`
            : `Encryption Keys unlocked and kept in ${where}; ${path} names only the server. A program you run can still ask ${where} for them, so run only agents you trust with this account.`,
    )
    const others = Object.keys(config.servers).filter((server) => server !== syncServer)
    if (others.length > 0) console.log(`Also logged in to ${others.join(', ')} - commands now need --sync-server <url> to say which.`)

    // The hosts serving this server's graphs hold the token and keys this login replaces; an agent
    // still connected starts a new host, with this login, on its next call.
    const restarted = await stopHosts(process.env, 'a new login for its server', ({ status }) => status.target.kind === 'synced' && status.target.server === syncServer)
    if (restarted.length > 0) {
        console.log(`Stopped the background process of ${restarted.length === 1 ? 'one graph' : `${restarted.length} graphs`} served with the previous login. Agents start a new one with this login on their next call.`)
    }

    await listGraphs({ syncServer, pat: token, vaultKey: toBase64Url(vaultKey) }, others.length > 0)
}

/**
 * Device Approval, with the Recovery Code one keypress away: a user who has no unlocked EtherPK
 * to hand should not have to Ctrl-C and re-read the help to find `--recovery-code`. On a
 * terminal, `r` during the wait abandons the approval (cancelled server-side) and asks for the
 * code instead.
 *
 * Someone must confirm the two codes match (ADR 0125): without that, a server could play the
 * approving device itself. On a terminal that is the y key. Without one the same characters are
 * read from piped input, and input that ends before a y can never confirm, so the login stops at
 * once rather than waiting out ten minutes. A box with no terminal and its Recovery Code in
 * ETHERPK_RECOVERY_CODE uses the code.
 */
async function approveOrFallBack(
    account: Awaited<ReturnType<typeof connectAccount>>,
    byRecoveryCode: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
    const stdin = process.stdin
    const interactive = stdin.isTTY === true
    if (!interactive && process.env.ETHERPK_RECOVERY_CODE) return byRecoveryCode()
    const controls = approvalWaitControls()
    const io = {
        say: (line: string) => console.log(line),
        sleep: (ms: number) => sleepUnlessAborted(ms, controls.signal),
        codesMatch: () => controls.codesMatch,
        signal: controls.signal,
        clientUrl: account.clientUrl,
    }
    const onKey = (chunk: Buffer) => controls.onKey(chunk.toString('utf8'))
    const onInputEnd = () => controls.onInputClosed()
    // A quit that arrives as a signal (no terminal, or a supervisor stopping the process) aborts
    // the wait the same way a Ctrl-C key does, so the approval is cancelled before the exit.
    const quitSignals: QuitSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    const onSignal = (name: QuitSignal) => controls.onSignal(name)
    for (const name of quitSignals) process.once(name, onSignal)
    if (interactive) {
        console.log('(Press r to type your Recovery Code instead.)')
        stdin.setRawMode(true)
    } else {
        stdin.on('end', onInputEnd)
    }
    stdin.resume()
    stdin.on('data', onKey)
    // The key listener comes off BEFORE the Recovery Code prompt runs: that prompt takes the
    // terminal into raw mode itself, and a finally that reset it afterwards ate the code.
    let abandoned = false
    try {
        return await unlockByDeviceApproval(account.api, io)
    } catch (error) {
        if (!(error instanceof ApprovalAbandoned)) throw error
        abandoned = true
    } finally {
        for (const name of quitSignals) process.off(name, onSignal)
        stdin.off('data', onKey)
        stdin.off('end', onInputEnd)
        if (interactive) stdin.setRawMode(false)
        stdin.pause()
    }
    if (controls.exitCode !== null) {
        console.log('')
        process.exit(controls.exitCode)
    }
    if (!abandoned) throw new Error('unreachable')
    if (controls.mismatched) {
        fail('The codes did not match, so the request was cancelled. Something between this computer and your other device may have interfered. Run login again, or pass --recovery-code.')
    }
    if (controls.inputClosed) {
        fail('Device approval needs someone to confirm the code it shows. Run login in a terminal and press y when the codes match, or pass --recovery-code, or set ETHERPK_RECOVERY_CODE.')
    }
    console.log('Approval cancelled - unlocking with your Recovery Code instead.')
    return byRecoveryCode()
}

/**
 * `graphs` with a server named lists that server; unnamed, it lists every signed-in server in
 * turn, because "what can the agent reach from here" is the question and it has one answer
 * per login.
 */
async function graphsCommand(args: { 'sync-server'?: string }): Promise<void> {
    const config = await loadConfig(defaultConfigPath())
    const logins = args['sync-server'] ? [requireServer(config, args['sync-server'])] : listLogins(config)
    if (logins.length === 0) fail(`Not logged in on this machine. Run: ${CMD} login --sync-server <url>`)
    for (const login of logins) await listGraphs(await credentialsFor(login), logins.length > 1)
}

/**
 * The fallback for a graph the server carries no name envelope for: read its root document once
 * and publish the name, so no later listing has to. The publish is awaited because these
 * commands exit as soon as they have printed, and a request still in flight would be lost.
 */
function metaNameReader(account: HeadlessAccount): MetaNameReader {
    return async (record, keyring) => {
        const publisher = createGraphNamePublisher({ api: account.api, keyring, graphId: record.id })
        try {
            return await readGraphName({
                graphId: record.id,
                rootDocId: record.rootDocId,
                keyring,
                relayUrl: account.relayUrl,
                token: account.tokenFor(record.id),
                publishName: publisher.publish,
            })
        } finally {
            await publisher.settled()
        }
    }
}

/**
 * The account vault, opened with the key saved for `login`. A key that no longer opens it means
 * the account's keys were replaced or reset on another device (ADR 0128), which only a new login
 * mends, so that is what the failure says.
 */
async function openVaultFor(account: HeadlessAccount, login: ServerCredentials & { vaultKey: string }): Promise<KeyVault> {
    try {
        return await openAccountVault(account.api, fromBase64Url(login.vaultKey))
    } catch (error) {
        if (error instanceof EnvelopeError) {
            throw new Error(`Your Encryption Keys on ${login.syncServer} were replaced or reset on another device, so the key saved on this computer no longer opens them. Run: ${CMD} login --sync-server ${login.syncServer}`)
        }
        throw error
    }
}

async function listGraphs(login: ServerCredentials, several: boolean): Promise<void> {
    if (!login.vaultKey) fail(`Encryption Keys are not unlocked on this machine for ${login.syncServer}. Run: ${CMD} login --sync-server ${login.syncServer}`)
    const account = await connectAccount(login)
    const vault = await openVaultFor(account, { ...login, vaultKey: login.vaultKey })
    const graphs = await account.api.listGraphs()
    const serverFlag = several ? ` --sync-server ${login.syncServer}` : ''
    if (graphs.length === 0) {
        console.log(`No synced graphs are reachable with the token for ${login.syncServer}.`)
        return
    }
    console.log(several ? `Synced graphs on ${login.syncServer}:` : 'Synced graphs:')
    // Names come with the list, from the server's name envelopes (graph-labels.ts). Only a graph
    // nobody has opened since envelopes existed is opened here, once, to read and publish it.
    const readMeta = metaNameReader(account)
    for (const record of graphs) {
        console.log(`  ${record.id}  ${describeGraphLabel(await resolveGraphLabel(record, vault, readMeta))}  [${record.role}]`)
    }
    console.log('')
    console.log(`Serve one to an agent with:  ${CMD} serve${serverFlag} --graph <id>`)
    console.log(`For Claude Code:             claude mcp add etherpk -- ${CMD} serve${serverFlag} --graph <id>`)
}

async function semanticCommand(what: string | undefined): Promise<void> {
    switch (what) {
        case 'setup':
            await setupSemantic({ env: process.env, say: (line) => console.log(line) })
            return
        case 'status': {
            const status = await semanticSetupStatus(process.env)
            console.log(`Runtime: ${status.runtime ? 'installed' : 'missing'} (${status.runtimeDir})`)
            console.log(`Model:   ${status.model ? 'present' : 'missing'} (${status.modelDir})`)
            console.log(status.runtime && status.model ? 'Semantic search is set up - serve uses it unless started with --no-semantic.' : `Not set up. Run: ${CMD} semantic setup`)
            const stores = await listGraphStores(process.env, MODEL.id)
            if (stores.length === 0) return
            console.log('')
            console.log('Cached graphs:')
            for (const store of stores) console.log(`  ${store.host}  ${store.graphId}\n    ${describeGraphStore(store)}`)
            return
        }
        case 'remove':
            await removeSemantic(process.env)
            console.log('Removed the embedding runtime and model. Each graph\'s stored vectors stay in its cache and are reused if you set up again.')
            return
        default:
            fail(`semantic needs one of: setup, status, remove.\n\n${USAGE}`)
    }
}

async function diagramsCommand(what: string | undefined): Promise<void> {
    switch (what) {
        case 'setup':
            await setupDiagrams(process.env, (line) => console.log(line))
            return
        case 'status': {
            const status = await chromiumStatus(process.env, CMD)
            if (status.executable) console.log(`Chromium: ${status.executable} (${status.source === 'env' ? 'from ETHERPK_CHROMIUM' : 'installed by diagrams setup'}). A publish can draw Mermaid diagrams and maps.`)
            else console.log(status.source === 'env' ? `ETHERPK_CHROMIUM is set but names no file: ${process.env.ETHERPK_CHROMIUM}` : `No browser is set up. Run: ${status.setupCommand}`)
            return
        }
        default:
            fail(`diagrams needs one of: setup, status.\n\n${USAGE}`)
    }
}

/**
 * Publish from the command line: the same tool the agent has, run by the graph's host, which this
 * starts when none is running (ADR 0086; ADR 0072, amended 2026-10-08). The host holds the graph
 * open, so a publish while agents work reads what they wrote and writes no copy of its own.
 * `--out` is how a person sets the Publish Folder; the tool never takes one.
 */
async function publishCommand(args: ServeArgs & { publication?: string; out?: string }): Promise<void> {
    const request = graphRequest('publish', args)
    const publication = args.publication?.trim()
    if (!publication) fail('publish needs --publication <id>. The agent\'s list_publications tool, or Settings → Publish in EtherPK, shows the ids.')
    const found = await findGraph(request).catch((error: unknown) => fail(`etherpk-mcp: ${describeError(error)}`))
    const out = args.out?.trim()
    const { reply, socket } = await requestHost(launcherFor(found), {
        etherpk: 'publish',
        protocol: HOST_PROTOCOL,
        publication,
        ...(out ? { out: resolve(out) } : {}),
        env: publishSettings(process.env),
    }).catch((error: unknown) => fail(`etherpk-mcp: ${describeError(error)}`))
    socket.destroy()
    switch (reply.etherpk) {
        case 'published':
            for (const note of reply.notes) console.error(note)
            console.log(JSON.stringify(reply.output, null, 2))
            process.exitCode = reply.exitCode
            return
        case 'refused':
            return fail(reply.message)
        case 'failed':
            return fail(`etherpk-mcp: ${reply.message}`)
        case 'unsupported':
            return fail(`etherpk-mcp: this graph is served on this computer by etherpk-mcp ${reply.version}, which cannot run a publish for this version (${VERSION}). Run: ${CMD} stop, then publish again.`)
        default:
            return fail(`etherpk-mcp: the graph's background process gave an answer this version does not know ("${reply.etherpk}").`)
    }
}

/**
 * A command-line publish, as the graph's host runs it: the publication first, so a mistyped id is
 * never remembered as a publish folder, then `--out` remembered, then the publish the agent's
 * tool runs. The answer is what the command prints, in its own words.
 */
async function publishInHost(graph: HeadlessGraph, request: PublishRequest): Promise<HostReply> {
    const env = withPublishSettings(process.env, request.env ?? {})
    const host = { env, cmd: CMD, via: 'cli' as const }
    const notes: string[] = []
    try {
        await findPublication(graph, request.publication, host)
        const configPath = defaultPublishFoldersPath(env)
        const key = publishGraphKey(graph.backend, graph.graphId)
        if (request.out) {
            await writePublishFolders(configPath, withPublishFolder(await readPublishFolders(configPath), key, request.publication, request.out))
            notes.push(`etherpk-mcp: publish folder for "${request.publication}" of "${graph.name}" set to ${request.out} (remembered in ${configPath}).`)
        } else if (!publishFolderOf(await readPublishFolders(configPath), key, request.publication)) {
            return { etherpk: 'refused', message: `No publish folder is set for "${request.publication}" of "${graph.name}" on this machine. Pass --out <dir> once - it is remembered.` }
        }
        const result = await publishTool(graph, { id: request.publication }, host)
        // Names nothing the site leaves out: this output often lands in a scheduled job's log.
        return { etherpk: 'published', output: cliPublishOutput(result), notes, exitCode: result.ok ? 0 : 1 }
    } catch (error) {
        if (error instanceof ToolError) return { etherpk: 'refused', message: `etherpk-mcp: ${error.message}` }
        throw error
    }
}

/** A progress line on stderr every half minute while a build runs, and one when it is up to date. */
let lastProgressLog = 0
let announcedUpToDate = false
function reportSemanticProgress(status: { embedded: number; total: number }): void {
    const upToDate = status.embedded >= status.total
    if (upToDate && announcedUpToDate) return
    if (!upToDate && Date.now() - lastProgressLog < 30_000) return
    lastProgressLog = Date.now()
    announcedUpToDate = upToDate
    console.error(`etherpk-mcp: semantic: ${status.embedded} of ${status.total} passages embedded${upToDate ? ' - up to date' : ''}.${memoryNote()}`)
}

/**
 * `ETHERPK_MCP_DEBUG_MEMORY=1` adds the process's memory to every progress line and logs it every
 * ten seconds: the numbers that separate the JavaScript heap, the buffers outside it and the
 * native runtime when a serve grows without reason (2026-09-17).
 */
const debugMemory = process.env.ETHERPK_MCP_DEBUG_MEMORY === '1'
function memoryNote(): string {
    if (!debugMemory) return ''
    const m = process.memoryUsage()
    const mb = (n: number) => Math.round(n / 1e6)
    return ` [rss ${mb(m.rss)} MB, heap ${mb(m.heapUsed)} MB, external ${mb(m.external)} MB, arrayBuffers ${mb(m.arrayBuffers)} MB]`
}
if (debugMemory) setInterval(() => console.error(`etherpk-mcp: memory${memoryNote()}`), 10_000).unref()

interface ServeArgs {
    graph?: string
    folder?: string
    'sync-server'?: string
    'no-semantic'?: boolean
}

/** A graph `serve` or `publish` is asked for, before anything is read: a folder, or a synced graph by id or name. */
type GraphRequest = { kind: 'folder'; path: string } | { kind: 'synced'; wanted: string; server: string | undefined }

/** The flags of `serve` and `publish`, checked. */
function graphRequest(command: 'serve' | 'publish', args: ServeArgs): GraphRequest {
    const folder = args.folder?.trim()
    const wanted = args.graph?.trim()
    if (folder && (wanted || args['sync-server'])) fail(`${command} takes either --folder <path> or --graph <id or name> (with an optional --sync-server), not both.`)
    if (!folder && !wanted) fail(`${command} needs --graph <id or name>, or --folder <path> for a local graph folder.`)
    return folder ? { kind: 'folder', path: resolve(folder) } : { kind: 'synced', wanted: wanted!, server: args['sync-server'] }
}

/** What a request is called until its host says: the folder's name, or the id or name given. */
function requestLabel(request: GraphRequest): string {
    return request.kind === 'folder' ? basename(request.path) : request.wanted
}

/** A graph found, not opened: what its host serves, where it keeps its claim, and how to start one. */
interface FoundGraph {
    target: HostTarget
    cacheDir: string
    /** The `host` command's arguments for this graph. */
    hostArgs: string[]
}

/** A graph id as the Sync Server makes them. Anything else given to --graph is looked up as a name. */
const GRAPH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type NameLookups = Map<string, { graphId: string; name: string | null }>

/**
 * Find the graph a request names, without opening it. A folder must already be a graph. A synced
 * graph needs a login for its server, read from the config file each time, so an agent that
 * reconnects after a `logout` starts no host. Only a graph given by name needs the server, to
 * look the name up, and `names` keeps what was found for the next time.
 */
async function findGraph(request: GraphRequest, names: NameLookups = new Map()): Promise<FoundGraph> {
    if (request.kind === 'folder') {
        if (!(await isGraphFolder(request.path))) {
            throw new Error(`${request.path} is not an EtherPK graph folder: it has no pages/ and journals/ directories. Open the folder in EtherPK once to make it one, then serve it.`)
        }
        return { target: { kind: 'folder', path: request.path }, cacheDir: folderCacheDir(process.env, request.path), hostArgs: ['--folder', request.path] }
    }
    const login = selectLogin(await readConfigOrThrow(defaultConfigPath()), request.server)
    let graphId = request.wanted
    let name: string | null = null
    if (!GRAPH_ID.test(request.wanted)) {
        const key = `${login.syncServer}\n${request.wanted.toLowerCase()}`
        const found = names.get(key) ?? (await findGraphOnServer(login, request.wanted))
        names.set(key, found)
        graphId = found.graphId
        name = found.name
    }
    return {
        target: { kind: 'synced', server: login.syncServer, graphId },
        cacheDir: graphCacheDir(process.env, login.syncServer, graphId),
        hostArgs: ['--sync-server', login.syncServer, '--graph', graphId, ...(name ? ['--name', name] : [])],
    }
}

/** The synced graph a login's server lists as `wanted`, by id or else by name. */
async function findGraphOnServer(login: { syncServer: string; stored: StoredLogin }, wanted: string): Promise<{ graphId: string; name: string | null }> {
    const credentials = await credentialsFor(login)
    if (!credentials.vaultKey) throw new Error(`Encryption Keys are not unlocked on this machine for ${login.syncServer}. Run: ${CMD} login --sync-server ${login.syncServer}`)
    const account = await connectAccount(credentials)
    const vault = await openVaultFor(account, { ...credentials, vaultKey: credentials.vaultKey })
    const graphs = await account.api.listGraphs()
    const byId = graphs.find((graph) => graph.id === wanted)
    if (byId) return { graphId: byId.id, name: null }
    // By name: the server's name envelope, or one read of the root document for a graph without
    // one (graph-labels.ts).
    const match = await findGraphByName(graphs, vault, wanted, metaNameReader(account))
    if (!match) throw new Error(`No synced graph on ${login.syncServer} is named or identified by "${wanted}". Run: ${CMD} graphs`)
    return { graphId: match.record.id, name: match.name }
}

/** How to reach the host of a graph found, or start one. */
function launcherFor(found: FoundGraph): HostLauncher {
    return { cacheDir: found.cacheDir, spawn: () => spawnHostProcess({ args: found.hostArgs, env: process.env, logPath: hostLogPath(found.cacheDir) }) }
}

/** `work`, or an error saying `message` when it has not settled within `ms`. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
    })
    return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * `serve`: the agent's MCP session over stdio, relayed to the graph's host, which this starts when
 * none is running (ADR 0072, amended 2026-10-08). The relay answers nothing itself, so the agent's
 * `initialize` waits only for a host to listen, and the host answers it before the graph has
 * opened. When there is no host to be had, a stand-in answers each tool with the reason, and a
 * later call tries again.
 */
async function serve(args: ServeArgs): Promise<void> {
    const request = graphRequest('serve', args)
    const noSemantic = args['no-semantic'] === true
    const names: NameLookups = new Map()
    let served = false
    const connect = async (): Promise<Backend> => {
        try {
            const found = await within(findGraph(request, names), 30_000, `Could not find "${requestLabel(request)}" within 30 seconds: its Sync Server did not answer.`)
            const { reply, socket } = await requestHost(launcherFor(found), { etherpk: 'session', protocol: HOST_PROTOCOL, version: VERSION, noSemantic }, { answerTimeoutMs: 20_000 })
            switch (reply.etherpk) {
                case 'ok':
                    console.error(
                        `etherpk-mcp: ${served ? 'reconnected: serving' : 'serving'} "${reply.status.graph.name}" over stdio as "Agent on ${hostname()}", through the graph's background process (process ${reply.status.pid}, version ${reply.status.version}, log ${hostLogPath(found.cacheDir)}).`,
                    )
                    served = true
                    return { kind: 'host', transport: new SocketTransport(socket) }
                case 'failed':
                    socket.destroy()
                    return unavailable(request, reply.message)
                case 'unsupported':
                    socket.destroy()
                    return unavailable(request, `This graph is served on this computer by etherpk-mcp ${reply.version}, which cannot share it with this version (${VERSION}). Run: ${CMD} stop, then restart your agents.`)
                default:
                    socket.destroy()
                    return unavailable(request, `The graph's background process gave an answer this version does not know ("${reply.etherpk}"). Run: ${CMD} stop, then restart your agents.`)
            }
        } catch (error) {
            return unavailable(request, describeError(error))
        }
    }
    const transport = new StdioServerTransport()
    let agentClosed = () => {}
    const relay = createRelay({ agent: transport, connect, log: (line) => console.error(`etherpk-mcp: ${line}`), onAgentClose: () => agentClosed() })
    // Bound before the relay starts reading, which follows at once: the first byte on stdin is
    // then read by the lifetime and the transport in the same event (serve-lifetime.ts).
    bindServeLifetime({
        signals: process,
        stdin: process.stdin,
        transportClosed: (listener) => {
            agentClosed = listener
        },
        async shutdown(end) {
            console.error(`etherpk-mcp: ${end} - exiting.`)
            await relay.close()
            process.exit(0)
        },
    })
    await relay.start()
}

/**
 * A stand-in for the graph's host, in this process: it answers `initialize` as a host would and
 * every tool with `graph_unavailable` and the reason, so the agent can tell the person what to do.
 */
async function unavailable(request: GraphRequest, message: string): Promise<Backend> {
    console.error(`etherpk-mcp: ${message}`)
    const server = createMcpServer(Promise.reject(new ToolError('graph_unavailable', message)), {
        graphName: requestLabel(request),
        version: VERSION,
        cmd: CMD,
        credentialsDir: dirname(defaultConfigPath()),
        backendKind: request.kind,
    })
    const [relaySide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    return { kind: 'unavailable', transport: relaySide }
}

/** `ETHERPK_MCP_HOST_IDLE_SECONDS`: how long a graph's host stays once its last agent has gone. */
function hostIdleSeconds(env: NodeJS.ProcessEnv): number {
    const given = Number.parseInt(env.ETHERPK_MCP_HOST_IDLE_SECONDS?.trim() ?? '', 10)
    return Number.isFinite(given) && given >= 0 ? given : 300
}

/**
 * `host`: a graph's background process (graph-host.ts), started by `serve` and `publish`. Its
 * stdout carries one line, for the process that started it, and its stderr is the graph's log.
 */
async function hostCommand(args: ServeArgs & { name?: string }): Promise<void> {
    // The reader of stdout leaves once it has the announcement, so nothing else may go there,
    // and every log line says when it was written and by which process.
    process.stdout.on('error', () => {})
    const write = console.error.bind(console)
    console.error = (...items: unknown[]) => write(new Date().toISOString(), `[${process.pid}]`, ...items)
    console.log = console.error
    const folder = args.folder?.trim()
    const graphId = args.graph?.trim()
    const server = args['sync-server']?.trim()
    if (folder ? graphId || server : !graphId || !server) fail('host is started by serve and publish, with --folder <path>, or with --sync-server <url> and --graph <id>.')
    const target: HostTarget = folder ? { kind: 'folder', path: resolve(folder) } : { kind: 'synced', server: normaliseSyncServer(server!), graphId: graphId! }
    const cacheDir = target.kind === 'folder' ? folderCacheDir(process.env, target.path) : graphCacheDir(process.env, target.server, target.graphId)
    const handle = await runGraphHost({
        cacheDir,
        endpoint: hostEndpoint(cacheDir, process.env),
        version: VERSION,
        target,
        provisionalName: target.kind === 'folder' ? basename(target.path) : args.name?.trim() || null,
        backendKind: target.kind,
        idleMs: hostIdleSeconds(process.env) * 1000,
        cmd: CMD,
        credentialsDir: dirname(defaultConfigPath()),
        open: (named) => (target.kind === 'folder' ? openFolderGraph(target.path) : openSyncedGraph(target.server, target.graphId, named)),
        publish: publishInHost,
        log: (line) => console.error(`etherpk-mcp: ${line}`),
        announce: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
        exit: (code) => {
            // On some systems a pipe is written asynchronously: the announcement leaves first.
            const leave = () => process.exit(code)
            process.stdout.write('', leave)
            setTimeout(leave, 1_000).unref()
        },
    })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void handle.stop(signal))
    // A hangup is meant for a terminal, and this process has none.
    process.on('SIGHUP', () => {})
    // Said once at start, so the first a person hears of the browser is not a refused publish: a
    // publication with Mermaid diagrams or maps cannot be published without one, nor one with
    // diagrams previewed (ADR 0084, ADR 0118).
    void chromiumStatus(process.env, CMD).then((chromium) => {
        if (chromium.executable) return
        console.error(`etherpk-mcp: no browser for diagrams or maps (run: ${chromium.setupCommand}, or set ETHERPK_CHROMIUM) - a publish with Mermaid diagrams or maps, or a theme preview with diagrams, refuses until then.`)
    })
}

/**
 * A local graph folder: no sign-in and no server ([[2026-09-18 Headless Client Serves A Local
 * Folder]]). The folder is what it is; the CLI never creates a skeleton in whatever directory
 * was mistyped. The index lives under the cache root, keyed by the folder's path.
 */
async function openFolderGraph(path: string): Promise<HostedGraph> {
    if (!(await isGraphFolder(path))) {
        throw new Error(`${path} is not an EtherPK graph folder: it has no pages/ and journals/ directories. Open the folder in EtherPK once to make it one, then serve it.`)
    }
    console.error(`etherpk-mcp: opening folder ${path}…`)
    const graph = await openHeadlessFolder({
        adapter: createNodeDirectoryAdapter(path),
        name: basename(path),
        path,
        graphId: folderKey(path),
        persistDir: folderCacheDir(process.env, path),
        embeddingModel: () => loadEmbeddingModel(process.env),
        onSemanticProgress: reportSemanticProgress,
        onError: (error) => console.error(`etherpk-mcp: ${error.message}`),
        onWarning: (line) => console.error(`etherpk-mcp: ${line}`),
        watch: watchFolder(path, (error) => console.error(`etherpk-mcp: not watching the folder for changes (${error.message}) - edits made outside are still picked up before each tool call.`)),
    })
    return hostedGraph(graph)
}

/**
 * A synced graph by id, on a server this machine is logged in to. `named` hears the graph's name
 * from the server's name envelope as soon as the listing has it, which is well before the graph
 * has opened: a session that starts meanwhile is told the name, not the id.
 */
async function openSyncedGraph(syncServer: string, graphId: string, named: (name: string) => void): Promise<HostedGraph> {
    const login = await credentialsFor(selectLogin(await readConfigOrThrow(defaultConfigPath()), syncServer))
    if (!login.vaultKey) throw new Error(`Encryption Keys are not unlocked on this machine for ${login.syncServer}. Run: ${CMD} login --sync-server ${login.syncServer}`)
    const account = await connectAccount(login)
    const vault = await openVaultFor(account, { ...login, vaultKey: login.vaultKey })
    const graphs = await account.api.listGraphs()
    // A graph the server no longer lists for this login (deleted, left, taken away) leaves this
    // machine now rather than at logout: its cache is the graph in plaintext. Against the
    // listing that just succeeded (a failed one threw above and removes nothing), and only
    // caches stamped for this account (another account may share the cache root).
    const swept = await removeUnlistedGraphCaches(process.env, account.serverBaseUrl, account.principal.id, graphs.map((graph) => graph.id)).catch((error: unknown) => {
        console.error(`etherpk-mcp: could not tidy the cache of graphs this server no longer lists: ${describeError(error)}`)
        return [] as string[]
    })
    if (swept.length > 0) {
        console.error(`etherpk-mcp: removed this computer's copy of ${swept.length === 1 ? 'a graph' : `${swept.length} graphs`} ${account.serverBaseUrl} no longer lists for you: ${swept.join(', ')}.`)
    }
    const listed = graphs.find((graph) => graph.id === graphId)
    if (!listed) throw new Error(`No synced graph on ${login.syncServer} is identified by "${graphId}". Run: ${CMD} graphs`)
    const label = await graphLabel(listed, vault).catch(() => null)
    if (label?.kind === 'named') named(label.name)

    const { record, keyring: held } = resolveGraphById(graphs, vault, graphId)
    // The copies of the graph's newest key waiting for this account (ADR 0127), read in memory: a
    // browser of the account collects them into the vault, and this process never writes it.
    const vaultKey = fromBase64Url(login.vaultKey)
    let keyring = await readKeyHandouts(account.api, { vault, principalId: account.principal.id }, held).catch(() => held)
    /** When the relay says the graph moved to a new epoch: the vault as a browser may have updated it, then the copies. */
    const refreshKeyring = async () => {
        const latest = await openAccountVault(account.api, vaultKey)
        const stored = latest.keyrings.find((entry) => entry.graphId === graphId)
        const merged = stored ? mergeKeyringEpochs(keyring, stored) : keyring
        keyring = await readKeyHandouts(account.api, { vault: latest, principalId: account.principal.id }, merged)
    }
    const persistDir = graphCacheDir(process.env, account.serverBaseUrl, graphId)
    await stampGraphCacheOwner(persistDir, account.principal.id)

    console.error(`etherpk-mcp: opening graph ${graphId} on ${account.serverBaseUrl}…`)
    const graph = await openHeadlessGraph({
        graphId,
        rootDocId: record.rootDocId,
        keyring: () => keyring,
        refreshKeyring,
        relayUrl: account.relayUrl,
        token: account.tokenFor(graphId),
        clientUrl: account.clientUrl,
        presenceName: `Agent on ${hostname()}`,
        readyTimeoutMs: 20_000,
        // The cache and index survive between launches, so a restart catches up rather than
        // rebuilding (persistence.ts); logout removes them with the keys.
        persistDir,
        // The encrypted asset store over the same server, for upload_asset / read_asset (ADR 0085).
        assets: { baseUrl: account.serverBaseUrl },
        embeddingModel: () => loadEmbeddingModel(process.env),
        onSemanticProgress: reportSemanticProgress,
        onError: (error) => console.error(`etherpk-mcp: ${error.message}`),
        // One line, once, and the sync loop stops rather than retrying in silence. The tools
        // refuse with a typed error from here on.
        onAccessLost: (loss) =>
            console.error(
                loss.kind === 'membership'
                    ? `etherpk-mcp: ${account.serverBaseUrl} ended this account's access to graph ${graphId}: it left, was removed, or the graph was deleted. Stopped syncing. Run: ${CMD} graphs`
                    : `etherpk-mcp: the token for ${account.serverBaseUrl} was revoked or is no longer valid. Stopped syncing. Run: ${CMD} login --sync-server ${login.syncServer}`,
            ),
        // Serving a graph republishes its name, so a graph only an agent ever opens still
        // labels itself on every device (ADR 0031, amended).
        publishName: createGraphNamePublisher({ api: account.api, keyring: () => keyring, graphId }).publish,
    })
    return hostedGraph(graph)
}

/**
 * The open graph as its host holds it. Semantic search starts with the first session that allows
 * it: a host whose agents all passed --no-semantic, or that runs only a command-line publish,
 * never loads the model.
 */
function hostedGraph(graph: HeadlessGraph): HostedGraph {
    let wanted = false
    return {
        graph,
        wantSemantic() {
            if (wanted) return
            wanted = true
            void startSemantic(graph)
        },
    }
}

/**
 * Semantic search for the graph, off any agent's path: the model loads and the store catches up
 * in the background, and a semantic search meanwhile answers from what is built so far, marked
 * incomplete. On a computer where setup has not run, it starts once setup is found, with no
 * restart; a semantic search before then is refused with the command to run.
 */
async function startSemantic(graph: HeadlessGraph): Promise<void> {
    const start = () =>
        graph
            .semantic()
            .then(async (semantic) => {
                const status = await semantic.status()
                console.error(`etherpk-mcp: semantic search on (${semantic.model.id}) - ${status.embedded} of ${status.total} passages embedded, building the rest in the background.`)
            })
            .catch((error: unknown) => console.error(`etherpk-mcp: semantic search unavailable: ${describeError(error)}`))
    const ready = await semanticSetupStatus(process.env)
    if (ready.runtime && ready.model) {
        void start()
        return
    }
    console.error(`etherpk-mcp: semantic search is not set up on this computer (run: ${CMD} semantic setup - this process will notice within half a minute, no restart needed). Search answers by text only until then.`)
    whenSemanticSetUp(process.env, () => {
        console.error('etherpk-mcp: semantic setup found - loading the model and building the store.')
        void start()
    })
}

/** A host's graph in words: a folder by its path, a synced graph by id and server. */
function describeHostTarget(target: HostTarget): string {
    return target.kind === 'folder' ? `folder ${target.path}` : `graph ${target.graphId} on ${target.server}`
}

/** `running`: the graphs served on this computer, each by its host. */
async function runningCommand(): Promise<void> {
    const hosts = await runningHosts(process.env)
    if (hosts.length === 0) {
        console.log('No graph is being served on this computer.')
        return
    }
    for (const { cacheDir, status } of hosts) {
        const graph = status.graph.state === 'open' ? 'open' : status.graph.state === 'opening' ? 'opening' : `could not be opened: ${status.graph.message ?? 'see the log'}`
        console.log(`"${status.graph.name}" (${describeHostTarget(status.target)})`)
        console.log(`  ${status.sessions === 1 ? '1 agent' : `${status.sessions} agents`} connected, graph ${graph}`)
        console.log(`  process ${status.pid}, version ${status.version}, running since ${status.startedAt}`)
        console.log(`  log: ${hostLogPath(cacheDir)}`)
    }
}

/** `stop`: stop the hosts of one graph, or of all of them. */
async function stopCommand(args: ServeArgs & { all?: boolean }): Promise<void> {
    const folder = args.folder?.trim()
    const wanted = args.graph?.trim()
    const server = args['sync-server']?.trim()
    if ([folder, wanted, args.all].filter(Boolean).length > 1 || (server && !wanted)) {
        fail('stop takes --graph <id or name> (with an optional --sync-server), or --folder <path>, or --all (the default).')
    }
    const path = folder ? resolve(folder) : null
    const serverKey = server ? normaliseSyncServer(server) : null
    const which = ({ status }: { status: HostStatus }) => {
        const target = status.target
        if (path) return target.kind === 'folder' && target.path === path
        if (wanted) {
            if (target.kind !== 'synced' || (serverKey && target.server !== serverKey)) return false
            return target.graphId === wanted || status.graph.name.toLowerCase() === wanted.toLowerCase()
        }
        return true
    }
    const stopped = await stopHosts(process.env, 'stop was run', which)
    if (stopped.length === 0) {
        console.log(path || wanted ? 'That graph is not being served on this computer.' : 'No graph is being served on this computer.')
        return
    }
    for (const host of stopped) {
        console.log(`${host.stopped ? 'Stopped' : 'Could not stop'} the background process of "${host.status.graph.name}" (${describeHostTarget(host.status.target)}, process ${host.status.pid}).`)
    }
    if (stopped.some((host) => !host.stopped)) process.exitCode = 1
}

/**
 * Revoke each login's token on its server and forget its keychain item. A token the server could
 * not revoke (unreachable, or already revoked) is named, so the person can revoke it in the portal.
 */
async function revokeAndForget(logins: Array<{ syncServer: string; stored: StoredLogin }>): Promise<string[]> {
    const store = keychain()
    const notRevoked: string[] = []
    for (const { syncServer, stored } of logins) {
        const credentials = await loginCredentials(syncServer, stored, store).catch(() => null)
        if (!credentials || !(await revokeHeldToken({ syncServer, token: credentials.pat }))) notRevoked.push(syncServer)
        await forgetLoginSecrets(syncServer, stored, store).catch(() => {})
    }
    return notRevoked
}

function revocationNote(notRevoked: string[]): string {
    return notRevoked.length === 0
        ? ' Its token was revoked on the server.'
        : ` The token for ${notRevoked.join(', ')} could not be revoked on the server (it may be offline, or the token already revoked): revoke it on that server's Access tokens page if this machine is not yours to keep.`
}

async function logout(args: { 'sync-server'?: string; all?: boolean }): Promise<void> {
    const path = defaultConfigPath()
    const config = await readConfig(path)
    // Everything, or a file this version cannot read: remove the file and every cached graph.
    // The cached graphs are plaintext; they go with the keys that made them readable.
    //
    // The login goes first, then the graphs' hosts, then their caches. A host flushes its graph as
    // it stops, so a cache removed before it stopped would be written again; and an agent that
    // reconnects finds no login for the server, so no new host starts for the cache to go under.
    if (args.all || !config) {
        const notRevoked = config ? await revokeAndForget(listLogins(config)) : []
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
        })
        await stopHosts(process.env, 'logout')
        await removeCacheRoot(process.env)
        console.log(`Forgot every token and key in ${path} and the cached graphs (and the semantic runtime and model, if set up).${revocationNote(notRevoked)}`)
        return
    }
    const login = requireServer(config, args['sync-server'])
    const notRevoked = await revokeAndForget([login])
    delete config.servers[login.syncServer]
    const last = Object.keys(config.servers).length === 0
    if (last) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
        })
    } else {
        await writeConfig(path, config)
    }
    await stopHosts(process.env, 'logout', last ? undefined : ({ status }) => status.target.kind === 'synced' && status.target.server === login.syncServer)
    if (last) await removeCacheRoot(process.env)
    else await removeServerCache(process.env, login.syncServer)
    console.log(`Forgot the token, Encryption Keys and cached graphs for ${login.syncServer}.${revocationNote(notRevoked)}`)
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            'sync-server': { type: 'string' },
            pat: { type: 'string' },
            code: { type: 'string' },
            'recovery-code': { type: 'boolean' },
            graph: { type: 'string' },
            folder: { type: 'string' },
            'no-semantic': { type: 'boolean' },
            publication: { type: 'string' },
            out: { type: 'string' },
            all: { type: 'boolean' },
            name: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' },
        },
    })
    if (values.version) {
        console.log(VERSION)
        return
    }
    const command = positionals[0]
    if (values.help || !command) {
        console.log(USAGE)
        return
    }
    switch (command) {
        case 'login':
            return login(values)
        case 'graphs':
            return graphsCommand(values)
        case 'serve':
            return serve(values)
        case 'host':
            return hostCommand(values)
        case 'running':
            return runningCommand()
        case 'stop':
            return stopCommand(values)
        case 'logout':
            return logout(values)
        case 'semantic':
            return semanticCommand(positionals[1])
        case 'publish':
            return publishCommand(values)
        case 'diagrams':
            return diagramsCommand(positionals[1])
        default:
            fail(`Unknown command "${command}".\n\n${USAGE}`)
    }
}

main().catch((error: unknown) => {
    fail(`etherpk-mcp: ${error instanceof Error ? error.message : String(error)}`)
})
