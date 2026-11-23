/**
 * What the app asks before a Sidebar View is closed: by a Secondary Sidebar tab's ×, by a tab
 * menu's close rows, or by **Hide** on an icon of the [[Activity Bar]] (ADR 0198, amended
 * 2026-11-23). A hidden View is hidden in every graph and on every device, so the question names
 * the way back: the View's shortcut, or where it is found when it has none.
 */

import { chordsFor, chordWorks, formatChordHint, type Keybinding } from '#lib/surface/keybindings.js'

export interface ClosingView {
    name: string
    /** The shortcut that shows the View, or null where there is none to name. */
    chord: string | null
}

export interface ClosePrompt {
    title: string
    message: string
    confirmLabel: string
}

const WHERE = 'from Sidebar views, at the foot of the Activity Bar.'

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
    return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function reopening(views: readonly ClosingView[]): string {
    if (views.length === 1) return views[0].chord === null ? `Re-open it ${WHERE}` : `Re-open it with ${views[0].chord}.`
    const withChord = views.filter((view) => view.chord !== null).map((view) => `${view.name} with ${view.chord}`)
    const without = views.filter((view) => view.chord === null).map((view) => view.name)
    return [withChord.length > 0 ? `Re-open ${listed(withChord)}.` : '', without.length > 0 ? `Re-open ${listed(without)} ${WHERE}` : ''].filter(Boolean).join(' ')
}

/** `views` is never empty: with no Sidebar View among what closes, nothing is asked. */
export function closePrompt(views: readonly ClosingView[], verb: 'Close' | 'Hide'): ClosePrompt {
    return { title: `${verb} ${listed(views.map((view) => view.name))}?`, message: reopening(views), confirmLabel: verb }
}

/** The shortcut to name for a View shown by `command`, or null when it has none that works here. */
export function reopeningChord(bindings: readonly Keybinding[], command: string | undefined, apple: boolean): string | null {
    if (command === undefined) return null
    const works = chordsFor(bindings, command, apple).find((spec) => chordWorks(spec, apple))
    return works === undefined ? null : formatChordHint(works, apple)
}
