import { describe, expect, it } from 'vitest'

import {
    AGENT_TOOLS,
    HEADLESS_CLIENT_PACKAGE,
    diagramsSetupCommand,
    headlessClientPackage,
    loginCommand,
    publishCommand,
    registerCommand,
    registerFolderCommand,
    semanticSetupCommand,
    tokensPageUrl,
} from './agents-tab'

const LATEST = HEADLESS_CLIENT_PACKAGE

describe('the Agents tab commands', () => {
    it('spell login for the connected server and serve for this graph', () => {
        expect(loginCommand('https://sync.example.test', LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.example.test')
        expect(registerCommand('claude', 'g-1', 'https://sync.example.test/', LATEST)).toBe('claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
        expect(registerCommand('codex', 'g-1', 'https://sync.example.test', LATEST)).toBe('codex mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
    })

    it('give Cursor and unknown tools an MCP JSON block naming the same command', () => {
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerCommand(tool, 'g-1', 'https://sync.example.test', LATEST)) as { mcpServers: { etherpk: { command: string; args: string[] } } }
            expect(block.mcpServers.etherpk).toEqual({
                command: 'npx',
                args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--sync-server', 'https://sync.example.test', '--graph', 'g-1'],
            })
        }
    })

    it('spell serve --folder for a local graph, quoting a path with spaces where a shell reads it', () => {
        expect(registerFolderCommand('claude', '/home/me/notes', LATEST)).toBe('claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder /home/me/notes')
        expect(registerFolderCommand('codex', '/home/me/Field Notes', LATEST)).toBe("codex mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder '/home/me/Field Notes'")
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerFolderCommand(tool, '/home/me/Field Notes', LATEST)) as { mcpServers: { etherpk: { command: string; args: string[] } } }
            // JSON carries the path as one argument, so no quoting is needed or wanted.
            expect(block.mcpServers.etherpk).toEqual({ command: 'npx', args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--folder', '/home/me/Field Notes'] })
        }
        for (const tool of AGENT_TOOLS) expect(registerFolderCommand(tool.id, '/n', LATEST)).toContain('--folder')
    })

    it('every listed tool has a spelling, and the portal link strips a trailing slash', () => {
        for (const tool of AGENT_TOOLS) expect(registerCommand(tool.id, 'g', 'https://s', LATEST)).toContain('etherpk')
        expect(tokensPageUrl('https://sync.example.test/')).toBe('https://sync.example.test/account/tokens')
    })
})

// A self-hosted Client names its own release, so an agent runs the Headless Client released with
// the Client and the Sync Server the operator chose, not whatever npm has as latest.
describe('a pinned Headless Client', () => {
    const pinned = headlessClientPackage('0.8.1')

    it('names the release, or npm\'s latest when there is none to name', () => {
        expect(pinned).toBe('@appsoftwareltd/etherpk-mcp@0.8.1')
        expect(headlessClientPackage(null)).toBe('@appsoftwareltd/etherpk-mcp')
    })

    it('is what every command runs', () => {
        expect(loginCommand('https://sync.example.test', pinned)).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 login --sync-server https://sync.example.test')
        expect(registerCommand('claude', 'g-1', 'https://sync.example.test', pinned)).toBe('claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp@0.8.1 serve --sync-server https://sync.example.test --graph g-1')
        const block = JSON.parse(registerCommand('cursor', 'g-1', 'https://sync.example.test', pinned)) as { mcpServers: { etherpk: { args: string[] } } }
        expect(block.mcpServers.etherpk.args[0]).toBe('@appsoftwareltd/etherpk-mcp@0.8.1')
        expect(registerFolderCommand('codex', '/n', pinned)).toBe('codex mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp@0.8.1 serve --folder /n')
        expect(semanticSetupCommand(pinned)).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 semantic setup')
        expect(diagramsSetupCommand(pinned)).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 diagrams setup')
        expect(publishCommand({ kind: 'synced', graphId: 'g-1', serverBaseUrl: 'https://s', headlessClient: pinned }))
            .toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 publish --sync-server https://s --graph g-1 --publication <publication> --out <folder>')
    })
})

describe('the optional setups and the publish command', () => {
    it('spell the setups once per computer and the publish command for this graph', () => {
        expect(semanticSetupCommand(LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp semantic setup')
        expect(diagramsSetupCommand(LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp diagrams setup')
        expect(publishCommand({ kind: 'synced', graphId: 'g-1', serverBaseUrl: 'https://sync.example.com/', headlessClient: LATEST })).toBe(
            'npx @appsoftwareltd/etherpk-mcp publish --sync-server https://sync.example.com --graph g-1 --publication <publication> --out <folder>',
        )
        expect(publishCommand({ kind: 'local', folderName: 'Notes', folderPath: '/home/me/My Notes', headlessClient: LATEST })).toBe(
            "npx @appsoftwareltd/etherpk-mcp publish --folder '/home/me/My Notes' --publication <publication> --out <folder>",
        )
        // Without a known path there is nothing to spell.
        expect(publishCommand({ kind: 'local', folderName: 'Notes', folderPath: null, headlessClient: LATEST })).toBeNull()
    })
})
