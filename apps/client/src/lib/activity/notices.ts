/**
 * Notices - "Deleted "Alpha"", "Copied /home/…/Alpha.md", "Could not rename: …", and the
 * standing ones: a save that failed with its Retry, the search index another tab is holding,
 * a record restored from the device's safety copy - shown in the same rail, and the same card,
 * as the [[Activity Toast]]s (ADR 0035). A notice is not an [[Activity]]: nothing is running
 * and there is no progress to report. It shares the rail so that everything the app has to say
 * appears in one place, in one style, rather than a banner per cause in a corner each.
 *
 * The same dismissal rules as a finished toast (`$lib/notice-dismissal`): one that only
 * *reports* goes by itself after the shared delay; one that says something went wrong, or that
 * asks something of the user, stays until closed, because closing it is the acknowledgement.
 * A caller may say `manual` outright for a standing notice, and may hear about the close
 * through `ondismiss` - a once-per-device acknowledgement is recorded there.
 *
 * A plain observable, like the Activity store, and for the same reason: the workspace posts
 * from plain functions, and the host mirrors it into a rune. Keyed by `id` so a surface with
 * one status line (the workspace) replaces its own notice rather than piling up.
 */

import { NOTICE_AUTO_DISMISS_MS, type NoticeDismissal } from '$lib/notice-dismissal'

export type NoticeTone = 'info' | 'error'

/** A button on a notice card. `primary` renders filled, as an Activity's follow-on does. */
export interface NoticeAction {
    label: string
    run: () => void | Promise<void>
    primary?: boolean
    /** Greyed while its work is in flight; the label should say so ("Retrying…"). */
    disabled?: boolean
    /** A stable test hook for the button. */
    id?: string
}

export interface Notice {
    /** Stable per surface: showing another notice under the same id replaces the first. */
    id: string
    tone: NoticeTone
    dismissal: NoticeDismissal
    /** A headline above the text, for a notice with more than a line to say. */
    title?: string
    text: string
    /** Bullet lines under the text: what exactly was restored, say. */
    items?: string[]
    /** A closing line under the bullets. */
    footnote?: string
    actions?: NoticeAction[]
    /** Called when the user closes the card - not when it is replaced, retracted or reset. */
    ondismiss?: () => void
}

/** What a caller supplies: the dismissal is derived from the tone unless said outright. */
export type NoticeInput = Omit<Notice, 'dismissal'> & { dismissal?: NoticeDismissal }

interface Entry extends Notice {
    autoDismiss?: ReturnType<typeof setTimeout>
}

let entries: Entry[] = []
const listeners = new Set<(list: Notice[]) => void>()

function snapshot(): Notice[] {
    return entries.map(({ autoDismiss: _autoDismiss, ...rest }) => ({ ...rest }))
}

function emit(): void {
    const list = snapshot()
    for (const listener of listeners) listener(list)
}

/** Subscribe to the notice list; fires immediately with the current one. Returns an unsubscribe. */
export function subscribeNotices(listener: (list: Notice[]) => void): () => void {
    listeners.add(listener)
    listener(snapshot())
    return () => listeners.delete(listener)
}

/** The current list (a snapshot; prefer {@link subscribeNotices} for reactivity). */
export function getNotices(): Notice[] {
    return snapshot()
}

/**
 * Show a notice, replacing any with the same id in place (its clock restarts). Unless said
 * otherwise an `error` stays until closed and an `info` goes by itself after the shared delay.
 */
export function showNotice(notice: NoticeInput): void {
    const existing = entries.find((e) => e.id === notice.id)
    clearTimeout(existing?.autoDismiss)
    const dismissal: NoticeDismissal = notice.dismissal ?? (notice.tone === 'error' ? 'manual' : 'auto')
    const entry: Entry = { ...notice, dismissal }
    if (dismissal === 'auto') entry.autoDismiss = setTimeout(() => dismissNotice(entry.id), NOTICE_AUTO_DISMISS_MS)
    entries = existing ? entries.map((e) => (e === existing ? entry : e)) : [...entries, entry]
    emit()
}

/** Remove a notice. The surface taking its own notice down; `ondismiss` is not called. */
export function dismissNotice(id: string): void {
    const entry = entries.find((e) => e.id === id)
    if (!entry) return
    clearTimeout(entry.autoDismiss)
    entries = entries.filter((e) => e !== entry)
    emit()
}

/** The user closing a card: removes it and tells its owner. */
export function closeNotice(id: string): void {
    const entry = entries.find((e) => e.id === id)
    if (!entry) return
    dismissNotice(id)
    entry.ondismiss?.()
}

/**
 * Take a notice down early, but only if it still says `text` - a progress line that finished
 * must not pull down the outcome that replaced it meanwhile.
 */
export function retractNotice(id: string, text: string): void {
    const entry = entries.find((e) => e.id === id)
    if (entry?.text === text) dismissNotice(id)
}

/** Test seam: drop every notice. */
export function resetNotices(): void {
    for (const e of entries) clearTimeout(e.autoDismiss)
    entries = []
    emit()
}
