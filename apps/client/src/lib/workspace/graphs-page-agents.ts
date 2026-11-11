/**
 * The Graphs page's Agents tab (ADR 0147): which graphs its picker lists, which one it starts on,
 * and what the shared Agents tab (`AgentsMcpTab.svelte`) is given for the graph chosen. The tab a
 * graph's own Settings shows is the same component, so the page only decides what it is about.
 *
 * Plain data in and out. The page gathers what its servers and its registry know, and passes the
 * actions (sign in, unlock) as callbacks named by the server they act on.
 */
import type { AgentsBlocked, AgentsSignIn, AgentsTabProps } from '#lib/sync/ui/agents-tab.js'
import type { ServerAuthState } from './graph-picker-helpers'

/** One Sync Server the device holds, with its graphs as the Graphs tab lists them. */
export interface AgentsPickerServer {
    origin: string
    host: string
    kind: 'managed' | 'custom'
    /** The address the Headless Client's commands name. */
    serverBaseUrl: string
    authState: ServerAuthState
    /** Signed in, with Encryption Keys that are locked on this device. */
    keysLocked: boolean
    rows: ReadonlyArray<{
        id: string
        /** What the Graphs tab calls the row. */
        label: string
        /** The graph's own name, for its MCP server's name; null when none is known. */
        name: string | null
    }>
}

/** A local graph. `folderName` is null for one kept in the browser, which no agent can reach. */
export interface AgentsPickerLocal {
    id: string
    name: string
    folderName: string | null
    /** The folder's path on this device, when the person has given it. */
    folderPath: string | null
}

/** One option of the picker. `value` is a graph's id, or a signed-out server's stand-in. */
export interface AgentsGraphChoice {
    value: string
    label: string
    /** The heading the option sits under: its server, or Local graphs. */
    group: string
}

const SERVER_PREFIX = 'server:'

/**
 * The picker's options, in the Graphs tab's order: each server's graphs, then the local graphs. A
 * signed-out server hides its graphs, so it gets one option standing in for them, which shows why
 * and offers the way back in.
 */
export function agentsGraphChoices(servers: readonly AgentsPickerServer[], locals: readonly AgentsPickerLocal[]): AgentsGraphChoice[] {
    return [
        ...servers.flatMap((server) => {
            const group = `Synced graphs on ${server.host}`
            if (server.authState === 'signed-out') return [{ value: `${SERVER_PREFIX}${server.origin}`, label: 'Signed out', group }]
            return server.rows.map((row) => ({ value: row.id, label: row.label, group }))
        }),
        ...locals.map((graph) => ({ value: graph.id, label: graph.name, group: 'Local graphs' })),
    ]
}

/** The option to start on: the one chosen before, else the graph opened last, else the first. */
export function chosenAgentsGraph(choices: readonly AgentsGraphChoice[], remembered: string | null, lastOpened: string | null): string | null {
    for (const candidate of [remembered, lastOpened]) {
        if (candidate && choices.some((choice) => choice.value === candidate)) return candidate
    }
    return choices[0]?.value ?? null
}

/** Where the choice is remembered, per browser. A convenience: nothing depends on it. */
export const AGENTS_GRAPH_STORAGE_KEY = 'etherpk:agents-graph'

type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): ChoiceStorage | undefined {
    try {
        return globalThis.localStorage
    } catch {
        // Some browsers throw on access when storage is disabled.
        return undefined
    }
}

export function readAgentsGraph(storage: ChoiceStorage | undefined = browserStorage()): string | null {
    try {
        return storage?.getItem(AGENTS_GRAPH_STORAGE_KEY) ?? null
    } catch {
        return null
    }
}

export function rememberAgentsGraph(value: string, storage: ChoiceStorage | undefined = browserStorage()): void {
    try {
        storage?.setItem(AGENTS_GRAPH_STORAGE_KEY, value)
    } catch {
        /* storage full or refused: the page starts on the last graph opened instead */
    }
}

