/**
 * A [[Published Site]] as one zip (ADR 0082): the browser-independent output, offered on every
 * browser beside the folder where the File System Access API exists. A fresh, complete site each
 * time, seeded files included, since nothing in the folder is hand-edited.
 */

import { strToU8, zipSync } from 'fflate'

import type { SiteBundle } from '../types'

export function zipSite(bundle: SiteBundle, seeded: ReadonlyMap<string, string>, agentsMd: string): Uint8Array {
    const files: Record<string, Uint8Array> = {}
    for (const [path, content] of bundle) files[path] = typeof content === 'string' ? strToU8(content) : content
    for (const [path, text] of seeded) if (!(path in files)) files[path] = strToU8(text)
    files['AGENTS.md'] = strToU8(agentsMd)
    return zipSync(files, { level: 6 })
}

/** Hand the zip to the browser as a download. */
export function downloadZip(bytes: Uint8Array, fileName: string): void {
    downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), fileName)
}

/**
 * Hand any Blob to the browser as a download. A `File` from OPFS is streamed from disk by the
 * browser, which is how an [[Export]] of any size reaches a person without a save picker
 * (ADR 0092). The URL is revoked after the click has been taken: a download keeps its own
 * reference to the bytes from then on.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
