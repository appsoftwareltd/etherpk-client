/**
 * What this device remembers about reading PDFs: never synced, never in an [[Export]], like
 * [[Layout]] and [[Reading Position]]. A zoom that suits a phone is wrong on a desktop, so it stays
 * here. So does a folder graph's [[Reading Place]]: a write per reading session into `etherpk/`
 * would dirty a folder tracked in git and cause conflicts in one synced by another tool.
 */

import type { PdfOpenedFrom } from './page-requests'

/** Where a person has reached: 1-based page, how far down it (0 to 1), and when. */
export interface ReadingPlace {
    page: number
    offset: number
    at: number
}

export interface PdfPreferences {
    pageByPage: boolean
    darkPages: boolean
    keepScreenOn: boolean
    /** A stylus's pressure changes the Pen's width. A mouse or a finger reports none, so it does nothing there. */
    penPressure: boolean
    /** A finger draws in place of scrolling. Unset until a person changes it, because the default depends on the device. */
    fingerDraws?: boolean
    /** What the drawing tools last used. Checked when read (annotation-palette.ts). */
    inkColour?: unknown
    highlightColour?: unknown
    customColour?: unknown
    penWidth?: unknown
    highlighterWidth?: unknown
}

export interface RememberedPdf {
    zoom?: number
    crop?: boolean
    place?: ReadingPlace
    /** The reference last clicked to open it, which a saved copy's link can follow. */
    openedFrom?: PdfOpenedFrom
}

export interface PdfDeviceMemory {
    preferences(): PdfPreferences
    setPreferences(change: Partial<PdfPreferences>): void
    pdf(graphId: string, hash: string): RememberedPdf
    updatePdf(graphId: string, hash: string, change: RememberedPdf): void
    /** Forget one PDF, when it is deleted. */
    forgetPdf(graphId: string, hash: string): void
}

const KEY = 'etherpk.pdf.device'
const DEFAULTS: PdfPreferences = { pageByPage: false, darkPages: false, keepScreenOn: true, penPressure: true }
/** Enough for a person's reading, without letting the record grow for ever. */
export const MAX_REMEMBERED_PDFS = 200

interface Record {
    preferences: Partial<PdfPreferences>
    /** In the order they were last used, oldest first. */
    pdfs: Array<[key: string, value: RememberedPdf]>
}

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>

export function createPdfDeviceMemory(storage: DeviceStorage): PdfDeviceMemory {
    const record: Record = read()

    function read(): Record {
        try {
            const raw = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<Record> | null
            return {
                preferences: raw?.preferences && typeof raw.preferences === 'object' ? raw.preferences : {},
                pdfs: Array.isArray(raw?.pdfs) ? raw.pdfs : [],
            }
        } catch {
            return { preferences: {}, pdfs: [] }
        }
    }

    function save(): void {
        // Losing this costs a person their zoom, so a browser that refuses to store it is not an
        // error worth interrupting them for. The record still answers for this session.
        try {
            storage.setItem(KEY, JSON.stringify(record))
        } catch {
            /* per-device convenience only */
        }
    }

    const keyOf = (graphId: string, hash: string) => `${graphId}:${hash}`

    return {
        preferences: () => ({ ...DEFAULTS, ...record.preferences }),
        setPreferences(change) {
            record.preferences = { ...record.preferences, ...change }
            save()
        },
        pdf(graphId, hash) {
            const key = keyOf(graphId, hash)
            return record.pdfs.find(([k]) => k === key)?.[1] ?? {}
        },
        updatePdf(graphId, hash, change) {
            const key = keyOf(graphId, hash)
            const held = record.pdfs.find(([k]) => k === key)?.[1] ?? {}
            const pdfs = record.pdfs.filter(([k]) => k !== key)
            pdfs.push([key, { ...held, ...change }])
            record.pdfs = pdfs.slice(-MAX_REMEMBERED_PDFS)
            save()
        },
        forgetPdf(graphId, hash) {
            const key = keyOf(graphId, hash)
            record.pdfs = record.pdfs.filter(([k]) => k !== key)
            save()
        },
    }
}

let shared: PdfDeviceMemory | undefined

/** The browser's record. A record that cannot reach `localStorage` works for the session alone. */
export function pdfDeviceMemory(): PdfDeviceMemory {
    shared ??= createPdfDeviceMemory(
        typeof localStorage === 'undefined' ? { getItem: () => null, setItem: () => {} } : localStorage,
    )
    return shared
}
