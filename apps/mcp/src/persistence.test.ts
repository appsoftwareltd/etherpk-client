import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'
import { createLoopbackRelay } from '$lib/sync/loopback-relay'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { fakeEmbeddingModel } from '$lib/document/semantic/embedding-model'

import { openHeadlessGraph, type HeadlessGraph, type HeadlessGraphDeps } from './headless-graph'
import { cacheFile, folderCacheDir, folderKey, graphCacheDir, indexFile, listGraphStores, nodeIndexHost, removeCacheRoot, vectorsFile } from './persistence'
import { createPage, listDocuments, readDocument, search } from './tools'

/**
 * The cache and the index survive a process, and a later open starts from them: the store's
 * registry and documents are there before any relay catch-up, the index answers a search from
 * its restored rows, and the index reports itself persisted so the core takes its warm path. The
 * relay is the same in-memory loopback for both opens, as the real relay would be the same
 * server; what proves the files were used is a relay that is silenced for the second open.
 */

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde22000'
const open: HeadlessGraph[] = []
const dirs: string[] = []

afterEach(async () => {
    await Promise.all(open.splice(0).map((g) => g.dispose()))
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-persist-'))
    dirs.push(dir)
    return dir
}

async function graph(id: string, dir: string, relay: ReturnType<typeof createLoopbackRelay>, extra: Partial<HeadlessGraphDeps> = {}): Promise<HeadlessGraph> {
    const g = await openHeadlessGraph({
        graphId: id,
        rootDocId: ROOT,
        keyring: createGraphKeyring(id),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        presenceName: 'Agent on test',
        connect: relay.connect,
        persistDir: dir,
        persistDebounceMs: 20,
        ...extra,
    })
    open.push(g)
    return g
}

describe('cache directories', () => {
    it('are per server host and graph under the cache root, versioned by schema', () => {
        const env = { XDG_CACHE_HOME: '/c' } as NodeJS.ProcessEnv
        const dir = graphCacheDir(env, 'https://sync.example.test:8443', 'g-1')
        expect(dir).toBe('/c/etherpk/mcp/sync.example.test_8443/g-1')
        expect(cacheFile(dir)).toMatch(/local-cache\.v\d+\.bin$/)
        expect(indexFile(dir)).toMatch(/index\.v\d+\.sqlite$/)
        expect(graphCacheDir({ ETHERPK_MCP_CACHE_DIR: '/x' } as NodeJS.ProcessEnv, 'http://localhost:5273', 'g')).toBe('/x/localhost_5273/g')
    })

    it('key a local folder by its basename and a hash of its absolute path, under local/', () => {
        const env = { XDG_CACHE_HOME: '/c' } as NodeJS.ProcessEnv
        const key = folderKey('/home/me/Notes')
        expect(key).toMatch(/^Notes-[0-9a-f]{12}$/)
        expect(folderCacheDir(env, '/home/me/Notes')).toBe(`/c/etherpk/mcp/local/${key}`)
        // Stable for the same path, different for another; the readable half is sanitised.
        expect(folderKey('/home/me/Notes')).toBe(key)
        expect(folderKey('/home/you/Notes')).not.toBe(key)
        expect(folderKey('/home/me/My Notes (2026)!')).toMatch(/^My_Notes__2026__-[0-9a-f]{12}$/)
        expect(folderKey('/home/me/' + 'x'.repeat(200))).toMatch(/^x{40}-[0-9a-f]{12}$/)
        // A relative path is the same folder as its absolute spelling.
        expect(folderKey('Notes')).toBe(folderKey(`${process.cwd()}/Notes`))
    })
})

describe('a persisted graph', () => {
    it('writes both files on dispose and reopens from them with the relay silenced', async () => {
        const dir = await scratch()
        const relay = createLoopbackRelay()
        const keyringId = 'g-persist'

        const first = await graph(keyringId, dir, relay)
        await createPage(first, { title: 'Physics', text: '- quantum [[Maths]]' })
        await createPage(first, { title: 'Maths', text: '- proofs' })
        await first.dispose()
        open.splice(open.indexOf(first), 1)
        expect((await readdir(dir)).sort()).toEqual([indexFile(dir), cacheFile(dir), vectorsFile(dir)].map((f) => basename(f)).sort())

        // A relay that can never be reached (the socket never opens): whatever the second open
        // knows, it knew from disk - the offline start a laptop on a train gets.
        const silent = {
            connect: () => ({
                send() {},
                close() {},
                onOpen() {},
                onMessage() {},
                onClose() {},
            }),
        }
        const second = await openHeadlessGraph({
            graphId: keyringId,
            rootDocId: ROOT,
            keyring: createGraphKeyring(keyringId),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            presenceName: 'Agent on test',
            connect: silent.connect,
            persistDir: dir,
            readyTimeoutMs: 500,
        })
        open.push(second)
        expect(second.index.isPersisted()).toBe(true)
        expect((await listDocuments(second)).documents.map((d) => d.concept)).toEqual(['Maths', 'Physics'])
        const found = await search(second, { query: 'quantum' })
        expect(found.results.map((r) => r.concept)).toEqual(['Physics'])
        // The document text is in the cache too; the read waits on the relay only up to its cap.
        expect((await readDocument(second, 'Maths')).text).toBe('- proofs')
    }, 40_000)

    it('snapshots after a write without being asked, and logout removes the root', async () => {
        const root = await scratch()
        const env = { ETHERPK_MCP_CACHE_DIR: root } as NodeJS.ProcessEnv
        const dir = graphCacheDir(env, 'http://localhost:1', 'g-snap')
        const relay = createLoopbackRelay()
        const g = await graph('g-snap', dir, relay)
        await createPage(g, { title: 'Plan', text: '- one' })
        await new Promise((r) => setTimeout(r, 200))
        expect((await readdir(dir)).length).toBe(3)
        await removeCacheRoot(env)
        await expect(readdir(root)).rejects.toThrow()
    })

    it('keeps the embedding store across launches, so a reopen resumes instead of re-embedding', async () => {
        const dir = await scratch()
        const relay = createLoopbackRelay()
        const calls: string[][] = []
        const model = () => Promise.resolve(fakeEmbeddingModel({ calls }))
        const first = await graph('g-vectors', dir, relay, { embeddingModel: model })
        await createPage(first, { title: 'Physics', text: '- quantum mechanics' })
        const semantic = await first.semantic()
        await semantic.build()
        expect(await semantic.status()).toEqual({ available: true, total: 1, embedded: 1 })
        await first.dispose()
        open.splice(open.indexOf(first), 1)
        expect(await readdir(dir)).toContain(basename(vectorsFile(dir)))

        calls.length = 0
        const silent = { connect: () => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }) }
        const second = await openHeadlessGraph({
            graphId: 'g-vectors',
            rootDocId: ROOT,
            keyring: createGraphKeyring('g-vectors'),
            relayUrl: 'ws://loopback/sync',
            token: fixedSyncToken('t'),
            presenceName: 'Agent on test',
            connect: silent.connect,
            persistDir: dir,
            readyTimeoutMs: 500,
            embeddingModel: model,
        })
        open.push(second)
        const resumed = await second.semantic()
        await resumed.build()
        expect(await resumed.status()).toEqual({ available: true, total: 1, embedded: 1 })
        expect(calls.flat().filter((text) => text.startsWith('Physics'))).toEqual([])
        const found = await search(second, { query: 'quantum mechanics', mode: 'semantic' })
        expect(found.results.map((r) => r.concept)).toEqual(['Physics'])
    }, 40_000)

    it('lists each cached graph\'s embedding progress from the files on disk', async () => {
        const root = await scratch()
        const env = { ETHERPK_MCP_CACHE_DIR: root } as NodeJS.ProcessEnv
        const dir = graphCacheDir(env, 'http://localhost:1', 'g-status')
        const relay = createLoopbackRelay()
        const model = fakeEmbeddingModel()
        const g = await graph('g-status', dir, relay, { embeddingModel: () => Promise.resolve(model) })
        await createPage(g, { title: 'Plan', text: '- one' })
        const semantic = await g.semantic()
        await semantic.build()
        await g.dispose()
        open.splice(open.indexOf(g), 1)
        const stores = await listGraphStores(env, model.id)
        expect(stores).toHaveLength(1)
        expect(stores[0]).toMatchObject({ host: 'localhost_1', graphId: 'g-status', dir, status: { available: true, total: 1, embedded: 1 } })
        expect(stores[0].updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
        // Another model has everything still to do; the runtime and model directories are not graphs.
        expect((await listGraphStores(env, 'other-model'))[0].status).toEqual({ available: true, total: 1, embedded: 0 })
    }, 40_000)

    it('removes a vectors file that will not read as a database and carries on without it', async () => {
        const dir = await scratch()
        await writeFile(vectorsFile(dir), 'not a database')
        const host = nodeIndexHost(dir)
        const opened = await host.open('g')
        expect(opened.db.all<{ name: string }>('PRAGMA database_list').map((r) => r.name)).toContain('embeddings')
        expect(await readdir(dir)).not.toContain(basename(vectorsFile(dir)))
        opened.db.close()
    })

    it('discards an index file whose schema stamp is not this build\'s', async () => {
        const dir = await scratch()
        const host = nodeIndexHost(dir)
        const opened = await host.open('g')
        opened.db.exec('PRAGMA user_version = 1')
        await host.export()
        opened.db.close()
        const again = nodeIndexHost(dir)
        const reopened = await again.open('g')
        expect(reopened.db.all<{ user_version: number }>('PRAGMA user_version')[0].user_version).not.toBe(1)
        expect(await readdir(dir)).not.toContain(basename(indexFile(dir)))
    })
})

