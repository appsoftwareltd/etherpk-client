/**
 * What this device remembers about reading EBooks: never synced, never in an [[Export]]. A text size
 * that suits a phone is wrong on a desktop, so the settings stay here, and so does a folder graph's
 * [[Reading Place]]: a write per reading session into `etherpk/` would dirty a folder tracked in git.
 */
import { NEW_PACE, sanitizePace, type ReadingPace } from './ebook-pace'
import { sanitizeEbookSettings, type EbookSettings } from './ebook-settings'
import { sanitizeEbookPlace, type EbookPlace } from './ebook-state'

export interface EbookPreferences {
    settings: EbookSettings
    keepScreenOn: boolean
    /** On a touch phone, the top bar and the page buttons go while a person reads. */
    hidesControls: boolean
    /** The hint on how to bring them back has been shown here. */
    controlsHintSeen: boolean
    /** The colour the Highlight text tool last used. */
    highlightColour: string | null
    pace: ReadingPace
    /** The voice an EBook is read aloud with, by its name, and how fast. */
    readingVoice: string | null
    readingRate: number
    /** The minutes read on one day, on this device. */
    readingDay: { day: string; minutes: number } | null
}

export interface RememberedEbook {
    place?: EbookPlace
}

export interface EbookDeviceMemory {
    preferences(): EbookPreferences
    setPreferences(change: Partial<EbookPreferences>): void
    ebook(graphId: string, hash: string): RememberedEbook
    updateEbook(graphId: string, hash: string, change: RememberedEbook): void
    forgetEbook(graphId: string, hash: string): void
}

const KEY = 'etherpk.ebook.device'
/** Enough for a person's reading, without letting the record grow for ever. */
export const MAX_REMEMBERED_BOOKS = 200

interface DeviceRecord {
    preferences: Record<string, unknown>
    ebooks: Array<[key: string, value: RememberedEbook]>
}

type DeviceStorage = Pick<Storage, 'getItem' | 'setItem'>

function readRecord(storage: DeviceStorage): DeviceRecord {
    try {
        const raw = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<DeviceRecord> | null
        return {
            preferences: raw?.preferences && typeof raw.preferences === 'object' ? raw.preferences : {},
            ebooks: Array.isArray(raw?.ebooks) ? raw.ebooks : [],
        }
    } catch {
        return { preferences: {}, ebooks: [] }
    }
}

function cleanPreferences(raw: Record<string, unknown>): EbookPreferences {
    return {
        settings: sanitizeEbookSettings(raw.settings),
        keepScreenOn: raw.keepScreenOn !== false,
        hidesControls: raw.hidesControls !== false,
        controlsHintSeen: raw.controlsHintSeen === true,
        highlightColour: typeof raw.highlightColour === 'string' && /^#[0-9a-f]{6}$/i.test(raw.highlightColour) ? raw.highlightColour : null,
        pace: raw.pace === undefined ? NEW_PACE : sanitizePace(raw.pace),
        readingVoice: typeof raw.readingVoice === 'string' ? raw.readingVoice : null,
        readingRate: typeof raw.readingRate === 'number' && raw.readingRate >= 0.5 && raw.readingRate <= 3 ? raw.readingRate : 1,
        readingDay: cleanReadingDay(raw.readingDay),
    }
}

function cleanReadingDay(raw: unknown): EbookPreferences['readingDay'] {
    if (typeof raw !== 'object' || raw === null) return null
    const { day, minutes } = raw as Record<string, unknown>
    return typeof day === 'string' && typeof minutes === 'number' && minutes >= 0 ? { day, minutes } : null
}

export function createEbookDeviceMemory(storage: DeviceStorage): EbookDeviceMemory {
    let record = readRecord(storage)
    // Set while the browser refuses to store anything. What this window holds is then the only copy.
    let unsaved = false

    /**
     * Read again before each use, because another window of this browser may have written since, and
     * writing back an old copy would lose the place that window reached.
     */
    function reread(): void {
        if (!unsaved) record = readRecord(storage)
    }

    function save(): void {
        // Losing this costs a person their text size, which is not worth interrupting them for.
        try {
            storage.setItem(KEY, JSON.stringify(record))
            unsaved = false
        } catch {
            unsaved = true
        }
    }

    const keyOf = (graphId: string, hash: string) => `${graphId}:${hash}`

    return {
        preferences() {
            reread()
            return cleanPreferences(record.preferences)
        },
        setPreferences(change) {
            reread()
            record.preferences = { ...record.preferences, ...change }
            save()
        },
        ebook(graphId, hash) {
            reread()
            const held = record.ebooks.find(([key]) => key === keyOf(graphId, hash))?.[1] ?? {}
            return { place: sanitizeEbookPlace(held.place) }
        },
        updateEbook(graphId, hash, change) {
            const key = keyOf(graphId, hash)
            reread()
            const held = record.ebooks.find(([k]) => k === key)?.[1] ?? {}
            record.ebooks = [...record.ebooks.filter(([k]) => k !== key), [key, { ...held, ...change }] as [string, RememberedEbook]].slice(-MAX_REMEMBERED_BOOKS)
            save()
        },
        forgetEbook(graphId, hash) {
            const key = keyOf(graphId, hash)
            reread()
            record.ebooks = record.ebooks.filter(([k]) => k !== key)
            save()
        },
    }
}

let shared: EbookDeviceMemory | undefined

/** The browser's record. One that cannot reach `localStorage` works for the session alone. */
export function ebookDeviceMemory(): EbookDeviceMemory {
    shared ??= createEbookDeviceMemory(typeof localStorage === 'undefined' ? { getItem: () => null, setItem: () => {} } : localStorage)
    return shared
}
