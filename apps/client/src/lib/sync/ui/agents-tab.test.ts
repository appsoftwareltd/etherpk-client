import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
    AGENT_TOOLS,
    HEADLESS_CLIENT_PACKAGE,
    diagramsSetupCommand,
    headlessClientPackage,
    loginCommand,
    logoutEverywhereCommand,
    mcpServerName,
    pluginInstallCommand,
    publishCommand,
    registerCommand,
    registerFolderCommand,
    registerNote,
    semanticSetupCommand,
    skillInstallCommand,
    tokensPageUrl,
    unregisterStep,
} from './agents-tab'

const LATEST = HEADLESS_CLIENT_PACKAGE
const noSetupCode = () => Promise.reject(new Error('not asked for in these tests'))

describe('the Agents tab commands', () => {
    it('spell login for the connected server and serve for this graph', () => {
        expect(loginCommand('https://sync.example.test', LATEST, 'epk_setup_abc')).toBe('npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.example.test --code epk_setup_abc')
        expect(registerCommand('codex', 'g-1', 'https://sync.example.test', LATEST, 'Home')).toBe('codex mcp add etherpk-home -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
    })

    // Claude Code keeps a server to the folder the command ran in unless told otherwise, so an agent
    // started in another folder would not have it.
    it('register with Claude Code for every project', () => {
        expect(registerCommand('claude', 'g-1', 'https://sync.example.test/', LATEST, 'Home')).toBe('claude mcp add --scope user etherpk-home -- npx @appsoftwareltd/etherpk-mcp serve --sync-server https://sync.example.test --graph g-1')
        expect(registerFolderCommand('claude', '/home/me/notes', LATEST, 'notes')).toBe('claude mcp add --scope user etherpk-notes -- npx @appsoftwareltd/etherpk-mcp serve --folder /home/me/notes')
    })

    it('give Cursor and unknown tools an MCP JSON block naming the same command', () => {
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerCommand(tool, 'g-1', 'https://sync.example.test', LATEST, 'Home')) as { mcpServers: Record<string, { command: string; args: string[] }> }
            expect(block.mcpServers['etherpk-home']).toEqual({
                command: 'npx',
                args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--sync-server', 'https://sync.example.test', '--graph', 'g-1'],
            })
        }
    })

    // VS Code's mcp.json has its own shape: `servers` at the top, and each server says its type.
    it("give VS Code the block its mcp.json reads", () => {
        expect(JSON.parse(registerCommand('vscode', 'g-1', 'https://sync.example.test', LATEST, 'Home'))).toEqual({
            servers: {
                'etherpk-home': { type: 'stdio', command: 'npx', args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--sync-server', 'https://sync.example.test', '--graph', 'g-1'] },
            },
        })
        expect(JSON.parse(registerFolderCommand('vscode', '/home/me/Field Notes', LATEST, 'Field Notes'))).toEqual({
            servers: { 'etherpk-field-notes': { type: 'stdio', command: 'npx', args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--folder', '/home/me/Field Notes'] } },
        })
    })

    it('spell serve --folder for a folder graph, quoting a path with spaces where a shell reads it', () => {
        expect(registerFolderCommand('codex', '/home/me/Field Notes', LATEST, 'Field Notes')).toBe("codex mcp add etherpk-field-notes -- npx @appsoftwareltd/etherpk-mcp serve --folder '/home/me/Field Notes'")
        for (const tool of ['cursor', 'other'] as const) {
            const block = JSON.parse(registerFolderCommand(tool, '/home/me/Field Notes', LATEST, 'Field Notes')) as { mcpServers: Record<string, { command: string; args: string[] }> }
            // JSON carries the path as one argument, so no quoting is needed or wanted.
            expect(block.mcpServers['etherpk-field-notes']).toEqual({ command: 'npx', args: ['@appsoftwareltd/etherpk-mcp', 'serve', '--folder', '/home/me/Field Notes'] })
        }
        for (const tool of AGENT_TOOLS) expect(registerFolderCommand(tool.id, '/n', LATEST, 'n')).toContain('--folder')
    })

    it('every listed tool has a spelling and a note, and the portal link strips a trailing slash', () => {
        for (const tool of AGENT_TOOLS) {
            expect(registerCommand(tool.id, 'g', 'https://s', LATEST, null)).toContain('etherpk')
            expect(registerNote(tool.id)).not.toBe('')
        }
        expect(AGENT_TOOLS.map((tool) => tool.label)).toContain('VS Code')
        expect(tokensPageUrl('https://sync.example.test/')).toBe('https://sync.example.test/account/tokens')
    })
})

// One user-wide list holds every graph's registration, so a second graph under one fixed name is
// refused ("already exists"). The name also goes into an agent's tool names, which have a limit.
describe('the name a graph is registered under', () => {
    it('comes from the graph, in the letters a tool accepts', () => {
        expect(mcpServerName('Home')).toBe('etherpk-home')
        expect(mcpServerName('Field Notes & Plans!')).toBe('etherpk-field-notes-plans')
        expect(mcpServerName('Caf\u00e9')).toBe('etherpk-cafe')
    })

    it('is plain etherpk when the graph has no name to use', () => {
        expect(mcpServerName(null)).toBe('etherpk')
        expect(mcpServerName('')).toBe('etherpk')
        expect(mcpServerName('\u6587\u6863')).toBe('etherpk')
    })

    it('stays short, with no hyphen left at the end', () => {
        const name = mcpServerName('a very long graph name indeed that goes on')
        expect(name.length).toBeLessThanOrEqual(30)
        expect(name).toBe('etherpk-a-very-long-graph-name')
        expect(mcpServerName('a very long graph name- indeed')).toBe('etherpk-a-very-long-graph-name')
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
        expect(loginCommand('https://sync.example.test', pinned, 'epk_setup_abc')).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 login --sync-server https://sync.example.test --code epk_setup_abc')
        expect(registerCommand('claude', 'g-1', 'https://sync.example.test', pinned, null)).toBe('claude mcp add --scope user etherpk -- npx @appsoftwareltd/etherpk-mcp@0.8.1 serve --sync-server https://sync.example.test --graph g-1')
        const block = JSON.parse(registerCommand('cursor', 'g-1', 'https://sync.example.test', pinned, null)) as { mcpServers: { etherpk: { args: string[] } } }
        expect(block.mcpServers.etherpk.args[0]).toBe('@appsoftwareltd/etherpk-mcp@0.8.1')
        expect(registerFolderCommand('codex', '/n', pinned, 'n')).toBe('codex mcp add etherpk-n -- npx @appsoftwareltd/etherpk-mcp@0.8.1 serve --folder /n')
        expect(semanticSetupCommand(pinned)).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 semantic setup')
        expect(diagramsSetupCommand(pinned)).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 diagrams setup')
        expect(publishCommand({ kind: 'synced', graphId: 'g-1', graphName: null, serverBaseUrl: 'https://s', headlessClient: pinned, createSetupCode: noSetupCode }))
            .toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 publish --sync-server https://s --graph g-1 --publication <publication> --out <folder>')
    })
})

describe('the optional setups and the publish command', () => {
    it('spell the setups once per computer and the publish command for this graph', () => {
        expect(semanticSetupCommand(LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp semantic setup')
        expect(diagramsSetupCommand(LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp diagrams setup')
        expect(publishCommand({ kind: 'synced', graphId: 'g-1', graphName: null, serverBaseUrl: 'https://sync.example.com/', headlessClient: LATEST, createSetupCode: noSetupCode })).toBe(
            'npx @appsoftwareltd/etherpk-mcp publish --sync-server https://sync.example.com --graph g-1 --publication <publication> --out <folder>',
        )
        expect(publishCommand({ kind: 'folder', folderName: 'Notes', folderPath: '/home/me/My Notes', headlessClient: LATEST })).toBe(
            "npx @appsoftwareltd/etherpk-mcp publish --folder '/home/me/My Notes' --publication <publication> --out <folder>",
        )
        // Without a known path there is nothing to spell.
        expect(publishCommand({ kind: 'folder', folderName: 'Notes', folderPath: null, headlessClient: LATEST })).toBeNull()
    })

    // The Agent Skill is installed from the Client's Public Repository by the skills CLI, which
    // finds it at skills/etherpk there.
    it('spell the Agent Skill install from the Public Repository', () => {
        expect(skillInstallCommand()).toBe('npx skills add appsoftwareltd/etherpk-client')
    })
})

// Taking a graph back from an agent is the registration run the other way: the same name, in the
// same list. Every graph out at once is the Headless Client's logout.
describe('removing an agent\'s access', () => {
    it('removes one graph from Claude Code and Codex with their own remove commands, under the name it was added as', () => {
        expect(unregisterStep('claude', 'Home')).toEqual({
            command: 'claude mcp remove --scope user etherpk-home',
            note: "Run this on the agent's device. The agent can no longer use this graph, and keeps the others.",
        })
        expect(unregisterStep('codex', 'Field Notes').command).toBe('codex mcp remove etherpk-field-notes')
        expect(unregisterStep('claude', null).command).toBe('claude mcp remove --scope user etherpk')
    })

    // These tools have no remove command: the person deletes the entry the registration added.
    it('says which entry to delete, and where, for the tools that take a JSON block', () => {
        expect(unregisterStep('cursor', 'Home')).toEqual({ command: null, note: 'Delete the "etherpk-home" entry under mcpServers in ~/.cursor/mcp.json.' })
        expect(unregisterStep('vscode', 'Home')).toEqual({
            command: null,
            note: 'In VS Code, run MCP: Open User Configuration from the Command Palette and delete the "etherpk-home" entry under servers in mcp.json.',
        })
        expect(unregisterStep('other', 'Home').note).toBe('Delete the "etherpk-home" entry where your agent lists its MCP servers.')
    })

    it('spells logout --all with the pinned Headless Client', () => {
        expect(logoutEverywhereCommand(LATEST)).toBe('npx @appsoftwareltd/etherpk-mcp logout --all')
        expect(logoutEverywhereCommand(headlessClientPackage('0.8.1'))).toBe('npx @appsoftwareltd/etherpk-mcp@0.8.1 logout --all')
    })
})

// The EtherPK plugin for Claude Code is installed from the Client's Public Repository, with its
// options set on the command line to this graph. A Client pinned to its own release offers none:
// the plugin always runs the Headless Client npm has as latest.
describe('the Claude Code plugin', () => {
    const synced = { kind: 'synced', graphId: 'g-1', graphName: 'Home', serverBaseUrl: 'https://sync.example.test/', headlessClient: LATEST, createSetupCode: noSetupCode } as const
    const folder = { kind: 'folder', folderName: 'Field Notes', folderPath: '/home/me/Field Notes', headlessClient: LATEST } as const

    it('installs with this synced graph and its Sync Server set', () => {
        expect(pluginInstallCommand(synced)).toBe(
            'claude plugin install etherpk --marketplace appsoftwareltd/etherpk-client --config graph=g-1 --config sync_server=https://sync.example.test',
        )
    })

    it('installs with this folder set, quoted where a shell would split it', () => {
        expect(pluginInstallCommand(folder)).toBe("claude plugin install etherpk --marketplace appsoftwareltd/etherpk-client --config 'graph_folder=/home/me/Field Notes'")
        expect(pluginInstallCommand({ ...folder, folderPath: '/home/me/notes' })).toBe('claude plugin install etherpk --marketplace appsoftwareltd/etherpk-client --config graph_folder=/home/me/notes')
    })

    it('is not offered without a folder path, or by a Client pinned to its own release', () => {
        expect(pluginInstallCommand({ ...folder, folderPath: null })).toBeNull()
        expect(pluginInstallCommand({ ...synced, headlessClient: headlessClientPackage('0.8.1') })).toBeNull()
    })

    // The marketplace file and the plugin's skills/ folder are under public-repos/client here, and at
    // the root of etherpk-client.
    const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url))
    const root = ['public-repos/client', '.'].map((path) => join(REPO, path)).find((path) => existsSync(join(path, '.claude-plugin', 'marketplace.json')))

    it('sets only options the plugin has, under the plugin and marketplace names it is published as', () => {
        expect(root, '.claude-plugin/marketplace.json').toBeDefined()
        const file = JSON.parse(readFileSync(join(root!, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name: string; plugins: { source: string }[] }
        const plugin = JSON.parse(readFileSync(join(root!, file.plugins[0].source, '.claude-plugin', 'plugin.json'), 'utf8')) as { name: string; userConfig: Record<string, unknown> }
        for (const command of [pluginInstallCommand(synced)!, pluginInstallCommand(folder)!]) {
            expect(command).toContain(`claude plugin install ${plugin.name} --marketplace`)
            const keys = [...command.matchAll(/--config '?(\w+)=/g)].map((match) => match[1])
            expect(keys.length).toBeGreaterThan(0)
            for (const key of keys) expect(Object.keys(plugin.userConfig)).toContain(key)
        }
        expect(file.name).toBe('etherpk')
    })
})
