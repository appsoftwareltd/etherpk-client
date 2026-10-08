/**
 * What the Agents tab of the Settings modal needs (ADR 0072, [[Headless Client]]).
 *
 * A module rather than a type inside the component, for the same reason as `mirror-tab.ts`:
 * both the Settings modal and the workspace that fills it name the shape, and a Svelte instance
 * script cannot export a type.
 *
 * The tab says how an agent reaches THIS graph, which depends on the backend (ADR 0070, ADR
 * 0072). A Filesystem Backend graph is a folder, and its `AGENTS.md` is the whole integration,
 * so the tab explains that file and where the folder is; a synced graph has no folder, so the
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
          /** The Sync Server origin the Client is connected to, for `--sync-server` and the portal link. */
          serverBaseUrl: string
          /** What the commands run with `npx`: `headlessClientPackage`. */
          headlessClient: string
          /**
           * Ask the Sync Server for a one-time setup code over this graph's managed connection.
           * Rejects with a `SyncApiError` (a 404 from a server that predates setup codes). Null on
           * a custom server: this device holds only an access token for it, and a token may not
           * make a setup code (ADR 0132), so the tab sends the person to the server's own
           * Access tokens page, which makes one for a signed-in session.
           */
          createSetupCode: (() => Promise<{ code: string; expiresAt: string }>) | null
      }
    | {
          kind: 'local'
          /** The picked folder's leaf name (all a browser handle reveals), or null for an OPFS graph. */
          folderName: string | null
          /** The absolute path the user typed for this device (folder-path.ts), or null if none yet. */
          folderPath: string | null
          /** What the commands run with `npx`: `headlessClientPackage`. */
          headlessClient: string
      }

export { HEADLESS_CLIENT_PACKAGE, headlessClientPackage } from '@appsoftwareltd/etherpk-shared'

export type AgentTool = 'claude' | 'codex' | 'cursor' | 'other'

export const AGENT_TOOLS: ReadonlyArray<{ id: AgentTool; label: string }> = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'other', label: 'Other' },
]

/**
 * The one-time sign-in on the agent's machine. With a setup code from the tab (ADR 0132) it is the
 * whole sign-in; without one, `login` asks for an access token from the portal instead.
 */
export function loginCommand(serverBaseUrl: string, headlessClient: string, setupCode?: string): string {
    return headlessClientLoginCommand(serverBaseUrl, headlessClient, setupCode)
}

/**
 * How each tool is told about the server. Claude Code and Codex have a registration command;
 * Cursor and everything else take an MCP JSON block, which is what "other" shows too. The
 * serve command names the Sync Server as well as the graph, so it stays right on a machine
 * signed in to more than one (ADR 0075).
 */
export function registerCommand(tool: AgentTool, graphId: string, serverBaseUrl: string, headlessClient: string): string {
    const server = serverBaseUrl.replace(/\/$/, '')
    const serve = `npx ${headlessClient} serve --sync-server ${server} --graph ${graphId}`
    switch (tool) {
        case 'claude':
            return `claude mcp add etherpk -- ${serve}`
        case 'codex':
            return `codex mcp add etherpk -- ${serve}`
        case 'cursor':
        case 'other':
            return JSON.stringify(
                {
                    mcpServers: {
                        etherpk: { command: 'npx', args: [headlessClient, 'serve', '--sync-server', server, '--graph', graphId] },
                    },
                },
                null,
                2,
            )
    }
}

/** A path as a POSIX shell reads it: bare when it has nothing a shell would split or expand, else single-quoted. */
function shellPath(path: string): string {
    return /^[A-Za-z0-9._/~+=:@%-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`
}

/**
 * How each tool is told about a local graph folder: the same shapes as `registerCommand`, with
 * `serve --folder <path>` in place of the server and graph, since a folder needs no sign-in
 * ([[2026-09-18 Headless Client Serves A Local Folder]]). The path is this device's, from the
 * General tab; the tab shows nothing to copy until it is known.
 */
export function registerFolderCommand(tool: AgentTool, folderPath: string, headlessClient: string): string {
    const serve = `npx ${headlessClient} serve --folder ${shellPath(folderPath)}`
    switch (tool) {
        case 'claude':
            return `claude mcp add etherpk -- ${serve}`
        case 'codex':
            return `codex mcp add etherpk -- ${serve}`
        case 'cursor':
        case 'other':
            return JSON.stringify(
                { mcpServers: { etherpk: { command: 'npx', args: [headlessClient, 'serve', '--folder', folderPath] } } },
                null,
                2,
            )
    }
}

/** Where an account-wide Personal Access Token is minted. */
export function tokensPageUrl(serverBaseUrl: string): string {
    return `${serverBaseUrl.replace(/\/$/, '')}/account/tokens`
}

/**
 * The once-per-computer setups and the publish command, spelled for this graph
 * ([[2026-09-20 Headless Client Assets Rename And Publishing]]). Shown so a person can hand
 * them to the agent's machine; an agent's tools refuse with the same commands in their message.
 */
export function semanticSetupCommand(headlessClient: string): string {
    return `npx ${headlessClient} semantic setup`
}

/** Installs the browser a publish draws Mermaid with (ADR 0084). */
export function diagramsSetupCommand(headlessClient: string): string {
    return `npx ${headlessClient} diagrams setup`
}

/**
 * Publish from the command line, setting the [[Publish Folder]] the agent's `publish` tool then
 * uses (ADR 0086). `<publication>` and `<folder>` are for the person to fill in: which
 * publication, and where on that machine.
 */
export function publishCommand(props: AgentsTabProps): string | null {
    const target = props.kind === 'synced' ? `--sync-server ${props.serverBaseUrl.replace(/\/$/, '')} --graph ${props.graphId}` : props.folderPath ? `--folder ${shellPath(props.folderPath)}` : null
    if (!target) return null
    return `npx ${props.headlessClient} publish ${target} --publication <publication> --out <folder>`
}
