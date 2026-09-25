/**
 * `removeStaleFiles` over a Windows-shaped directory. `path.join` spells a path with backslashes
 * there, and the set of names to keep was once derived by splitting the joined paths on `/`,
 * which on Windows kept each whole path instead of its name: no entry of the directory listing
 * ever matched, so every start removed this build's own index and vectors as "stale" - a full
 * re-index (unnoticed, a second) and a full re-embed (noticed, minutes) per `serve`, and two
 * serves over one folder each deleting the other's snapshot (0.7.0, Windows 11, 2026-09-21).
 *
 * Node's `path` is swapped for its win32 flavour and the filesystem for a recording fake, so
 * the failure reproduces on any platform. Its own file, because the swap is module-wide.
 */
import { basename } from 'node:path/win32'
import { describe, expect, it, vi } from 'vitest'

import { INDEX_SCHEMA_VERSION } from '$lib/document/index-db'
import { EMBEDDING_STORE_VERSION } from '$lib/document/semantic/embedding-db'

const fake = vi.hoisted(() => ({ listing: [] as string[], removed: [] as string[] }))

vi.mock('node:path', () => vi.importActual<typeof import('node:path')>('node:path/win32'))
vi.mock('node:fs/promises', () => ({
    readdir: async () => [...fake.listing],
    stat: async () => ({ mtimeMs: Date.now() }),
    rm: async (path: string) => {
        fake.removed.push(path)
    },
    mkdir: async () => undefined,
    readFile: async () => new Uint8Array(),
    rename: async () => undefined,
    writeFile: async () => undefined,
}))

describe('removeStaleFiles on a Windows-shaped directory', () => {
    it('keeps the index, vectors and cache this build reads and removes only other versions', async () => {
        const { removeStaleFiles } = await import('./persistence')
        const current = [`index.v${INDEX_SCHEMA_VERSION}.sqlite`, `vectors.v${EMBEDDING_STORE_VERSION}.sqlite`, 'local-cache.v3.bin']
        fake.listing = [...current, 'index.v8.sqlite', 'vectors.v0.sqlite']
        const removed = await removeStaleFiles('C:\\Users\\me\\.cache\\etherpk\\mcp\\local\\Notes-0123456789ab')
        expect(removed.sort()).toEqual(['index.v8.sqlite', 'vectors.v0.sqlite'])
        expect(fake.removed.map((path) => basename(path)).sort()).toEqual(['index.v8.sqlite', 'vectors.v0.sqlite'])
    })
})
