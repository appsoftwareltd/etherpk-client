/**
 * [[Task Tag]] emission (ADR 0032): the checkbox is the only completion state, and all
 * other task metadata is a contiguous leading run of hash-tags immediately after it.
 * The AS Notes parser stops at the first non-tag token, so converters MUST route every
 * tag through {@link leadingTagRun} - a tag placed after prose is plain text by rule.
 */

export interface TaskTags {
    /** 1 = #P1 (critical), 2 = #P2 (high), 3 = #P3 (normal). */
    priority?: 1 | 2 | 3
    waiting?: boolean
    /** In progress (minted tag - Logseq NOW/DOING, Obsidian `[/]`). */
    doing?: boolean
    /** Cancelled (minted tag - the checkbox is checked to keep it out of open-task views). */
    cancelled?: boolean
    /** Due date, ISO `YYYY-MM-DD`. */
    due?: string
    /** Scheduled date, ISO (minted `#S-` tag). */
    scheduled?: string
    /** Completion date, ISO. */
    completed?: string
}

/** The canonical leading run, `''` when there is nothing to emit. */
export function leadingTagRun(tags: TaskTags): string {
    const run: string[] = []
    if (tags.priority) run.push(`#P${tags.priority}`)
    if (tags.waiting) run.push('#W')
    if (tags.doing) run.push('#D')
    if (tags.cancelled) run.push('#C')
    if (tags.due) run.push(`#D-${tags.due}`)
    if (tags.scheduled) run.push(`#S-${tags.scheduled}`)
    if (tags.completed) run.push(`#C-${tags.completed}`)
    return run.join(' ')
}

/** Assemble a converted task line: checkbox, leading tag run, then the prose. */
export function taskLine(
    indent: string,
    bullet: string,
    done: boolean,
    tags: TaskTags,
    text: string,
): string {
    const run = leadingTagRun(tags)
    const parts = [run, text.trim()].filter((p) => p !== '')
    return `${indent}${bullet} [${done ? 'x' : ' '}]${parts.length ? ' ' + parts.join(' ') : ''}`
}
