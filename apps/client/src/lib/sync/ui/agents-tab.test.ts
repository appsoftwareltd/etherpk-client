import { describe, expect, it } from 'vitest'

import { AGENT_TOOLS, diagramsSetupCommand, loginCommand, publishCommand, registerCommand, registerFolderCommand, semanticSetupCommand, tokensPageUrl } from './agents-tab'

describe('the Agents tab commands', () => {
    it('spell login for the connected server and serve for this graph', () => {
        expect(loginCommand('https://sync.example.test')).toBe('npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.example.test')
        expect(registerCommand('claude', 'g-1', 'https://sync.example.test/')).toBe('claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
        expect(registerCommand('codex', 'g-1', 'https://sync.example.test')).toBe('codex mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
    })

    it('give Cursor and unknown tools an MCP JSON block naming the same command', () => {
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerCommand(tool, 'g-1', 'https://sync.example.test')) as { mcpServers: { etherpk: { command: string; args: string[] } } }
            expect(block.mcpServers.etherpk).toEqual({
                command: 'npx',
                args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--sync-server', 'https://sync.example.test', '--graph', 'g-1'],
            })
        }
    })

    it('spell serve --folder for a local graph, quoting a path with spaces where a shell reads it', () => {
        expect(registerFolderCommand('claude', '/home/me/notes')).toBe('claude mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder /home/me/notes')
        expect(registerFolderCommand('codex', '/home/me/Field Notes')).toBe("codex mcp add etherpk -- npx @appsoftwareltd/etherpk-mcp serve --folder '/home/me/Field Notes'")
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerFolderCommand(tool, '/home/me/Field Notes')) as { mcpServers: { etherpk: { command: string; args: string[] } } }
            // JSON carries the path as one argument, so no quoting is needed or wanted.
            expect(block.mcpServers.etherpk).toEqual({ command: 'npx', args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--folder', '/home/me/Field Notes'] })
        }
        for (const tool of AGENT_TOOLS) expect(registerFolderCommand(tool.id, '/n')).toContain('--folder')
    })

    it('every listed tool has a spelling, and the portal link strips a trailing slash', () => {
        for (const tool of AGENT_TOOLS) expect(registerCommand(tool.id, 'g', 'https://s')).toContain('etherpk')
        expect(tokensPageUrl('https://sync.example.test/')).toBe('https://sync.example.test/account/tokens')
    })
})

describe('the optional setups and the publish command', () => {
    it('spell the setups once per computer and the publish command for this graph', () => {
        expect(semanticSetupCommand()).toBe('npx @appsoftwareltd/etherpk-mcp semantic setup')
        expect(diagramsSetupCommand()).toBe('npx @appsoftwareltd/etherpk-mcp diagrams setup')
        expect(publishCommand({ kind: 'synced', graphId: 'g-1', serverBaseUrl: 'https://sync.example.com/' })).toBe(
            'npx @appsoftwareltd/etherpk-mcp publish --sync-server https://sync.example.com --graph g-1 --publication <publication> --out <folder>',
        )
        expect(publishCommand({ kind: 'local', folderName: 'Notes', folderPath: '/home/me/My Notes' })).toBe(
            "npx @appsoftwareltd/etherpk-mcp publish --folder '/home/me/My Notes' --publication <publication> --out <folder>",
        )
        // Without a known path there is nothing to spell.
        expect(publishCommand({ kind: 'local', folderName: 'Notes', folderPath: null })).toBeNull()
    })
})
