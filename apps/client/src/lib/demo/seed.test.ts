import { describe, expect, it } from 'vitest'

import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import type { DemoBundleManifest } from './bundle-manifest'
import { type DemoFile, demoFileUrl, fetchDemoBundle, materializeDemoGraph } from './seed'

const encoder = new TextEncoder()
const text = (path: string, body: string): DemoFile => ({ path, bytes: encoder.encode(body) as Uint8Array<ArrayBuffer> })
const shift = { anchor: '2026-09-15', today: '2026-10-01', windowDays: 60 }

describe('materializeDemoGraph', () => {
    it('writes journals and pages with the calendar moved to today, settings verbatim, assets as bytes', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        const image = { path: 'assets/leaf.0a0b0c0d.png', bytes: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer> }
        const seen: string[] = []
        await materializeDemoGraph(
            adapter,
            [
                text('journals/2026-09-15.md', '# 2026-09-15\n\nDue [[2026-09-16]], see [[Plant]].'),
                text('pages/Plant.md', '# Plant\n\nPlanted 1753-05-01. Repot by 2026-09-20.'),
                text('etherpk/settings.json', '{"favourites":["Plant"]}'),
                image,
            ],
            shift,
            { totalBytes: 200, onProgress: (p) => seen.push(`${p.path}:${p.loadedBytes}/${p.totalBytes}`) },
        )
        expect((await adapter.read('journals', '2026-10-01.md')).text).toBe('# 2026-10-01\n\nDue [[2026-10-02]], see [[Plant]].')
        expect(await adapter.exists('journals', '2026-09-15.md')).toBe(false)
        expect((await adapter.read('pages', 'Plant.md')).text).toBe('# Plant\n\nPlanted 1753-05-01. Repot by 2026-10-06.')
        expect((await adapter.read('etherpk', 'settings.json')).text).toBe('{"favourites":["Plant"]}')
        expect([...(await adapter.readBinary('assets', 'leaf.0a0b0c0d.png')).bytes]).toEqual([1, 2, 3])
        expect(seen.at(-1)).toBe('assets/leaf.0a0b0c0d.png:124/200')
    })

    it('accepts an async source and skips anything outside the content folders', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        async function* files() {
            yield text('pages/Plant.md', '# Plant')
            yield text('demo.json', '{}')
            yield text('pages/deep/Other.md', '# Other')
        }
        await materializeDemoGraph(adapter, files(), shift)
        expect((await adapter.list('pages')).map((e) => e.name)).toEqual(['Plant.md'])
        expect(await adapter.list('etherpk')).toEqual([])
    })
})

describe('fetchDemoBundle', () => {
    const manifest: DemoBundleManifest = {
        name: 'Plants',
        anchor: '2026-09-15',
        windowDays: 60,
        files: [
            { path: 'pages/[[Plant]] Foods.md', size: 7 },
            { path: 'assets/leaf.0a0b0c0d.png', size: 3 },
        ],
        totalBytes: 10,
    }

    it('encodes each path segment so bracketed and spaced names reach the static server', () => {
        expect(demoFileUrl('/demo-graph', 'pages/[[Plant]] Foods.md')).toBe('/demo-graph/pages/%5B%5BPlant%5D%5D%20Foods.md')
    })

    it('yields the files in manifest order with their bytes', async () => {
        const requested: string[] = []
        const fetchImpl = (async (url: string) => {
            requested.push(url)
            const body = url.endsWith('.md') ? encoder.encode('# Foods') : new Uint8Array([1, 2, 3])
            return new Response(body)
        }) as unknown as typeof fetch
        const files: DemoFile[] = []
        for await (const file of fetchDemoBundle(manifest, { fetch: fetchImpl })) files.push(file)
        expect(requested).toEqual(['/demo-graph/pages/%5B%5BPlant%5D%5D%20Foods.md', '/demo-graph/assets/leaf.0a0b0c0d.png'])
        expect(files.map((f) => f.path)).toEqual(manifest.files.map((f) => f.path))
        expect(new TextDecoder().decode(files[0].bytes)).toBe('# Foods')
    })

    it('fails on the first file the server does not have', async () => {
        const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
        const iterator = fetchDemoBundle(manifest, { fetch: fetchImpl })
        await expect(iterator.next()).rejects.toThrow('pages/[[Plant]] Foods.md could not be fetched (404)')
    })
})
