/**
 * The colour a task priority wears wherever the app draws it: a chip in the [[Task Editor]], a label
 * on a [[Kanban Board]] card, a badge in the [[Tasks View]]. Each is one of the graph's ready-made
 * pastels (the toolbar colours in Graph Settings), the warmest for P1.
 */
import { PRESENCE_PALETTE } from '#lib/sync/presence-identity.js'

import type { TaskPriority } from './task-tags'

function pastel(label: string): string {
    const found = PRESENCE_PALETTE.find((entry) => entry.label === label)
    if (!found) throw new Error(`No ready-made colour is called ${label}`)
    return found.color
}

const COLOURS: Record<TaskPriority, string> = { 1: pastel('Salmon'), 2: pastel('Peach'), 3: pastel('Sky') }

/** Null for no priority, which has no colour. */
export function priorityColour(priority: TaskPriority | null): string | null {
    return priority === null ? null : COLOURS[priority]
}

/**
 * The colours of a priority label, read from `--priority-colour` (set it to `priorityColour`). The
 * pastel is the text on the dark theme, and the fill under dark ink on the light theme, where a
 * pastel as text is under 2:1 on any surface.
 */
export const PRIORITY_LABEL_CLASSES = 'bg-(--priority-colour) text-neutral-900 dark:bg-(--gk-surface-2) dark:text-(--priority-colour)'
