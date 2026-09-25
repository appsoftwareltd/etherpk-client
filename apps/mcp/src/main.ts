/**
 * `etherpk-mcp`: the [[Headless Client]]'s command line (ADR 0072).
 *
 *   etherpk-mcp login  --sync-server <url> [--pat <token>] [--recovery-code]
 *   etherpk-mcp graphs [--sync-server <url>]
 *   etherpk-mcp serve  --graph <id or name> [--sync-server <url>] [--no-semantic]
 *   etherpk-mcp serve  --folder <path> [--no-semantic]
 *   etherpk-mcp logout [--sync-server <url> | --all]
 *   etherpk-mcp semantic setup | status | remove
 *   etherpk-mcp publish (--graph <id or name> | --folder <path>) --publication <id> [--out <dir>]
 *   etherpk-mcp diagrams setup | status
 *
 * One config file holds a login per Sync Server (ADR 0075). `--sync-server` names the one a
 * command means and may be left out while only one is signed in.
 *
 * `serve` speaks MCP over stdio, so everything for the human goes to stderr; stdout belongs
 * to the agent. `login` and `graphs` are interactive and print to stdout.
 */

import { createInterface } from 'node:readline/promises'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { unlink } from 'node:fs/promises'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// Inlined by Vite at build time, so the bundle carries the version and needs no file at runtime.
import pkg from '../package.json'

import { fromBase64Url, toBase64Url } from '$lib/crypto'
import { createGraphNamePublisher } from '$lib/sync/graph-name-envelope'

import { connectAccount, openAccountVault, resolveGraphById, type HeadlessAccount } from './account'
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
} from './config'
import { MODEL, SemanticUnavailable, loadEmbeddingModel, removeSemantic, semanticSetupStatus, setupSemantic, whenSemanticSetUp } from './embedder'
import { watchFolder } from './folder-watch'
import { describeGraphLabel, findGraphByName, resolveGraphLabel, type MetaNameReader } from './graph-labels'
import { readGraphName } from './graph-names'
import { openHeadlessFolder } from './headless-folder'
import { openHeadlessGraph, type HeadlessGraph } from './headless-graph'
import { ApprovalAbandoned, unlockByDeviceApproval, unlockByRecoveryCode } from './login'
import { createMcpServer } from './mcp-server'
import { chromiumStatus, setupDiagrams } from './diagrams'
import { defaultPublishFoldersPath, publishFolderOf, publishGraphKey, readPublishFolders, withPublishFolder, writePublishFolders } from './publish-folders'
import { publish as publishTool } from './publish-tools'
import { ToolError } from './tools'
import { createNodeDirectoryAdapter, isGraphFolder } from './node-directory-adapter'
import { describeGraphStore, folderCacheDir, folderKey, graphCacheDir, listGraphStores, removeCacheRoot, removeServerCache } from './persistence'
import { bindServeLifetime } from './serve-lifetime'

const VERSION: string = pkg.version

/**
 * How the user invokes this program, so every hint is one they can paste. Through npx - the way
 * the Agents tab, the README and the docs all say - the bin is never on their PATH, and an npx
 * run executes out of npm's `_npx` cache; a global install (`npm install -g`) runs from
 * anywhere else and does have `etherpk-mcp` on the PATH, so it gets the short spelling.
 */
const CMD = /[\\/]_npx[\\/]/.test(process.argv[1] ?? '') ? 'npx @appsoftwareltd/etherpk-mcp' : 'etherpk-mcp'

