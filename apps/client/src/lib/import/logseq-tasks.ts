/**
 * Logseq task-marker parsing (the plan's task table). Markers sit at the start of a
 * bullet's content (`- TODO [#A] text`); DEADLINE / SCHEDULED / LOGBOOK live on the
 * block's continuation lines and are handled by the Logseq converter's line walk -
 * this module owns just the marker/priority grammar.
 */

import type { TaskTags } from './task-tags'

export interface LogseqTask {
    done: boolean
    tags: TaskTags
    /** The bullet's text after marker and priority are consumed. */
    text: string
}

const MARKER =
    /^(TODO|LATER|NOW|DOING|IN-PROGRESS|WAIT|WAITING|DONE|CANCELED|CANCELLED)(?:\s+|$)/
const PRIORITY = /^\[#([ABC])\]\s*/

/** Parse a bullet's content; `null` when it does not start with a task marker. */
export function parseLogseqTask(content: string): LogseqTask | null {
    const marker = MARKER.exec(content)
    if (!marker) return null
    let text = content.slice(marker[0].length)

    const tags: TaskTags = {}
    let done = false
    switch (marker[1]) {
        case 'NOW':
        case 'DOING':
        case 'IN-PROGRESS':
            tags.doing = true
            break
        case 'WAIT':
        case 'WAITING':
            tags.waiting = true
            break
        case 'DONE':
            done = true
            break
        case 'CANCELED':
        case 'CANCELLED':
            done = true
            tags.cancelled = true
            break
        // TODO / LATER: plain open task.
    }

    const priority = PRIORITY.exec(text)
    if (priority) {
        tags.priority = ({ A: 1, B: 2, C: 3 } as const)[priority[1] as 'A' | 'B' | 'C']
        text = text.slice(priority[0].length)
    }

    return { done, tags, text }
}

/** The ISO date inside an org-style timestamp `<2026-03-20 Fri 10:00 .+1w>`, or `null`. */
export function orgTimestampDate(value: string): string | null {
    const match = /<(\d{4}-\d{2}-\d{2})[^>]*>/.exec(value)
    return match ? match[1] : null
}