describe('the local cache snapshot', () => {
    it('restores rows that are views on one shared buffer without cloning that buffer per row', async () => {
        // As v8.deserialize hands a snapshot back: every typed array a zero-copy view on the
        // file's one buffer. IndexedDB's structured clone copies a view's WHOLE buffer, so
        // without a copy per row this is rows × file size of memory (2026-09-17: 28 GB).
        const { openGraphCache } = await import('$lib/sync/local-cache')
        const { captureLocalCache, restoreLocalCache } = await import('./persistence')
        const graphId = `g-views-${Math.floor(performance.now() * 1000)}`
        const cache = await openGraphCache(graphId)
        try {
            const file = new Uint8Array(16 * 1024 * 1024)
            const docs = Array.from({ length: 300 }, (_, n) => ({
                key: `${graphId}/${n}`,
                graphId,
                docId: String(n),
                update: new Uint8Array(file.buffer, n * 1024, 900),
                lastSeq: 1,
                lastSyncedStateVector: new Uint8Array(file.buffer, n * 8, 8),
                generation: 1,
                lifecycle: 'active',
            }))
            const started = performance.now()
            await restoreLocalCache({ version: 3, graphId, rows: { docs, outbox: [], 'index-dirty': [] } })
            // 300 rows × 16 MB would be 4.8 GB of copying; the copies are 300 × 900 bytes.
            expect(performance.now() - started).toBeLessThan(5_000)
            const stored = await new Promise<{ update: Uint8Array }>((resolve, reject) => {
                const open = indexedDB.open('etherpk-sync', 3)
                open.onerror = () => reject(open.error)
                open.onsuccess = () => {
                    const db = open.result
                    const get = db.transaction('docs', 'readonly').objectStore('docs').get(`${graphId}/7`)
                    get.onsuccess = () => {
                        db.close()
                        resolve(get.result as { update: Uint8Array })
                    }
                    get.onerror = () => reject(get.error)
                }
            })
            expect(stored.update.byteLength).toBe(900)
            expect(stored.update.buffer.byteLength).toBe(900)
            const captured = await captureLocalCache(graphId)
            expect(captured.rows.docs).toHaveLength(300)
            for (const row of captured.rows.docs as Array<{ update: Uint8Array }>) expect(row.update.buffer.byteLength).toBe(row.update.byteLength)
        } finally {
            cache.dispose()
        }
    }, 40_000)

    it('removes index and vectors files of other versions and abandoned temp files on open', async () => {
        const dir = await scratch()
        const { removeStaleFiles } = await import('./persistence')
        await writeFile(join(dir, 'index.v8.sqlite'), 'old')
        await writeFile(join(dir, 'vectors.v0.sqlite'), 'old')
        await writeFile(join(dir, 'index.v9.sqlite.8039.tmp'), 'half-written')
        await writeFile(join(dir, 'index.v9.sqlite.9999.tmp'), 'being written now')
        await writeFile(join(dir, 'local-cache.v3.bin'), 'keep')
        // The abandoned one is old; the other could be a live serve's snapshot in flight.
        const old = new Date(Date.now() - 30 * 60_000)
        await utimes(join(dir, 'index.v9.sqlite.8039.tmp'), old, old)
        const removed = await removeStaleFiles(dir)
        expect(removed.sort()).toEqual(['index.v8.sqlite', 'index.v9.sqlite.8039.tmp', 'vectors.v0.sqlite'])
        // A read-only open (semantic status) removes nothing at all.
        const reader = await nodeIndexHost(dir, { tidy: false }).open('g')
        reader.db.close()
        expect(await readdir(dir)).toContain('index.v9.sqlite.9999.tmp')
        const host = nodeIndexHost(dir)
        const opened = await host.open('g')
        await host.export()
        opened.db.close()
        expect((await readdir(dir)).sort()).toEqual([indexFile(dir), 'index.v9.sqlite.9999.tmp', 'local-cache.v3.bin', vectorsFile(dir)].map((f) => basename(f)).sort())
    })
})

describe('describing a graph store', () => {
    it('leads with the state, then the counts, then how fresh the snapshot is', async () => {
        const { describeGraphStore } = await import('./persistence')
        const at = (secondsAgo: number, embedded: number, total: number) =>
            describeGraphStore({ host: 'h', graphId: 'g', dir: '/d', status: { available: true, embedded, total }, updatedAt: new Date(1_000_000 - secondsAgo * 1000) }, 1_000_000)
        expect(at(14, 1408, 13286)).toBe('building - 1,408 of 13,286 passages (10%) embedded, snapshot 14 s ago, refreshed every 30 s while it builds')
        expect(at(2700, 128, 13286)).toBe('paused - 128 of 13,286 passages (0%) embedded, last snapshot 45 min ago; nothing is building it now, it continues when serve next runs')
        expect(at(7200, 13286, 13286)).toBe('up to date - 13,286 of 13,286 passages embedded (snapshot 2 h ago)')
        expect(at(5, 0, 0)).toBe('empty - no passages indexed here yet (snapshot 5 s ago)')
    })
})
