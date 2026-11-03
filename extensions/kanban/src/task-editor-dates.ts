/**
 * The calendar the [[Task Editor]]'s Due and Scheduled fields open (ADR 0170): the Client's own Date
 * Picker, the one the document editor shows, asked for through the extension's context
 * (`context.dialogs.pickDate`), so the board and the editor pick a day the same way.
 *
 * The Task Editor is drawn inside a View and by the "Open in task editor" Command, neither of which
 * is handed the context, so the context's dialogs are set here as the extension starts in a graph
 * (register.ts), as its assets are (`task-editor-assets.ts`).
 */
import type { ExtensionDialogs } from '@appsoftwareltd/etherpk-extension-api'

import { isCalendarDay } from '#lib/document/calendar/month-grid-core.js'

let dialogs: Pick<ExtensionDialogs, 'pickDate'> | null = null

/** Set as the extension starts in a graph: each graph it starts in sets its own. */
export function setTaskEditorDialogs(next: Pick<ExtensionDialogs, 'pickDate'> | null): void {
    dialogs = next
}

/**
 * Open the calendar beside a date field, on the date it shows (today when it has none). Resolves to
 * the day picked, `YYYY-MM-DD`, or undefined when the calendar closed without one, which changes
 * nothing. An answer that names no day is treated as none, so the task line only ever gets a whole
 * date.
 */
export async function pickTaskDate(anchor: HTMLElement, label: string, value: string | null): Promise<string | undefined> {
    const picked = await dialogs?.pickDate({ anchor, value: value ?? undefined, label: `${label} date` })
    return picked !== undefined && isCalendarDay(picked) ? picked : undefined
}
