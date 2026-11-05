/**
 * What the Agents tab of the Settings modal needs (ADR 0072, [[Headless Client]]).
 *
 * A module rather than a type inside the component, for the same reason as `mirror-tab.ts`:
 * both the Settings modal and the workspace that fills it name the shape, and a Svelte instance
 * script cannot export a type.
 *
 * The tab says how an agent reaches THIS graph, which depends on the backend (ADR 0070, ADR
 * 0072). A Filesystem Backend graph is a folder, and its `AGENTS.md` is the whole integration,
 * so the tab explains that file and where the folder is; a graph in the browser's private storage
 * is out of an agent's reach, and the tab says so; a synced graph has no folder, so the
 * agent runs the Headless Client on its own machine and the tab shows the two commands that set
 * it up, with this graph's id filled in. Nothing here is a setting. The one secret is a setup
 * code the person asks for (ADR 0132): it works once, for ten minutes, and the login command
 * carries it, so no long-lived token is ever made or shown for an agent.
 *
 * Every command runs the package spec in `headlessClient` (`headlessClientPackage`), which the
 * workspace pins to this Client's release on a self-hosted Client.
 */

// The package and the login spelling are shared with the Sync Server's Access tokens page, which
// prints the same command (headless-client-command.ts in the shared package).
import { headlessClientLoginCommand } from '@appsoftwareltd/etherpk-shared'

export type AgentsTabProps =
    | {
          kind: 'synced'
          /** The synced graph's opaque id - what `serve --graph` names. */
          graphId: string
          /** The graph's name, which its MCP server is registered under; null when it has none. */
          graphName: string | null
          /** The Sync Server origin the Client is connected to, for `--sync-server` and the portal link. */
          serverBaseUrl: string
          /** What the commands run with `npx`: `headlessClientPackage`. */
          headlessClient: string
          /**
           * Ask the Sync Server for an Agent Setup Code over this graph's managed connection.
           * Rejects with a `SyncApiError`. Null on a custom server: this device holds only an
           * access token for it, and a token may not create an Agent Setup Code (ADR 0132), so the
           * tab sends the person to the server's own Access tokens page, which creates one for a
           * signed-in session.
           */
          createSetupCode: (() => Promise<{ code: string; expiresAt: string }>) | null
      }
    | {
          kind: 'local'
          /** The picked folder's leaf name (all a browser handle reveals). */
          folderName: string
          /** The absolute path the user typed for this device (folder-path.ts), or null if none yet. */
          folderPath: string | null
          /** What the commands run with `npx`: `headlessClientPackage`. */
          headlessClient: string
      }
    /** A graph in the browser's private storage, such as the [[Demo Graph]]: no agent can reach it. */
    | { kind: 'browser' }

export { HEADLESS_CLIENT_PACKAGE, headlessClientPackage } from '@appsoftwareltd/etherpk-shared'

export type AgentTool = 'claude' | 'codex' | 'cursor' | 'vscode' | 'other'

export const AGENT_TOOLS: ReadonlyArray<{ id: AgentTool; label: string }> = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'vscode', label: 'VS Code' },
    { id: 'other', label: 'Other' },
]

/** The one-time sign-in on the agent's device, carrying an Agent Setup Code from the tab (ADR 0132). */
export function loginCommand(serverBaseUrl: string, headlessClient: string, setupCode: string): string {
    return headlessClientLoginCommand(serverBaseUrl, headlessClient, setupCode)
}

/** The longest server name: an agent's tool names hold it, and the longest stays within the 64 characters a tool name may have. */
const SERVER_NAME_LIMIT = 30

/**
 * The name a graph's MCP server is registered under. A registration for every project goes in one
 * user-wide list, where a second graph under a fixed name is refused, so the name comes from the
 * graph. Tools take letters, digits, hyphens and underscores. A graph with none of those in its name
 * is plain `etherpk`.
 */
