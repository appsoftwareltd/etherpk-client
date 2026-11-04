/**
 * A remembered signature: the last one a person made, and never in the graph, because other
 * [[Member]]s hold the [[Graph Key]] and a folder graph's files are plain. It is one of the person's
 * settings (ADR 0134): on this device, and in the account's [[Settings Vault]] where the account syncs
 * a graph, which an agent token cannot read (ADR 0148).
 */
import { personSettings } from '#lib/person-settings/person-settings.js'

const KEY = 'pdf.signature'
/** A picture larger than this would crowd the settings record that follows the person around. */
const MAX_DATA_URL_LENGTH = 200_000

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('could not read the picture'))
        reader.readAsDataURL(blob)
    })
}

/**
 * Keep the signature. A picture too large to keep is left out rather than refused: it still goes on
 * the page, and the person can choose it again next time.
 */
export async function rememberSignature(blob: Blob): Promise<void> {
    const url = await blobToDataUrl(blob)
    if (url.length <= MAX_DATA_URL_LENGTH) personSettings().set(KEY, url)
}

export async function loadRememberedSignature(): Promise<Blob | null> {
    const url = personSettings().get(KEY)
    if (!url?.startsWith('data:image/png;base64,')) return null
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0))
    return new Blob([bytes], { type: 'image/png' })
}

export async function forgetSignature(): Promise<void> {
    personSettings().set(KEY, null)
}
