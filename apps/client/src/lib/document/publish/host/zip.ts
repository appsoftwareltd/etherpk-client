/**
 * A [[Published Site]] as one zip (ADR 0082): the browser-independent output, offered on every
 * browser beside the folder where the File System Access API exists. A fresh, complete site each
 * time, seeded files included, since nothing in the folder is hand-edited.
 */

import { strToU8, zipSync } from 'fflate'

import { downloadBlob } from '#lib/native/save-file.js'

import type { SiteBundle } from '../types'

export function zipSite(bundle: SiteBundle, seeded: ReadonlyMap<string, string>, agentsMd: string): Uint8Array {
    const files: Record<string, Uint8Array> = {}
    for (const [path, content] of bundle) files[path] = typeof content === 'string' ? strToU8(content) : content
    for (const [path, text] of seeded) if (!(path in files)) files[path] = strToU8(text)
    files['AGENTS.md'] = strToU8(agentsMd)
    return zipSync(files, { level: 6 })
}

/** Give the zip to the person to keep. */
export function downloadZip(bytes: Uint8Array, fileName: string): void {
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), fileName)
}
