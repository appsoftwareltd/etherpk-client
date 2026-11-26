/**
 * Giving a person a file to keep: the one way the Client does it.
 *
 * In a browser it is a download, which the browser names, places and reports. A Native App has no
 * downloads to speak of, and a WebView cannot download a `blob:` address at all, so the shell asks the
 * person where to save the file and writes it.
 */
import { showNotice } from '#lib/activity/notices.js'

import { nativeBridge } from './bridge.js'

/** `started` is a browser's answer: it took the download, and does not say what became of it. */
export type SaveOutcome = 'saved' | 'started' | 'cancelled'

/** How much crosses to the shell at a time, so that a large file is never held whole twice. */
export const SAVE_CHUNK_BYTES = 1024 * 1024

/** A file being written by the shell. Nothing is on disk until `close`. */
export interface NativeSave {
    write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
}

/** Ask the person where to save a file. Null in a browser. Rejects with `AbortError` when they cancel. */
export async function openNativeSave(name: string, type: string): Promise<NativeSave | null> {
    const bridge = nativeBridge()
    if (!bridge) return null
    const { save } = await bridge.call('save.open', { name, type })
    return {
        write: (bytes) => bridge.call('save.write', { save, bytes }),
        close: () => bridge.call('save.commit', { save }),
        abort: () => bridge.call('save.abort', { save }),
    }
}

/** Save `blob` under `name`, or a name the person chooses. Rejects when it cannot be written. */
export async function saveBlob(blob: Blob, name: string): Promise<SaveOutcome> {
    let target: NativeSave | null
    try {
        target = await openNativeSave(name, blob.type)
    } catch (error) {
        if ((error as Error).name === 'AbortError') return 'cancelled'
        throw error
    }
    if (!target) {
        startDownload(URL.createObjectURL(blob), name, { revoke: true })
        return 'started'
    }
    try {
        for (let at = 0; at < blob.size; at += SAVE_CHUNK_BYTES) {
            await target.write(new Uint8Array(await blob.slice(at, at + SAVE_CHUNK_BYTES).arrayBuffer()))
        }
        await target.close()
    } catch (error) {
        // What went wrong is what the caller is told, whether or not the half-written file could be dropped.
        await target.abort().catch((abortError: unknown) => console.warn('[native] a failed save could not be dropped', abortError))
        throw error
    }
    return 'saved'
}

/** Save what an address of this page's own holds (an asset's object URL) under `name`. */
export async function saveUrl(url: string, name: string): Promise<SaveOutcome> {
    if (!nativeBridge()) {
        startDownload(url, name)
        return 'started'
    }
    // A data: address holds its bytes, and the installed policy lets the page fetch none.
    if (url.startsWith('data:')) return saveBlob(blobOfDataUrl(url), name)
    // Asked for at once: whoever made an object URL may revoke it as soon as this returns.
    const response = await fetch(url)
    if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)
    return saveBlob(await response.blob(), name)
}

/** {@link saveBlob} for a caller with nothing to wait for. A failure is told to the person here. */
export function downloadBlob(blob: Blob, name: string): void {
    void saveBlob(blob, name).catch((error: unknown) => reportFailure(name, error))
}

/** {@link saveUrl} for a caller with nothing to wait for. A failure is told to the person here. */
export function downloadUrl(url: string, name: string): void {
    void saveUrl(url, name).catch((error: unknown) => reportFailure(name, error))
}

function reportFailure(name: string, error: unknown): void {
    console.error(`[save] could not save ${name}`, error)
    showNotice({ id: 'save-file', tone: 'error', text: `${name} was not saved. ${saveFailureReason(error)}` })
}

/** Why a file was not saved and what to do, in words for the person. */
export function saveFailureReason(error: unknown): string {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'QuotaExceededError') return 'There is no room left on that disk. Make some room, or choose another place, and save it again.'
    if (name === 'NotAllowedError' || name === 'NoModificationAllowedError') return 'EtherPK is not allowed to write there. Choose another place and save it again.'
    return 'Choose another place, or try again in a moment.'
}

/** How long an object URL is kept for a download to take its bytes. */
const REVOKE_AFTER_MS = 60_000

/** Hand an address to the browser as a download. */
function startDownload(url: string, name: string, options: { revoke?: boolean } = {}): void {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    // Attached before the click, and revoked well after it: revoking in the same tick cancels the
    // download in some browsers, which then reported as a successful save.
    document.body.append(link)
    link.click()
    link.remove()
    if (options.revoke) setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}

/**
 * Save the downloads started by code that does not go through this module: a link with a `download`
 * attribute that the person clicks, and one a library (Excalidraw, an extension) makes and clicks
 * itself, which is never on the page. Does nothing in a browser. Returns a function that stops.
 */
export function watchDownloads(): () => void {
    if (!nativeBridge()) return () => {}
    const onClick = (event: MouseEvent) => {
        const link = (event.target as Element | null)?.closest?.('a[download]')
        if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented || !isOwnFile(link.href)) return
        event.preventDefault()
        downloadUrl(link.href, downloadName(link))
    }
    const prototype = HTMLAnchorElement.prototype
    const click = prototype.click
    prototype.click = function (this: HTMLAnchorElement) {
        // One on the page is heard by the listener above, after its own handlers.
        if (this.isConnected || !this.hasAttribute('download') || !isOwnFile(this.href)) click.call(this)
        else downloadUrl(this.href, downloadName(this))
    }
    document.addEventListener('click', onClick)
    return () => {
        document.removeEventListener('click', onClick)
        prototype.click = click
    }
}

/** An address only this page can read. A link to a file on the web is the system browser's to download. */
function isOwnFile(href: string): boolean {
    return /^(?:blob|data):/.test(href) || href.startsWith(`${location.origin}/`)
}

/** The name a download is saved under: its own, else the last part of its address. */
export function downloadName(link: Pick<HTMLAnchorElement, 'download' | 'href'>): string {
    if (link.download) return link.download
    // A data: address has no file name in it, only its bytes.
    if (link.href.startsWith('data:')) return 'file'
    const last = new URL(link.href).pathname.split('/').at(-1) ?? ''
    try {
        return decodeURIComponent(last) || 'file'
    } catch {
        // A `%` that escapes nothing: the name as written, rather than a download lost.
        return last || 'file'
    }
}

/** The bytes and type a data: address holds. */
export function blobOfDataUrl(url: string): Blob {
    const comma = url.indexOf(',')
    const header = url.slice('data:'.length, comma)
    const body = url.slice(comma + 1)
    const type = header.split(';')[0] || 'text/plain'
    if (header.split(';').includes('base64')) return new Blob([Uint8Array.from(atob(body), (char) => char.charCodeAt(0))], { type })
    return new Blob([decodeURIComponent(body)], { type })
}
