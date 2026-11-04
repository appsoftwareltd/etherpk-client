/**
 * What a PDF tab asks of the open graph beyond its own state: the parts that differ by backend. The
 * workspace wires it for whichever backend it opened. Everything else a tab needs (the store, the
 * index, the asset store) it reaches through the ordinary workspace services.
 */
import type { PdfStateHost } from './pdf-state'

export type AssetDeleteAnswer =
    | { deleted: true }
    /** Links still exist, so the bytes stay (ADR 0054). */
    | { deleted: false; reason: 'linked'; documents: string[] }
    /** It cannot be proved safe just now: the index is building, or this device is behind or offline. */
    | { deleted: false; reason: 'not-ready'; message: string }

export interface PdfGraphService {
    state: PdfStateHost
    /** `folder` keeps every file on disk, and a person's reading place stays on the device. */
    backend: 'folder' | 'synced'
    /** Delete the PDF, when nothing links to it. Its state goes with it. */
    deleteAsset(target: string, hash: string): Promise<AssetDeleteAnswer>
    /** Give the PDF a new name, in its links too. Answers the name and identity it has afterwards. */
    renameAsset(target: string, name: string, oldName: string): Promise<{ target: string; name: string }>
    /** Synced only: the name the server holds now, past this device's copy; null when it cannot say. */
    currentName?(target: string): Promise<string | null>
    /** Synced only: whether this device keeps the file whatever its size. */
    keptOnDevice(target: string): Promise<boolean>
    setKeptOnDevice(target: string, keep: boolean): Promise<void>
}
