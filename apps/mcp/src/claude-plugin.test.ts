import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { describe, expect, it } from 'vitest'

import { CLI_OPTIONS } from './cli-options'
import { graphRequest } from './graph-request'

/**
 * The Claude Code plugin is the `skills/` folder of the etherpk-client repository, listed by the
 * marketplace file at its root. Its manifest, `skills/.claude-plugin/plugin.json`, holds the
 * `etherpk` agent skill, and this package's `serve` command started with the graph the person
 * chose when they installed it. Claude Code puts each option into the arguments as written, and an
 * empty string for one left unset, so every flag is passed on every start and `serve` reads an
 * empty one as not given (`graph-request.ts`).
 */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The marketplace's folder: under public-repos/client here, the root of etherpk-client there. */
const ROOT = ['public-repos/client', '.']
    .map((path) => join(REPO, path))
    .find((path) => existsSync(join(path, '.claude-plugin', 'marketplace.json')))

const marketplace = ROOT ? JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8')) : undefined
/** The plugin's own folder, the marketplace's `source`, which holds its manifest. */
const PLUGIN_ROOT = ROOT && marketplace ? join(ROOT, marketplace.plugins[0].source) : undefined
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

interface UserOption {
    type: string
    title: string
    description: string
}

interface Plugin {
    name: string
    version: string
    skills: string[]
    userConfig: Record<string, UserOption>
    mcpServers: Record<string, { command: string; args: string[] }>
}

const plugin: Plugin | undefined = PLUGIN_ROOT ? JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) : undefined

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
    it('is the one plugin of the marketplace file at the repository root, with a manifest of its own', () => {
        expect(ROOT, '.claude-plugin/marketplace.json').toBeDefined()
        expect(marketplace.name).toBe('etherpk')
        expect(marketplace.plugins).toHaveLength(1)
        expect(marketplace.plugins[0]).toMatchObject({ name: 'etherpk', source: './skills' })
        expect(plugin, 'skills/.claude-plugin/plugin.json').toBeDefined()
        expect(plugin!.name).toBe('etherpk')
    })

    // Anthropic's plugin directory takes a plugin folder with its own manifest, and reads its icon
    // from the folder: a square PNG of 512 to 2048 pixels.
    it('has the icon the plugin directory reads', () => {
        const icon = readFileSync(join(PLUGIN_ROOT!, '.claude-plugin', 'icon.png'))
        expect(icon.subarray(1, 4).toString('latin1')).toBe('PNG')
        const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)]
        expect(width).toBe(height)
        expect(width).toBeGreaterThanOrEqual(512)
        expect(width).toBeLessThanOrEqual(2048)
    })

    it('carries the release version, so Claude Code updates it when a release is out', () => {
        expect(plugin!.version).toBe(manifest.version)
    })

    it('holds the etherpk agent skill', () => {
        expect(plugin!.skills).toEqual(['./etherpk'])
        for (const skill of plugin!.skills) expect(existsSync(join(PLUGIN_ROOT!, skill, 'SKILL.md'))).toBe(true)
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
