import { describe, expect, it, vi } from 'vitest'

import {
    AGENTS_GRAPH_STORAGE_KEY,
    agentsGraphChoices,
    agentsTabPropsFor,
    agentsTabPropsWithoutGraph,
    chosenAgentsGraph,
    readAgentsGraph,
    rememberAgentsGraph,
    type AgentsPickerLocal,
    type AgentsPickerServer,
} from './graphs-page-agents'

const managed: AgentsPickerServer = {
    origin: 'https://sync.example.test',
    host: 'sync.example.test',
    kind: 'managed',
    serverBaseUrl: 'https://sync.example.test',
    authState: 'authenticated',
    keysLocked: false,
    rows: [
        { id: 'g-garden', label: 'Garden', name: 'Garden' },
        { id: 'g-unnamed', label: 'Graph g-unname…', name: null },
    ],
}
const custom: AgentsPickerServer = {
    origin: 'https://notes.example.org',
    host: 'notes.example.org',
    kind: 'custom',
    serverBaseUrl: 'https://notes.example.org/',
    authState: 'authenticated',
    keysLocked: false,
    rows: [{ id: 'g-kitchen', label: 'Kitchen', name: 'Kitchen' }],
}
const folder: AgentsPickerLocal = { id: 'l-shed', name: 'Shed', folderName: 'shed-notes', folderPath: '/home/me/shed-notes' }
const inBrowser: AgentsPickerLocal = { id: 'l-attic', name: 'Attic', folderName: null, folderPath: null }

const actions = () => ({
    signIn: vi.fn(),
    reconnect: vi.fn(),
    unlock: vi.fn(),
    connect: vi.fn(),
    createSetupCode: vi.fn(async () => ({ code: 'epk_setup_x', expiresAt: '2026-01-01T00:00:00Z' })),
})
const context = (servers: AgentsPickerServer[], locals: AgentsPickerLocal[] = [], managedOffered = true) => ({
    servers,
    locals,
    headlessClient: '@appsoftwareltd/etherpk-mcp',
    managedOffered,
    actions: actions(),
})

describe("the Graphs page Agents tab's graph picker", () => {
    it('lists each server’s graphs, then the local graphs, in the order the Graphs tab shows them', () => {
        expect(agentsGraphChoices([managed, custom], [folder, inBrowser])).toEqual([
            { value: 'g-garden', label: 'Garden', group: 'Synced graphs on sync.example.test' },
            { value: 'g-unnamed', label: 'Graph g-unname…', group: 'Synced graphs on sync.example.test' },
            { value: 'g-kitchen', label: 'Kitchen', group: 'Synced graphs on notes.example.org' },
            { value: 'l-shed', label: 'Shed', group: 'Local graphs' },
            { value: 'l-attic', label: 'Attic', group: 'Local graphs' },
        ])
    })

    it('stands a signed-out server in for the graphs it hides', () => {
        expect(agentsGraphChoices([{ ...managed, authState: 'signed-out', rows: [] }], [folder])).toEqual([
            { value: 'server:https://sync.example.test', label: 'Signed out', group: 'Synced graphs on sync.example.test' },
            { value: 'l-shed', label: 'Shed', group: 'Local graphs' },
        ])
    })

    it('starts on the graph chosen before, else the one opened last, else the first', () => {
        const choices = agentsGraphChoices([managed], [folder])
        expect(chosenAgentsGraph(choices, 'l-shed', 'g-unnamed')).toBe('l-shed')
        expect(chosenAgentsGraph(choices, 'gone', 'g-unnamed')).toBe('g-unnamed')
        expect(chosenAgentsGraph(choices, null, 'gone')).toBe('g-garden')
        expect(chosenAgentsGraph(choices, null, null)).toBe('g-garden')
        expect(chosenAgentsGraph([], 'l-shed', 'g-garden')).toBeNull()
    })

    it('remembers the choice in this browser, and does without where storage is refused', () => {
        const held = new Map<string, string>()
        const storage = { getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => void held.set(key, value) }
        expect(readAgentsGraph(storage)).toBeNull()
        rememberAgentsGraph('l-shed', storage)
        expect(held.get(AGENTS_GRAPH_STORAGE_KEY)).toBe('l-shed')
        expect(readAgentsGraph(storage)).toBe('l-shed')

        const refused = {
            getItem: () => {
                throw new Error('refused')
            },
            setItem: () => {
                throw new Error('refused')
            },
        }
        expect(readAgentsGraph(refused)).toBeNull()
        expect(() => rememberAgentsGraph('l-shed', refused)).not.toThrow()
    })
})