const USAGE = `etherpk-mcp - EtherPK Headless Client (an MCP server over one synced graph)

  ${CMD} login --sync-server <url> [--pat <token>] [--recovery-code]
      Sign this machine in as a device of your account. Prompts for a Personal Access
      Token (an account-wide one, from the Sync Server portal at <url>/account/tokens)
      unless --pat or ETHERPK_PAT is given, then unlocks your keys by Device Approval:
      open EtherPK in a browser signed in to the account with its graphs unlocked and
      confirm the code shown. Press r while waiting, or pass --recovery-code, to type
      your Recovery Code instead (or ETHERPK_RECOVERY_CODE, for a scripted setup).
  ${CMD} graphs [--sync-server <url>]
      List the synced graphs each signed-in account can reach, by name and id.
  ${CMD} serve --graph <id or name> [--sync-server <url>] [--no-semantic]
      Serve one synced graph to an agent over stdio. For Claude Code:
        claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server <url> --graph <id>
      Once "semantic setup" has run on this computer, serve also keeps a search-by-meaning
      store of the graph current (the agent's search tool gains mode: semantic); pass
      --no-semantic to leave it off for this registration.
  ${CMD} serve --folder <path> [--no-semantic]
      Serve a local graph folder the same way: no sign-in, no server. The agent gets search,
      backlinks, tasks and format-safe edits over the folder's markdown, alongside the files
      themselves. Edits made in an editor or by the agent directly are picked up as they land.
      The folder must already be a graph (open it in EtherPK once); its index is kept under
      the cache directory, never in the folder.
  ${CMD} logout [--sync-server <url> | --all]
      Forget that server's token, keys and cached graphs on this machine.
  ${CMD} semantic setup
      Let the agent search by meaning. Installs a ~300 MB native runtime (onnxruntime-node,
      with your npm) and downloads a 23 MB embedding model into the cache directory, once
      per computer. Nothing leaves this computer when the model runs; notes are never sent
      to a service to be embedded.
  ${CMD} semantic status | remove
      Whether it is set up here, or delete it (logout --all deletes it too).
  ${CMD} publish (--graph <id or name> | --folder <path>) --publication <id> [--out <dir>]
      Publish one publication of a graph to a folder on this machine and print the report.
      --out sets the publish folder for that graph and publication and is remembered: from
      then on this command without --out, and the agent's publish tool, write to the same
      folder (the agent cannot choose one). The folder's owned files (.html at the top,
      assets/, theme/, the search, feed and report files) are rewritten and their strays
      removed; everything else in it is left alone. Publishing writes files; deploying them
      (a git push, say) is yours. Run it from cron for a site that republishes itself.
  ${CMD} diagrams setup
      Let a publish draw Mermaid diagrams. Downloads a Chromium (about 170 MB) into the cache
      directory with Playwright's installer, once per computer; a publish whose pages hold
      diagrams refuses until this has run. Set ETHERPK_CHROMIUM=<path> to use a browser
      already on this machine instead (NixOS needs this).
  ${CMD} diagrams status
      Which browser a publish would use, if any.

This machine can be signed in to several Sync Servers at once; --sync-server says which one
a command means, and can be left out while only one is signed in. The config file is
${defaultConfigPath()} (override with
ETHERPK_MCP_CONFIG); cached graphs live under ~/.cache/etherpk/mcp (override with
ETHERPK_MCP_CACHE_DIR).
Docs: https://docs.etherpk.com/using-ai-agents-with-your-notes
`

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

async function ask(question: string, { secret = false } = {}): Promise<string> {
    if (!process.stdin.isTTY) fail(`${question} - no terminal to ask on; pass it as an option.`)
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
    if (!config) fail(`${path} is not a config file this version understands. Run: ${CMD} login --sync-server <url> (it will be rewritten; nothing else is affected).`)
    return config
}

/** The login a command means, or the reason there is none - in words the user can act on. */
function requireServer(config: HeadlessConfig, wanted: string | undefined): ServerCredentials {
    const selection: ServerSelection = selectServer(config, wanted)
    if (selection.ok) return selection.credentials
    switch (selection.reason) {
        case 'none':
            return fail(`Not logged in on this machine. Run: ${CMD} login --sync-server <url>`)
        case 'unknown':
            return fail(`Not logged in to ${selection.syncServer}. Signed in to: ${selection.known.join(', ') || '(none)'}. Run: ${CMD} login --sync-server ${selection.syncServer}`)
        case 'ambiguous':
            return fail(`Signed in to more than one Sync Server here: ${selection.known.join(', ')}. Say which with --sync-server <url>.`)
    }
}

