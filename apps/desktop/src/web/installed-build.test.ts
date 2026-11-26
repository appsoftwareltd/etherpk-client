import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InstalledBuild } from './installed-build.ts'

let dir: string
let build: InstalledBuild
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'etherpk-build-'))
    const files = {
        'index.html': '<p>shell', 'csp.txt': "default-src 'self'\n", '_app/immutable/a.js': 'a', '_app/immutable/a.js.map': 'map', '_app/env.js': 'env', 'sub/b.wasm': 'b',
        '__etherpk-ebook/reader.html': 'reader', '__etherpk-ebook/reader.html.csp.txt': "default-src 'none'", 'a name.png': 'png',
    }
    await writeFile(join(dir, '..', 'etherpk-outside.txt'), 'outside')
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), text)
    }
    build = await InstalledBuild.open(dir)
})
afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(join(dir, '..', 'etherpk-outside.txt'), { force: true })
})

const ask = (path: string, navigation = false, method = 'GET') => build.answer({ method, url: `app://etherpk${path}`, navigation })
const header = async (path: string, name: string, navigation = false) => (await ask(path, navigation)).headers.get(name)

describe('the Installed Build', () => {
    it('answers a file with its type, and no sniffing', async () => {
        expect(await (await ask('/_app/immutable/a.js')).text()).toBe('a')
        expect(await header('/_app/immutable/a.js', 'content-type')).toBe('text/javascript; charset=utf-8')
        expect(await header('/sub/b.wasm', 'content-type')).toBe('application/wasm')
        expect(await header('/a%20name.png', 'content-type')).toBe('image/png')
        expect(await header('/sub/b.wasm', 'x-content-type-options')).toBe('nosniff')
        expect(await header('/_app/immutable/a.js', 'cache-control')).toContain('immutable')
        expect(await header('/_app/env.js', 'cache-control')).toBe('no-cache')
    })
    it('answers a navigation to the Client’s addresses with the shell and its policy', async () => {
        for (const path of ['/', '/graphs', '/graph/folder/Notes/d/My%20Page', '/share?text=x', '/graph/sync/1/d/v1.2', '/folder/Recipes/f/soup.md', '/g/1/d/a.js']) {
            const answer = await ask(path, true)
            expect([path, answer.status, await answer.text()]).toEqual([path, 200, '<p>shell'])
            expect(answer.headers.get('content-security-policy')).toBe("default-src 'self'")
        }
    })
    it('gives a page with a policy of its own that policy', async () => {
        expect(await header('/__etherpk-ebook/reader.html', 'content-security-policy', true)).toBe("default-src 'none'")
    })
    it('answers 404 to what is not there, and never with the shell', async () => {
        for (const [path, navigation] of [['/graphs', false], ['/missing.js', false], ['/_app/missing.js', true], ['/api/extensions/directory', true], ['/auth/login', true], ['/__etherpk-preview/1/', true], ['/_app/immutable/a.js.map', false], ['/csp.txt', false], ['/__etherpk-ebook/reader.html.csp.txt', false], ['/%E0%A4', true]] as const) {
            expect([path, (await ask(path, navigation)).status]).toEqual([path, 404])
        }
        // A method that writes is refused as Android refuses it, with the answer every shell gives (installedAnswer).
        expect((await ask('/graphs', true, 'POST')).status).toBe(405)
    })
    it('property: nothing outside the build is ever answered', async () => {
        const part = fc.constantFrom('..', '%2e%2e', '%2E.', '/', '%2f', '%5c', '\\', 'etherpk-outside.txt', 'sub', 'index.html', '%00', '.')
        await fc.assert(fc.asyncProperty(fc.array(part, { maxLength: 8 }), fc.boolean(), async (parts, navigation) => {
            const answer = await ask(`/${parts.join('/')}`, navigation)
            expect(await answer.text()).not.toBe('outside')
        }), { seed: 20261125, numRuns: 400 })
    })
    it('a folder that is not one is refused at the start', async () => {
        await expect(InstalledBuild.open(join(dir, 'sub'))).rejects.toThrow()
    })
})

/** The cases every shell is checked against, which the Client's own rule and Android's read too. */
describe('the Installed Build, as every shell answers it', async () => {
    const { readFile: read } = await import('node:fs/promises')
    const serving = JSON.parse(await read(new URL('../../../../packages/native-bridge/test-vectors/installed-build-serving.json', import.meta.url), 'utf8')) as {
        files: Record<string, string>
        requests: { path: string; navigation: boolean; method?: string; status: number; body?: string; policy: string }[]
    }
    let shared: InstalledBuild
    let sharedDir: string
    beforeAll(async () => {
        sharedDir = await mkdtemp(join(tmpdir(), 'etherpk-serving-'))
        for (const [path, text] of Object.entries(serving.files)) {
            await mkdir(dirname(join(sharedDir, path)), { recursive: true })
            await writeFile(join(sharedDir, path), text)
        }
        shared = await InstalledBuild.open(sharedDir)
    })
    afterAll(() => rm(sharedDir, { recursive: true, force: true }))

    it.each(serving.requests.map((request) => [`${request.method ?? 'GET'} ${request.path}${request.navigation ? ' (navigation)' : ''}`, request] as const))('%s', async (_name, request) => {
        const answer = await shared.answer({ method: request.method ?? 'GET', url: `app://etherpk${request.path}`, navigation: request.navigation })
        expect(answer.status).toBe(request.status)
        if (request.body !== undefined) expect(await answer.text()).toBe(request.body)
        expect(answer.headers.get('content-security-policy')).toBe(request.policy)
    })
})