export function mcpServerName(graphName: string | null): string {
    const slug = (graphName ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    if (slug === '') return 'etherpk'
    return `etherpk-${slug}`.slice(0, SERVER_NAME_LIMIT).replace(/-$/, '')
}

/**
 * How each tool is told about one graph's server. Claude Code and Codex have a registration command.
 * Claude Code keeps a server to the folder the command ran in unless told otherwise, so its command
 * asks for every project; Codex has one list already. Cursor and everything else take an MCP JSON
 * block, and VS Code's `mcp.json` has a shape of its own.
 */
function registration(tool: AgentTool, name: string, headlessClient: string, target: { shell: string; args: string[] }): string {
    const serve = `npx ${headlessClient} serve ${target.shell}`
    const server = { command: 'npx', args: [headlessClient, 'serve', ...target.args] }
    switch (tool) {
        case 'claude':
            return `claude mcp add --scope user ${name} -- ${serve}`
        case 'codex':
            return `codex mcp add ${name} -- ${serve}`
        case 'vscode':
            return JSON.stringify({ servers: { [name]: { type: 'stdio', ...server } } }, null, 2)
        case 'cursor':
        case 'other':
            return JSON.stringify({ mcpServers: { [name]: server } }, null, 2)
    }
}

/**
 * The registration for a synced graph. The serve command names the Sync Server as well as the graph,
 * so it stays right on a machine signed in to more than one (ADR 0075).
 */
export function registerCommand(tool: AgentTool, graphId: string, serverBaseUrl: string, headlessClient: string, graphName: string | null): string {
    const server = serverBaseUrl.replace(/\/$/, '')
    return registration(tool, mcpServerName(graphName), headlessClient, {
        shell: `--sync-server ${server} --graph ${graphId}`,
        args: ['--sync-server', server, '--graph', graphId],
    })
}

/** Where the registration goes, and that it reaches every project. */
export function registerNote(tool: AgentTool): string {
    switch (tool) {
        case 'claude':
            return 'Run this on the agent\'s device. Claude Code can then use this graph from any folder.'
        case 'codex':
            return 'Run this on the agent\'s device. Codex can then use this graph from any folder.'
        case 'cursor':
            return 'Add this to ~/.cursor/mcp.json, so that Cursor can use this graph in every project.'
        case 'vscode':
            return 'In VS Code, run MCP: Open User Configuration from the Command Palette and add this to mcp.json, so that every workspace can use this graph.'
        case 'other':
            return 'Add this where your agent lists its MCP servers. Some agents name the top-level key differently.'
    }
}

/** A path as a POSIX shell reads it: bare when it has nothing a shell would split or expand, else single-quoted. */
function shellPath(path: string): string {
    return /^[A-Za-z0-9._/~+=:@%-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`
}

/**
 * The registration for a local graph folder: `serve --folder <path>` in place of the server and
 * graph, since a folder needs no sign-in ([[2026-09-18 Headless Client Serves A Local Folder]]). The
 * path is this device's, from the General tab; the tab shows nothing to copy until it is known.
 */
export function registerFolderCommand(tool: AgentTool, folderPath: string, headlessClient: string, folderName: string): string {
    return registration(tool, mcpServerName(folderName), headlessClient, {
        shell: `--folder ${shellPath(folderPath)}`,
        args: ['--folder', folderPath],
    })
}

/** Where an account-wide Personal Access Token is minted. */
export function tokensPageUrl(serverBaseUrl: string): string {
    return `${serverBaseUrl.replace(/\/$/, '')}/account/tokens`
}

/**
 * The once-per-device setups and the publish command, spelled for this graph
 * ([[2026-09-20 Headless Client Assets Rename And Publishing]]). Shown so a person can hand
 * them to the agent's machine; an agent's tools refuse with the same commands in their message.
 */
export function semanticSetupCommand(headlessClient: string): string {
    return `npx ${headlessClient} semantic setup`
}

/**
 * Installs the `etherpk` Agent Skill into the agent, from the Client's Public Repository, where the
 * skills CLI finds it at `skills/etherpk`. The same for every graph and both backends: it teaches
 * the format and the workflow, and leaves reaching a graph to the commands above.
 */
export function skillInstallCommand(): string {
    return 'npx skills add appsoftwareltd/etherpk-client'
}

/** The Agent Skill's row, as a graph's Agents tab and the Graphs page's both show it. */
export const AGENT_SKILL_ROW = {
    key: 'skill',
    label: 'Add the EtherPK skill to your agent',
    text: skillInstallCommand(),
    note: 'You only need this to have an agent create a new blog, docs or wiki folder, check it and publish it. An agent working on an existing graph gets the format from the MCP server or the AGENTS.md in its folder. Run the command in the project your agent works in, or add -g for every project.',
} as const

/** Installs the browser a publish draws Mermaid with (ADR 0084). */
export function diagramsSetupCommand(headlessClient: string): string {
    return `npx ${headlessClient} diagrams setup`
}

/**
 * Publish from the command line, setting the [[Publish Folder]] the agent's `publish` tool then
 * uses (ADR 0086). `<publication>` and `<folder>` are for the person to fill in: which
 * publication, and where on that machine.
 */
export function publishCommand(props: Exclude<AgentsTabProps, { kind: 'browser' }>): string | null {
    const target = props.kind === 'synced' ? `--sync-server ${props.serverBaseUrl.replace(/\/$/, '')} --graph ${props.graphId}` : props.folderPath ? `--folder ${shellPath(props.folderPath)}` : null
    if (!target) return null
    return `npx ${props.headlessClient} publish ${target} --publication <publication> --out <folder>`
}
