import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * `server.json` is the Headless Client's entry in the MCP Registry, which lists MCP servers for
 * agent clients and the directories that read from it. The registry holds no package: it checks
 * that the npm package named here carries the same server name in its `mcpName`, and refuses an
 * entry when the two differ. The release workflow writes the version in before it publishes, so the
 * file carries none of its own.
 */
const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8'))

describe('server.json', () => {
    const server = read('server.json')
    const manifest = read('package.json')

    it('names the server as the npm package does, which is how the registry checks who owns it', () => {
        expect(server.name).toBe('io.github.appsoftwareltd/etherpk')
        expect(manifest.mcpName).toBe(server.name)
    })

    it('points at the npm package, run over stdio', () => {
        expect(server.packages).toHaveLength(1)
        expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: manifest.name, transport: { type: 'stdio' } })
    })

    it('describes the server in the 100 characters the registry allows', () => {
        expect(server.description.length).toBeGreaterThan(0)
        expect(server.description.length).toBeLessThanOrEqual(100)
    })

    it('starts the serve command, with the flags that choose a graph', () => {
        const args = server.packages[0].packageArguments
        expect(args[0]).toEqual({ type: 'positional', value: 'serve' })
        expect(args.filter((arg: { type: string }) => arg.type === 'named').map((arg: { name: string }) => arg.name)).toEqual(['--graph', '--sync-server', '--folder'])
    })

    // The workflow sets both from the release's version. A number kept here would be wrong after
    // the next release.
    it('carries no version of its own', () => {
        expect(server.version).toBe('0.0.0')
        expect(server.packages[0].version).toBe('0.0.0')
    })
})
