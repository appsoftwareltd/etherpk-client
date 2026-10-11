/**
 * The [[Journal Roll]]'s state (ADR 0136): the older [[Journal Entry]]s loaded beneath a journal
 * tab's own entry, newest first, and the written day its bar offers next.
 *
 * - **Which day is next.** The previous day that has an entry, by the [[Journal Calendar]]'s rule
 *   for its bold days: a concept in the store's registry that is a calendar day. A run of days
 *   nobody wrote is one step, and the roll never goes newer than the tab's entry.
 * - **Loading** happens only when asked ({@link JournalRoll.load}); **hiding** a day unloads it and
 *   every older day below it, and offers it again.
 * - **The cap.** At most {@link JOURNAL_ROLL_CAP} days are loaded, because each is a live editor
 *   (and on a synced graph a sync engine). At the cap the next day is still named, so the bar can
 *   open it in a tab of its own, where the roll carries on.
 * - **A registry change** ({@link JournalRoll.refresh}) can change the day offered next. Days
 *   already loaded stay as they are, so nothing moves under the reader.
 *
 * Framework free so it is Node tested; `view/JournalRoll.svelte` draws it.
 */

import { isJournalConcept } from './journal-concept'

/** The most days a roll loads in one tab. */
export const JOURNAL_ROLL_CAP = 10

/**
 * The newest written day older than `before`, among the registry's `concepts`; null when there is
 * none. Days are `YYYY-MM-DD`, so the string order is the date order.
 */
export function olderEntry(concepts: Iterable<string>, before: string): string | null {
    let newest: string | null = null
    for (const concept of concepts) {
        if (concept < before && (newest === null || concept > newest) && isJournalConcept(concept)) newest = concept
    }
    return newest
}

export interface JournalRollState {
    /** The days loaded, newest first. */
    loaded: readonly string[]
    /** The day the bar below the last loaded day offers, or null when nothing older was written. */
    next: string | null
    /** Whether the roll holds as many days as it may; the bar then opens `next` in its own tab. */
    atCap: boolean
}

export interface JournalRoll {
    state(): JournalRollState
    /** Load the day offered, unless there is none or the roll is at its cap. Returns the day loaded. */
    load(): string | null
    /** Unload `day` and every older day loaded below it. */
    hideFrom(day: string): void
    /** Work out the day offered again, after the registry changed. */
    refresh(): void
}

export interface JournalRollOptions {
    /** The tab's own entry: the roll starts below it and never goes newer. */
    anchor: string
    /** The registry's concepts as they are now. */
    entries: () => Iterable<string>
    cap?: number
    /** Hears every change of state. */
    onChange?: (state: JournalRollState) => void
}

export function createJournalRoll({ anchor, entries, cap = JOURNAL_ROLL_CAP, onChange }: JournalRollOptions): JournalRoll {
    let loaded: string[] = []
    let state = compute()

    function compute(): JournalRollState {
        return { loaded, next: olderEntry(entries(), loaded.at(-1) ?? anchor), atCap: loaded.length >= cap }
    }

    function update(): void {
        const next = compute()
        if (next.loaded === state.loaded && next.next === state.next && next.atCap === state.atCap) return
        state = next
        onChange?.(state)
    }

    return {
        state: () => state,
        load() {
            const day = state.next
            if (day === null || state.atCap) return null
            loaded = [...loaded, day]
            update()
            return day
        },
        hideFrom(day) {
            const at = loaded.indexOf(day)
            if (at < 0) return
            loaded = loaded.slice(0, at)
            update()
        },
        refresh: update,
    }
}
