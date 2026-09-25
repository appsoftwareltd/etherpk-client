import { mkdir, mkdtemp, open, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MAX_UPLOAD_BYTES, downloadName, readLocalFile, writeDownload } from './headless-assets'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('downloadName', () => {
    it.each([
        ['diagram.png', 'diagram.png'],
        ['Diagram One.png', 'Diagram One.png'],
        ['日本語.png', '日本語.png'],
        ['../../../.bashrc', 'bashrc'],
        ['..\\..\\evil.exe', 'evil.exe'],
        ['/etc/cron.d/job', 'job'],
        ['.env', 'env'],
        ['a\u0000b\nc.txt', 'a_b_c.txt'],
        ['what?<>|*:.png', 'what______.png'],
        ['CON.txt', '_CON.txt'],
        ['nul', '_nul'],
        ['', 'asset'],
        ['...', 'asset'],
        ['/', 'asset'],
    ])('names %j %j', (name, expected) => {
        expect(downloadName(name)).toBe(expected)
    })

    it('keeps a long name short enough for any filesystem, extension included', () => {
        const name = downloadName(`${'x'.repeat(400)}.png`)
        expect(name.length).toBeLessThanOrEqual(120)
        expect(name.endsWith('.png')).toBe(true)
    })
})

describe('writeDownload', () => {
    it('writes inside the directory whatever the stored name says', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-download-'))
        const path = await writeDownload(join(dir, 'downloads'), '../../escaped.png', bytes('x'))
        expect(dirname(path)).toBe(join(dir, 'downloads'))
        expect(existsSync(join(dir, 'escaped.png'))).toBe(false)
    })

    it('never writes over another file, and never through a link', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-download-'))
        const outside = await mkdtemp(join(tmpdir(), 'etherpk-mcp-download-outside-'))
        await writeFile(join(dir, 'a.txt'), 'theirs')
        // A link left where the next download would land, pointing at a file that does not exist yet.
        await symlink(join(outside, 'planted.txt'), join(dir, 'b.txt'))

        const a = await writeDownload(dir, 'a.txt', bytes('mine'))
        const b = await writeDownload(dir, 'b.txt', bytes('mine'))

        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('theirs')
        expect(a).toBe(join(dir, 'a-2.txt'))
        expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
        expect(b).toBe(join(dir, 'b-2.txt'))
        // The same bytes again answer the file already written rather than a third copy.
        expect(await writeDownload(dir, 'a.txt', bytes('mine'))).toBe(a)
        expect((await readdir(dir)).sort()).toEqual(['a-2.txt', 'a.txt', 'b-2.txt', 'b.txt'])
    })
})

describe('readLocalFile', () => {
    const env = (dir: string): NodeJS.ProcessEnv => ({
        ETHERPK_MCP_CACHE_DIR: join(dir, 'cache'),
        ETHERPK_MCP_CONFIG: join(dir, 'config', 'mcp.json'),
    })

    async function fixture() {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-upload-'))
        await mkdir(join(dir, 'cache', 'downloads'), { recursive: true })
        await mkdir(join(dir, 'config'), { recursive: true })
        await mkdir(join(dir, '.ssh'), { recursive: true })
        await writeFile(join(dir, 'photo.png'), 'png')
        await writeFile(join(dir, '.ssh', 'id_ed25519'), 'key')
        await writeFile(join(dir, '.env'), 'SECRET=1')
        await writeFile(join(dir, 'cache', 'local-cache.bin'), 'plaintext')
        await writeFile(join(dir, 'cache', 'downloads', 'read-back.png'), 'png')
        await writeFile(join(dir, 'config', 'mcp.json'), '{"token":"x"}')
        return dir
    }

    it('reads an ordinary file, following a link to one', async () => {
        const dir = await fixture()
        await symlink(join(dir, 'photo.png'), join(dir, 'linked.png'))
        const options = { env: env(dir), downloadsDir: join(dir, 'cache', 'downloads') }
        expect(await readLocalFile(join(dir, 'photo.png'), options)).toMatchObject({ name: 'photo.png' })
        expect(await readLocalFile(join(dir, 'linked.png'), options)).toMatchObject({ name: 'linked.png' })
        // What this graph's own downloads hold came from the graph, so it can go back in.
        expect(await readLocalFile(join(dir, 'cache', 'downloads', 'read-back.png'), options)).toMatchObject({ name: 'read-back.png' })
    })

    it.each([
        ['a directory', (dir: string) => dir, /not a file/],
        ['a hidden file', (dir: string) => join(dir, '.env'), /hidden/],
        ['a file in a hidden folder', (dir: string) => join(dir, '.ssh', 'id_ed25519'), /hidden/],
        ['the Headless Client cache', (dir: string) => join(dir, 'cache', 'local-cache.bin'), /cache/],
        ['the Headless Client config', (dir: string) => join(dir, 'config', 'mcp.json'), /config/],
    ])('refuses %s', async (_label, pathOf, message) => {
        const dir = await fixture()
        await expect(readLocalFile(pathOf(dir), { env: env(dir), downloadsDir: join(dir, 'cache', 'downloads') })).rejects.toThrow(message)
    })

    it('judges a link by the file it leads to', async () => {
        const dir = await fixture()
        await symlink(join(dir, '.ssh', 'id_ed25519'), join(dir, 'innocent.png'))
        await expect(readLocalFile(join(dir, 'innocent.png'), { env: env(dir), downloadsDir: join(dir, 'cache', 'downloads') })).rejects.toThrow(/hidden/)
    })

    it('refuses a file larger than an upload can be, before reading it', async () => {
        const dir = await fixture()
        const big = join(dir, 'big.bin')
        // Sparse: the size is reported without the bytes being written.
        const handle = await open(big, 'w')
        await handle.truncate(MAX_UPLOAD_BYTES + 1)
        await handle.close()
        await expect(readLocalFile(big, { env: env(dir), downloadsDir: join(dir, 'cache', 'downloads') })).rejects.toThrow(/larger than/)
    })
})