async function login(args: { 'sync-server'?: string; pat?: string; 'recovery-code'?: boolean }): Promise<void> {
    const path = defaultConfigPath()
    // A file this version cannot read is replaced, not refused: the old shape held one login,
    // and the user is about to make one.
    const config = (await readConfig(path)) ?? emptyConfig()
    const known = Object.keys(config.servers)
    const syncServer = normaliseSyncServer(args['sync-server'] ?? (known.length === 1 ? known[0] : await ask('Sync Server URL: ')))
    if (!/^https?:\/\//.test(syncServer)) fail('The Sync Server must be an http(s) URL.')
    const pat = args.pat ?? process.env.ETHERPK_PAT ?? (await ask(`Personal Access Token (account-wide, from ${syncServer}/account/tokens): `, { secret: true }))
    if (!pat) fail('A Personal Access Token is required.')

    const account = await connectAccount({ syncServer, pat })
    console.log(`Signed in to ${syncServer} as ${account.principal.email ?? account.principal.name ?? account.principal.id}.`)

    // ETHERPK_RECOVERY_CODE serves a box set up by a script, where there is no terminal to type
    // into and no tab to approve from; the variable is read once and never written anywhere.
    const byRecoveryCode = async () =>
        unlockByRecoveryCode(account.api, process.env.ETHERPK_RECOVERY_CODE ?? (await ask('Recovery Code: ', { secret: true })))
    const vaultKey = args['recovery-code'] ? await byRecoveryCode() : await approveOrFallBack(account, byRecoveryCode)
    config.servers[syncServer] = { pat, vaultKey: toBase64Url(vaultKey) }
    await writeConfig(path, config)
    console.log(`Keys unlocked and cached in ${path} (owner-only). Anyone who can read your files on this machine can read this account, as with a signed-in browser.`)
    const others = Object.keys(config.servers).filter((server) => server !== syncServer)
    if (others.length > 0) console.log(`Also signed in to ${others.join(', ')}; commands now need --sync-server <url> to say which.`)

    await listGraphs({ syncServer, pat, vaultKey: toBase64Url(vaultKey) }, others.length > 0)
}

/**
 * Device Approval, with the Recovery Code one keypress away: a user who has no unlocked EtherPK
 * to hand should not have to Ctrl-C and re-read the help to find `--recovery-code`. On a
 * terminal, `r` during the wait abandons the approval (cancelled server-side) and asks for the
 * code instead; without a terminal the wait runs to its outcome.
 */
async function approveOrFallBack(
    account: Awaited<ReturnType<typeof connectAccount>>,
    byRecoveryCode: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
    const abort = new AbortController()
    const io = {
        say: (line: string) => console.log(line),
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        signal: abort.signal,
        clientUrl: account.clientUrl,
    }
    const stdin = process.stdin
    const interactive = stdin.isTTY === true
    const onKey = (chunk: Buffer) => {
        const key = chunk.toString('utf8')
        if (key === 'r' || key === 'R') abort.abort()
        if (key === '\u0003') {
            console.log('')
            process.exit(130)
        }
    }
    if (interactive) {
        console.log('(Press r to type your Recovery Code instead.)')
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onKey)
    }
    // The key listener comes off BEFORE the Recovery Code prompt runs: that prompt takes the
    // terminal into raw mode itself, and a finally that reset it afterwards ate the code.
    let abandoned = false
    try {
        return await unlockByDeviceApproval(account.api, io)
    } catch (error) {
        if (!(error instanceof ApprovalAbandoned)) throw error
        abandoned = true
    } finally {
        if (interactive) {
            stdin.off('data', onKey)
            stdin.setRawMode(false)
            stdin.pause()
        }
    }
    if (!abandoned) throw new Error('unreachable')
    console.log('Approval cancelled; unlocking with your Recovery Code instead.')
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
    for (const login of logins) await listGraphs(login, logins.length > 1)
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

async function listGraphs(login: ServerCredentials, several: boolean): Promise<void> {
    if (!login.vaultKey) fail(`Keys are not unlocked on this machine for ${login.syncServer}. Run: ${CMD} login --sync-server ${login.syncServer}`)
    const account = await connectAccount(login)
    const vault = await openAccountVault(account.api, fromBase64Url(login.vaultKey))
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
            console.log(status.runtime && status.model ? 'Semantic search is set up; serve uses it unless started with --no-semantic.' : `Not set up. Run: ${CMD} semantic setup`)
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
            if (status.executable) console.log(`Chromium: ${status.executable} (${status.source === 'env' ? 'from ETHERPK_CHROMIUM' : 'installed by diagrams setup'}). A publish can draw Mermaid diagrams.`)
            else console.log(status.source === 'env' ? `ETHERPK_CHROMIUM is set but names no file: ${process.env.ETHERPK_CHROMIUM}` : `No browser is set up. Run: ${status.setupCommand}`)
            return
        }
        default:
            fail(`diagrams needs one of: setup, status.\n\n${USAGE}`)
    }
}

