/**
 * What [[Find and Replace]] remembers (ADR 0153, Q13).
 *
 * The query and the replacement are kept in memory only, for the session: a query typed into an
 * unlocked [[Protected Document]] can be a secret, and a device's storage outlives the session.
 * The last query is shared by every View, so the next box opens with it, and the box's Up and Down
 * step through this session's earlier queries. The match options and whether the [[Match List]] is
 * shown are the device's choices, kept in its storage, the list's apart for a phone and a desktop
 * because a phone's list is hidden until asked for.
 */

import type { FindOptions } from './find-matches'

/** The part of `localStorage` the session uses, so a test can stand in for it. */
export interface DeviceStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

/** Which layout a list choice is for. */
export type FindLayout = 'desktop' | 'phone'

const KEY = 'etherpk:find'
/** The most queries Up and Down step through. */
const HISTORY_LIMIT = 20

interface DeviceChoices extends FindOptions {
    list: Record<FindLayout, boolean>
}

const DEFAULTS: DeviceChoices = {
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    list: { desktop: true, phone: false },
}

/** The stored choices, each one the stored value only when it has the right type. */
function read(storage: DeviceStorage | null): DeviceChoices {
    let stored: Record<string, unknown> = {}
    try {
        const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')
        if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>
    } catch {
        // Unreadable or refused: the defaults stand, and the session still works.
    }
    const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
    const list = (stored.list && typeof stored.list === 'object' ? stored.list : {}) as Record<string, unknown>
    return {
        caseSensitive: flag(stored.caseSensitive, DEFAULTS.caseSensitive),
        wholeWord: flag(stored.wholeWord, DEFAULTS.wholeWord),
        regexp: flag(stored.regexp, DEFAULTS.regexp),
        list: { desktop: flag(list.desktop, DEFAULTS.list.desktop), phone: flag(list.phone, DEFAULTS.list.phone) },
    }
}

export function createFindSession(storage: DeviceStorage | null) {
    let choices = read(storage)
    const queries: string[] = []

    function write(): void {
        try {
            storage?.setItem(KEY, JSON.stringify(choices))
        } catch {
            // A private window or blocked storage: the choice holds for this session only.
        }
    }

    return {
        /** The query the last search used, or empty. */
        lastQuery: (): string => queries.at(-1) ?? '',
        /** This session's queries, oldest first. */
        history: (): readonly string[] => queries,
        /** Remember a query that was searched with: once, as the latest. */
        remember(query: string): void {
            if (query === '') return
            const at = queries.indexOf(query)
            if (at >= 0) queries.splice(at, 1)
            queries.push(query)
            if (queries.length > HISTORY_LIMIT) queries.shift()
        },
        /**
         * The query Up (-1) or Down (1) gives from what the box holds. A query not in the history
         * steps back to the latest. The ends hold.
         */
        step(current: string, direction: -1 | 1): string {
            if (queries.length === 0) return current
            const at = queries.indexOf(current)
            if (at < 0) return direction < 0 ? queries[queries.length - 1] : current
            return queries[Math.min(queries.length - 1, Math.max(0, at + direction))]
        },
        options: (): FindOptions => ({ caseSensitive: choices.caseSensitive, wholeWord: choices.wholeWord, regexp: choices.regexp }),
        setOptions(options: FindOptions): void {
            choices = { ...choices, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regexp: options.regexp }
            write()
        },
        listShown: (layout: FindLayout): boolean => choices.list[layout],
        setListShown(layout: FindLayout, shown: boolean): void {
            choices = { ...choices, list: { ...choices.list, [layout]: shown } }
            write()
        },
    }
}

export type FindSession = ReturnType<typeof createFindSession>

let shared: FindSession | null = null

/** The session every find box shares, over this device's `localStorage` where the browser allows it. */
export function findSession(): FindSession {
    if (!shared) {
        let storage: DeviceStorage | null = null
        try {
            storage = globalThis.localStorage ?? null
        } catch {
            storage = null
        }
        shared = createFindSession(storage)
    }
    return shared
}