describe('what the Graphs page Agents tab shows for the chosen graph', () => {
    it('is the synced graph’s own tab: its id, its name, its server and that server’s setup code', async () => {
        const ctx = context([managed, custom])
        const props = agentsTabPropsFor('g-garden', ctx)
        expect(props).toMatchObject({
            kind: 'synced',
            graphId: 'g-garden',
            graphName: 'Garden',
            serverBaseUrl: 'https://sync.example.test',
            headlessClient: '@appsoftwareltd/etherpk-mcp',
        })
        if (props?.kind !== 'synced') throw new Error('expected a synced graph')
        await props.createSetupCode?.()
        expect(ctx.actions.createSetupCode).toHaveBeenCalledWith('https://sync.example.test')

        // A graph with no name yet registers as plain etherpk, as its own tab does.
        expect(agentsTabPropsFor('g-unnamed', ctx)).toMatchObject({ kind: 'synced', graphName: null })
        // A custom server's token may not ask for a setup code (ADR 0132).
        expect(agentsTabPropsFor('g-kitchen', ctx)).toMatchObject({ kind: 'synced', serverBaseUrl: 'https://notes.example.org/', createSetupCode: null })
    })

    it('is the local graph’s own tab for a folder, and says an agent cannot reach a graph kept in the browser', () => {
        const ctx = context([], [folder, inBrowser])
        expect(agentsTabPropsFor('l-shed', ctx)).toEqual({
            kind: 'local',
            folderName: 'shed-notes',
            folderPath: '/home/me/shed-notes',
            headlessClient: '@appsoftwareltd/etherpk-mcp',
        })
        expect(agentsTabPropsFor('l-attic', ctx)).toEqual({ kind: 'browser' })
    })

    it('gives the reason and the unlock in place of commands while the server’s keys are locked here', () => {
        const ctx = context([{ ...managed, keysLocked: true }])
        const props = agentsTabPropsFor('g-garden', ctx)
        expect(props).toMatchObject({
            kind: 'blocked',
            reason: 'Encryption Keys for sync.example.test are locked on this device. Unlock them to see the commands for this graph.',
            step: { label: 'Unlock Encryption Keys' },
        })
        if (props?.kind !== 'blocked') throw new Error('expected a blocked tab')
        props.step?.run()
        expect(ctx.actions.unlock).toHaveBeenCalledWith('https://sync.example.test')
    })

    it('gives the reason and the way back in for a server that is signed out', () => {
        const ctx = context([{ ...managed, authState: 'signed-out', rows: [] }, { ...custom, authState: 'signed-out', rows: [] }])
        const signedOut = agentsTabPropsFor('server:https://sync.example.test', ctx)
        expect(signedOut).toMatchObject({
            kind: 'blocked',
            reason: 'You are signed out of sync.example.test, so its synced graphs are hidden. Sign in to see the commands for them.',
            step: { label: 'Sign in' },
        })
        if (signedOut?.kind !== 'blocked') throw new Error('expected a blocked tab')
        signedOut.step?.run()
        expect(ctx.actions.signIn).toHaveBeenCalledWith('https://sync.example.test')

        const refused = agentsTabPropsFor('server:https://notes.example.org', ctx)
        expect(refused).toMatchObject({
            kind: 'blocked',
            reason: "notes.example.org did not accept this device's access token, so its synced graphs are hidden. Add a new token to see the commands for them.",
            step: { label: 'Add a new access token' },
        })
        if (refused?.kind !== 'blocked') throw new Error('expected a blocked tab')
        refused.step?.run()
        expect(ctx.actions.reconnect).toHaveBeenCalledWith('https://notes.example.org')
    })

    it('is nothing for a value the list no longer has', () => {
        expect(agentsTabPropsFor('gone', context([managed], [folder]))).toBeNull()
        expect(agentsTabPropsFor('server:https://gone.example.net', context([managed]))).toBeNull()
    })
})

describe('what the Graphs page Agents tab shows with no graph', () => {
    it('signs an agent in to the server the device holds', async () => {
        const ctx = context([custom, managed])
        expect(agentsTabPropsWithoutGraph(custom, ctx)).toEqual({
            kind: 'none',
            signIn: { serverBaseUrl: 'https://notes.example.org/', headlessClient: '@appsoftwareltd/etherpk-mcp', createSetupCode: null },
            blocked: null,
        })
        const props = agentsTabPropsWithoutGraph(managed, ctx)
        if (props.kind !== 'none' || !props.signIn) throw new Error('expected a sign-in')
        await props.signIn.createSetupCode?.()
        expect(ctx.actions.createSetupCode).toHaveBeenCalledWith('https://sync.example.test')
    })

    it('says to sign in first where the server is signed out', () => {
        const ctx = context([{ ...managed, authState: 'signed-out' }])
        const props = agentsTabPropsWithoutGraph(ctx.servers[0], ctx)
        expect(props).toMatchObject({
            kind: 'none',
            signIn: null,
            blocked: { reason: 'You are signed out of sync.example.test. Sign in to log an agent in to it.', step: { label: 'Sign in' } },
        })
    })

    it('with no server, offers the EtherPK sign-in where Managed Sync is offered, else the way to a Sync Server', () => {
        const hosted = context([])
        const offered = agentsTabPropsWithoutGraph(null, hosted)
        expect(offered).toMatchObject({
            kind: 'none',
            signIn: null,
            blocked: { reason: 'Sign in with your EtherPK account to reach your synced graphs from an agent.', step: { label: 'Sign in' } },
        })
        if (offered.kind !== 'none') throw new Error('expected no graph')
        offered.blocked?.step?.run()
        expect(hosted.actions.connect).toHaveBeenCalledOnce()

        expect(agentsTabPropsWithoutGraph(null, context([], [], false))).toMatchObject({
            kind: 'none',
            signIn: null,
            blocked: {
                reason: 'Signing in needs a Sync Server. Add one in the Sync tab to reach your synced graphs from an agent.',
                step: { label: 'Connect to a Sync Server' },
            },
        })
    })
})
