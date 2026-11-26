import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { describe, expect, it } from 'vitest'

import { CLI_OPTIONS } from './cli-options'
import { graphRequest } from './graph-request'

/**
 * The Claude Code plugin is a marketplace file at the root of the etherpk-client repository. Its one
 * plugin is the `skills/` folder: the `etherpk` agent skill, and this package's `serve` command
 * started with the graph the person chose when they installed it. Claude Code puts each option
 * into the arguments as written, and an empty string for one left unset, so every flag is passed
 * on every start and `serve` reads an empty one as not given (`graph-request.ts`).
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The marketplace's folder: under public-repos/client here, the root of etherpk-client there. */
const ROOT = ['public-repos/client', '.']
    .map((path) => join(REPO, path))
    .find((path) => existsSync(join(path, '.claude-plugin', 'marketplace.json')))

const marketplace = ROOT ? JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) : undefined
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

interface UserOption {
    type: string
    title: string
    description: string
}

interface Plugin {
    name: string
    version: string
    source: string
    skills: string[]
    userConfig: Record<string, UserOption>
    mcpServers: Record<string, { command: string; args: string[] }>
}

const plugin: Plugin | undefined = marketplace?.plugins?.[0]

/** The arguments Claude Code starts the server with, for the options a person set. */
function startArguments(values: Record<string, string>): string[] {
    return plugin!.mcpServers.etherpk.args.map((arg) => arg.replace(/\$\{user_config\.(\w+)\}/g, (_, key: string) => values[key] ?? ''))
}

/** What `serve` makes of those arguments, through the parser and the check the command line uses. */
function served(values: Record<string, string>) {
    const { values: flags, positionals } = parseArgs({ args: startArguments(values).slice(1), allowPositionals: true, options: CLI_OPTIONS })
    expect(positionals).toEqual(['serve'])
    return graphRequest('serve', flags)
}

describe('the Claude Code plugin', () => {
    it('is the one plugin of the marketplace file at the repository root', () => {
        expect(ROOT, '.claude-plugin/marketplace.json').toBeDefined()
        expect(marketplace.name).toBe('etherpk')
        expect(marketplace.plugins).toHaveLength(1)
        expect(plugin!.name).toBe('etherpk')
    })

    it('carries the release version, so Claude Code updates it when a release is out', () => {
        expect(plugin!.version).toBe(manifest.version)
    })

    it('holds the etherpk agent skill', () => {
        expect(plugin!.skills).toEqual(['./etherpk'])
        for (const skill of plugin!.skills) expect(existsSync(join(ROOT!, plugin!.source, skill, 'SKILL.md'))).toBe(true)
    })

    it('starts this package from npm, with the serve command', () => {
        const server = plugin!.mcpServers.etherpk
        expect(server.command).toBe('npx')
        expect(server.args.slice(0, 2)).toEqual([manifest.name, 'serve'])
    })

    it('asks only for options that it passes to the server', () => {
        const used = [...plugin!.mcpServers.etherpk.args.join(' ').matchAll(/\$\{user_config\.(\w+)\}/g)].map((match) => match[1])
        expect(used.sort()).toEqual(Object.keys(plugin!.userConfig).sort())
        for (const option of Object.values(plugin!.userConfig)) {
            expect(option.title.length).toBeGreaterThan(0)
            expect(option.description.length).toBeGreaterThan(0)
        }
    })

    it('serves the synced graph a person names', () => {
        expect(served({ graph: 'Garden' })).toEqual({ kind: 'synced', wanted: 'Garden', server: undefined })
        expect(served({ graph: 'Garden', sync_server: 'https://sync.example.com' })).toEqual({ kind: 'synced', wanted: 'Garden', server: 'https://sync.example.com' })
    })

    it('serves the graph folder a person chooses', () => {
        expect(served({ graph_folder: '/notes/kitchen' })).toEqual({ kind: 'folder', path: '/notes/kitchen' })
    })

    it('says what is wrong when a person sets neither, or both', () => {
        expect(() => served({})).toThrow('needs --graph')
        expect(() => served({ graph: 'Garden', graph_folder: '/notes/kitchen' })).toThrow('not both')
    })
})
