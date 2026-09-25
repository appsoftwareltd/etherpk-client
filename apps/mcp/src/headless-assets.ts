/**
 * What the asset tools need from a graph's [[Asset]]s, behind one seam for both backends
 * ([[2026-09-20 Headless Client Assets Rename And Publishing]], ADR 0085). The store is the
 * client's own `AssetStore` - the encrypted one over the Sync Server's asset API on a synced
 * graph, the `assets/` directory on a folder - so an agent's upload is named, deduplicated and
 * (on a synced graph) encrypted exactly as a person's is. What differs per backend is only how a
 * reference names an asset (`identify`), which is what the index is asked about when the tools
 * decide whether an asset is reachable from a document the agent can read.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { AssetStore } from '$lib/storage/fs/asset-store'

export interface HeadlessAssets {
    store: AssetStore
    /**
     * The identity a reference names on this backend - the file name on a folder, the random id
     * on a synced graph - or null for a reference that is not an asset's (a remote image, a
     * wikilink). The same forms the index counts references by (`assetUsage`).
     */
    identify(ref: string): string | null
    /** Bytes the graph holds per identity, when the backend can say cheaply; absent otherwise. */
    sizes?(): Promise<Map<string, number>>
    /** Where `read_asset` writes when the agent names no directory. */
    downloadsDir: string
    /**
     * Identities this session uploaded. An upload is readable back until a document references
     * it, which is the one exception to "reachable from a readable document" (ADR 0085): the
     * agent that just added it plainly has it.
     */
    uploaded: Set<string>
}

/** A local file as `upload_asset` reads it. */
export async function readLocalFile(path: string): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
    const buffer = await readFile(path)
    // A fresh ArrayBuffer-backed copy: the store hands the bytes to crypto and to fetch, which
    // want a plain Uint8Array<ArrayBuffer>, not a slice of Node's pooled buffer.
    const bytes = new Uint8Array(new ArrayBuffer(buffer.byteLength))
    bytes.set(buffer)
    return { name: basename(path), bytes }
}

/**
 * Write an asset's bytes under `directory` as `name`, never over a different file of the same
 * name: a second asset that happens to share a display name lands beside it with a suffix, so
 * an agent reading two `diagram.png`s from two pages gets both.
 */
export async function writeDownload(directory: string, name: string, bytes: Uint8Array): Promise<string> {
    await mkdir(directory, { recursive: true })
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = join(directory, name)
    for (let n = 2; existsSync(candidate); n += 1) {
        const existing = await readFile(candidate)
        if (existing.byteLength === bytes.byteLength && existing.every((b, i) => b === bytes[i])) return candidate
        candidate = join(directory, `${stem}-${n}${ext}`)
    }
    await writeFile(candidate, bytes)
    return candidate
}