/**
 * Publish from the command line: the same tool the agent has, over a graph opened for the
 * duration of the command (ADR 0086). `--out` is how a person sets the Publish Folder; the
 * tool never takes one.
 */
async function publishCommand(args: ServeArgs & { publication?: string; out?: string }): Promise<void> {
    const folder = args.folder?.trim()
    const wanted = args.graph?.trim()
    if (folder && (wanted || args['sync-server'])) fail('publish takes either --folder <path> or --graph <id or name> (with an optional --sync-server), not both.')
    if (!folder && !wanted) fail('publish needs --graph <id or name>, or --folder <path> for a local graph folder.')
    const publication = args.publication?.trim()
    if (!publication) fail('publish needs --publication <id>. The agent\'s list_publications tool, or Settings → Publish in EtherPK, shows the ids.')
    const quiet = { ...args, 'no-semantic': true }
    const { graph, graphName } = folder ? await openFolderForServe(folder, quiet) : await openSyncedForServe(wanted!, quiet)
    try {
        const configPath = defaultPublishFoldersPath(process.env)
        const key = publishGraphKey(graph.backend, graph.graphId)
        if (args.out?.trim()) {
            const out = resolve(args.out.trim())
            await writePublishFolders(configPath, withPublishFolder(await readPublishFolders(configPath), key, publication, out))
            console.error(`etherpk-mcp: publish folder for "${publication}" of "${graphName}" set to ${out} (remembered in ${configPath}).`)
        } else if (!publishFolderOf(await readPublishFolders(configPath), key, publication)) {
            fail(`No publish folder is set for "${publication}" of "${graphName}" on this machine. Pass --out <dir> once; it is remembered.`)
        }
        const result = await publishTool(graph, { id: publication }, { env: process.env, cmd: CMD })
        console.log(JSON.stringify(result, null, 2))
        if (!result.ok) process.exitCode = 1
    } catch (error) {
        if (error instanceof ToolError) fail(`etherpk-mcp: ${error.message}`)
        throw error
    } finally {
        await graph.dispose().catch(() => {})
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

/**
 * The embedding model for a serve, whichever backend: refused with the reason when the agent's
 * registration turned it off, else loaded on first semantic use. Always wired, so a semantic
 * search on a machine without setup is refused with the command to run - and once it has run,
 * the next search loads the model with no restart.
 */
function embeddingModelFor(args: ServeArgs): () => Promise<Awaited<ReturnType<typeof loadEmbeddingModel>>> {
    return args['no-semantic']
        ? () => Promise.reject(new SemanticUnavailable('Semantic search is off for this agent: serve was started with --no-semantic.'))
        : () => loadEmbeddingModel(process.env)
}

async function serve(args: ServeArgs): Promise<void> {
    const folder = args.folder?.trim()
    const wanted = args.graph?.trim()
    if (folder && (wanted || args['sync-server'])) fail('serve takes either --folder <path> or --graph <id or name> (with an optional --sync-server), not both.')
    if (!folder && !wanted) fail('serve needs --graph <id or name>, or --folder <path> for a local graph folder.')
    const { graph, graphName } = folder ? await openFolderForServe(folder, args) : await openSyncedForServe(wanted!, args)
    await serveGraph(graph, graphName, args)
}

/**
 * A local graph folder: no sign-in and no server ([[2026-09-18 Headless Client Serves A Local
 * Folder]]). The folder is what it is; the CLI never creates a skeleton in whatever directory
 * was mistyped. The index lives under the cache root, keyed by the folder's path.
 */
async function openFolderForServe(folder: string, args: ServeArgs): Promise<{ graph: HeadlessGraph; graphName: string }> {
    const path = resolve(folder)
    if (!(await isGraphFolder(path))) {
        fail(`${path} is not an EtherPK graph folder: it has no pages/ and journals/ directories. Open the folder in EtherPK once to make it one, then serve it.`)
    }
    const name = basename(path)
    console.error(`etherpk-mcp: opening folder ${path}…`)
    const graph = await openHeadlessFolder({
        adapter: createNodeDirectoryAdapter(path),
        name,
        path,
        graphId: folderKey(path),
        persistDir: folderCacheDir(process.env, path),
        embeddingModel: embeddingModelFor(args),
        onSemanticProgress: reportSemanticProgress,
        onError: (error) => console.error(`etherpk-mcp: ${error.message}`),
        onWarning: (line) => console.error(`etherpk-mcp: ${line}`),
        watch: watchFolder(path, (error) => console.error(`etherpk-mcp: not watching the folder for changes (${error.message}); edits made outside are still picked up before each tool call.`)),
    })
    return { graph, graphName: name }
}

async function openSyncedForServe(wanted: string, args: ServeArgs): Promise<{ graph: HeadlessGraph; graphName: string }> {
    const login = requireServer(await loadConfig(defaultConfigPath()), args['sync-server'])
    if (!login.vaultKey) fail(`Keys are not unlocked on this machine for ${login.syncServer}. Run: ${CMD} login --sync-server ${login.syncServer}`)
    const account = await connectAccount(login)
    const vault = await openAccountVault(account.api, fromBase64Url(login.vaultKey))
    const graphs = await account.api.listGraphs()

    // By id first; else by name - the server's name envelope, or one read of the root
    // document for a graph without one (graph-labels.ts).
    let graphId = graphs.find((graph) => graph.id === wanted)?.id
    let graphName: string | null = null
    if (!graphId) {
        const match = await findGraphByName(graphs, vault, wanted, metaNameReader(account))
        if (match) {
            graphId = match.record.id
            graphName = match.name
        }
    }
    if (!graphId) fail(`No synced graph on ${login.syncServer} is named or identified by "${wanted}". Run: ${CMD} graphs`)
    const { record, keyring } = resolveGraphById(graphs, vault, graphId)

    console.error(`etherpk-mcp: opening graph ${graphId} on ${account.serverBaseUrl}…`)
    const graph = await openHeadlessGraph({
        graphId,
        rootDocId: record.rootDocId,
        keyring,
        relayUrl: account.relayUrl,
        token: account.tokenFor(graphId),
        presenceName: `Agent on ${hostname()}`,
        readyTimeoutMs: 20_000,
        // The cache and index survive between launches, so a restart catches up rather than
        // rebuilding (persistence.ts); logout removes them with the keys.
        persistDir: graphCacheDir(process.env, account.serverBaseUrl, graphId),
        // The encrypted asset store over the same server, for upload_asset / read_asset (ADR 0085).
        assets: { baseUrl: account.serverBaseUrl },
        embeddingModel: embeddingModelFor(args),
        onSemanticProgress: reportSemanticProgress,
        onError: (error) => console.error(`etherpk-mcp: ${error.message}`),
        // Serving a graph republishes its name, so a graph only an agent ever opens still
        // labels itself on every device (ADR 0031, amended).
        publishName: createGraphNamePublisher({ api: account.api, keyring, graphId }).publish,
    })
    return { graph, graphName: graphName ?? graph.name }
}

/** Speak MCP over stdio for an open graph until the transport closes or a signal arrives. */
async function serveGraph(graph: HeadlessGraph, graphName: string, args: ServeArgs): Promise<void> {
    // Semantic mode is on whenever setup has been done here and not declined: a text-only agent
    // on a machine that never ran setup pays nothing, and one that did asked for it.
    const semanticReady = await semanticSetupStatus(process.env)
    const semanticOn = !args['no-semantic'] && semanticReady.runtime && semanticReady.model
    const server = createMcpServer(graph, { graphName, version: VERSION, cmd: CMD })
    const transport = new StdioServerTransport()
    // Bound before connect, which follows at once: the transport's close has to reach the SDK's
    // own wrapper of it, and the first byte on stdin is then read by the lifetime and the
    // transport in the same event (serve-lifetime.ts).
    bindServeLifetime({
        signals: process,
        stdin: process.stdin,
        transportClosed: (listener) => {
            transport.onclose = listener
        },
        async shutdown(end) {
            console.error(`etherpk-mcp: ${end}; flushing and exiting.`)
            await graph.settle().catch(() => {})
            await graph.dispose().catch(() => {})
            process.exit(0)
        },
    })
    await server.connect(transport)
    console.error(`etherpk-mcp: serving "${graphName}" over stdio as "Agent on ${hostname()}".`)
    // Said once at start, as for semantic search, so the first a person hears of the browser is
    // not a refused publish: a publication with Mermaid diagrams cannot be published or previewed
    // without one (ADR 0084). Off the agent's path; the tools check again when they need it.
    void chromiumStatus(process.env, CMD).then((chromium) => {
        if (chromium.executable) return
        console.error(`etherpk-mcp: no browser for diagrams (run: ${chromium.setupCommand}, or set ETHERPK_CHROMIUM); a publish or theme preview with Mermaid diagrams refuses until then.`)
    })
    // Off the agent's path: the model loads and the store catches up in the background, and a
    // semantic search meanwhile answers from what is built so far, marked incomplete.
    const startSemantic = () =>
        graph
            .semantic()
            .then(async (semantic) => {
                const status = await semantic.status()
                console.error(`etherpk-mcp: semantic search on (${semantic.model.id}); ${status.embedded} of ${status.total} passages embedded, building the rest in the background.`)
            })
            .catch((error: unknown) => console.error(`etherpk-mcp: semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`))
    if (semanticOn) {
        void startSemantic()
    } else if (!args['no-semantic']) {
        console.error(`etherpk-mcp: semantic search is not set up on this computer (run: ${CMD} semantic setup; this process will notice within half a minute, no restart needed); search answers by text only until then.`)
        // Setup run while this process serves is noticed and acted on, so the store is building
        // by the time the agent first asks by meaning - and a search before then loads it anyway.
        whenSemanticSetUp(process.env, () => {
            console.error('etherpk-mcp: semantic setup found; loading the model and building the store.')
            void startSemantic()
        })
    }
}

async function logout(args: { 'sync-server'?: string; all?: boolean }): Promise<void> {
    const path = defaultConfigPath()
    const config = await readConfig(path)
    // Everything, or a file this version cannot read: remove the file and every cached graph.
    // The cached graphs are plaintext; they go with the keys that made them readable.
    if (args.all || !config) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
        })
        await removeCacheRoot(process.env)
        console.log(`Forgot every token and key in ${path} and the cached graphs (and the semantic runtime and model, if set up). Revoke the Personal Access Tokens in each Sync Server portal too if this machine is not yours to keep.`)
        return
    }
    const login = requireServer(config, args['sync-server'])
    delete config.servers[login.syncServer]
    await removeServerCache(process.env, login.syncServer)
    if (Object.keys(config.servers).length === 0) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
        })
        await removeCacheRoot(process.env)
    } else {
        await writeConfig(path, config)
    }
    console.log(`Forgot the token, keys and cached graphs for ${login.syncServer}. Revoke the Personal Access Token in its portal too if this machine is not yours to keep.`)
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            'sync-server': { type: 'string' },
            pat: { type: 'string' },
            'recovery-code': { type: 'boolean' },
            graph: { type: 'string' },
            folder: { type: 'string' },
            'no-semantic': { type: 'boolean' },
            publication: { type: 'string' },
            out: { type: 'string' },
            all: { type: 'boolean' },
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