/** What the page knows and can do, for building the tab's props. */
export interface AgentsTabContext {
    servers: readonly AgentsPickerServer[]
    locals: readonly AgentsPickerLocal[]
    /** What the commands run with `npx`: `headlessClientPackage`. */
    headlessClient: string
    /** This Client offers Managed Sync, so a device with no server signs in to EtherPK. */
    managedOffered: boolean
    actions: {
        /** Sign in to a managed server. */
        signIn(origin: string): void
        /** Give a custom server a new access token. */
        reconnect(origin: string): void
        /** Unlock a server's Encryption Keys on this device. */
        unlock(origin: string): void
        /** With no server held: the EtherPK sign-in, or the form that adds a Sync Server. */
        connect(): void
        /** Ask a managed server for an Agent Setup Code. */
        createSetupCode(origin: string): Promise<{ code: string; expiresAt: string }>
    }
}

function signInTo(server: AgentsPickerServer, context: AgentsTabContext): AgentsSignIn {
    return {
        serverBaseUrl: server.serverBaseUrl,
        headlessClient: context.headlessClient,
        // The managed sign-in makes the code. A custom server's access token may not (ADR 0132).
        createSetupCode: server.kind === 'managed' ? () => context.actions.createSetupCode(server.origin) : null,
    }
}

/** A signed-out server's way back in: the sign-in for Managed Sync, a new token for a custom server. */
function signedOutStep(server: AgentsPickerServer, context: AgentsTabContext): AgentsBlocked['step'] {
    return server.kind === 'managed'
        ? { label: 'Sign in', run: () => context.actions.signIn(server.origin) }
        : { label: 'Add a new access token', run: () => context.actions.reconnect(server.origin) }
}

/**
 * The shared tab's props for the picker's `value`: the graph's own tab, as its Settings shows it,
 * or the reason and the step where its commands would not work yet. Null for a value the list no
 * longer has.
 */
export function agentsTabPropsFor(value: string, context: AgentsTabContext): AgentsTabProps | null {
    if (value.startsWith(SERVER_PREFIX)) {
        const server = context.servers.find((candidate) => `${SERVER_PREFIX}${candidate.origin}` === value)
        if (!server) return null
        return {
            kind: 'blocked',
            reason:
                server.kind === 'managed'
                    ? `You are signed out of ${server.host}, so its synced graphs are hidden. Sign in to see the commands for them.`
                    : `${server.host} did not accept this device's access token, so its synced graphs are hidden. Add a new token to see the commands for them.`,
            step: signedOutStep(server, context),
        }
    }
    for (const server of context.servers) {
        const row = server.rows.find((candidate) => candidate.id === value)
        if (!row) continue
        if (server.keysLocked) {
            return {
                kind: 'blocked',
                reason: `Encryption Keys for ${server.host} are locked on this device. Unlock them to see the commands for this graph.`,
                step: { label: 'Unlock Encryption Keys', run: () => context.actions.unlock(server.origin) },
            }
        }
        return { kind: 'synced', graphId: row.id, graphName: row.name, ...signInTo(server, context) }
    }
    const local = context.locals.find((graph) => graph.id === value)
    if (!local) return null
    if (local.folderName === null) return { kind: 'browser' }
    return { kind: 'local', folderName: local.folderName, folderPath: local.folderPath, headlessClient: context.headlessClient }
}

/**
 * The shared tab's props with no graph to choose: logging an agent in to `server`, the one the
 * page's server picker is on (null when the device holds none), or what stands in the way of that.
 */
export function agentsTabPropsWithoutGraph(server: AgentsPickerServer | null, context: AgentsTabContext): Extract<AgentsTabProps, { kind: 'none' }> {
    if (!server) {
        return {
            kind: 'none',
            signIn: null,
            blocked: context.managedOffered
                ? { reason: 'Sign in with your EtherPK account to reach your synced graphs from an agent.', step: { label: 'Sign in', run: context.actions.connect } }
                : {
                      reason: 'Signing in needs a Sync Server. Add one in the Sync tab to reach your synced graphs from an agent.',
                      step: { label: 'Connect to a Sync Server', run: context.actions.connect },
                  },
        }
    }
    if (server.authState === 'signed-out') {
        return {
            kind: 'none',
            signIn: null,
            blocked: {
                reason:
                    server.kind === 'managed'
                        ? `You are signed out of ${server.host}. Sign in to log an agent in to it.`
                        : `${server.host} did not accept this device's access token. Add a new token to log an agent in to it.`,
                step: signedOutStep(server, context),
            },
        }
    }
    return { kind: 'none', signIn: signInTo(server, context), blocked: null }
}
