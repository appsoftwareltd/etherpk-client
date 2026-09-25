/**
 * The [[Task Tag]] grammar (ADR 0032), as one pure parser.
 *
 * A [[Task]]'s metadata is a **contiguous leading run of hash-tags immediately after the
 * checkbox**, and nothing else on the line is metadata. Parsing therefore stops dead at the
 * first token that is not a tag - which is the whole point of the grammar: `#hashtags` in
 * prose stay prose, so a task can talk about `#P1 incidents` without claiming to be one.
 *
 * Lives here rather than inside the index derivation because three consumers need the same
 * answer: the derivation (which stores the parsed values as columns), the [[Tasks View]]
 * (which strips the run for display), and - when they land - the editor's tag rendering and
 * kanban [[Lane]]s. ADR 0032 is explicit that those should parse this grammar rather than
 * invent a parallel one.
 *
 * Pure and DOM-free.
 */

/** Priority is a three-level scale; ADR 0032 dropped the below-normal levels at import. */
export type TaskPriority = 1 | 2 | 3

export interface TaskTags {
    priority: TaskPriority | null
    waiting: boolean
    /** `#D` — doing (in progress). One of ADR 0032's three minted extensions; dated `#D-` is due. */
    doing: boolean
    /** `#C` — minted; a cancelled task is *checked*, so the tag carries the truth. */
    cancelled: boolean
    /** `YYYY-MM-DD`, or null. Kept as a string: it sorts and compares correctly as one. */
    due: string | null
    completion: string | null
    /** `#S-` — minted, from Logseq's SCHEDULED. */
    scheduled: string | null
    /** The text with the leading tag run removed — what a task list displays. */
    text: string
}

const EMPTY: Omit<TaskTags, 'text'> = {
    priority: null,
    waiting: false,
    doing: false,
    cancelled: false,
    due: null,
    completion: null,
    scheduled: null,
}

/**
 * Tags are **case-sensitive** (ADR 0032), so `#p1` and `#d` are prose, not metadata.
 * Dates are shape-matched, not calendar-validated: `#D-2026-13-45` is still a date-shaped
 * tag. Shape is what makes string ordering equal date ordering, and a wrong date is the
 * user's to see and fix, not ours to silently drop.
 */
const DATE = /^(\d{4}-\d{2}-\d{2})$/

/** Where the checkbox ends on a raw task line, or -1 when the line is not a task. */
const CHECKBOX = /^\s*-\s+\[([ xX])\]\s?/

type TagKind = 'priority' | 'waiting' | 'doing' | 'cancelled' | 'due' | 'completion' | 'scheduled'

/** Read one token as a tag, or null if it is not one (which ends the run). */
function readTag(token: string): { kind: TagKind; value: string } | null {
    if (token === '#W') return { kind: 'waiting', value: '' }
    // A bare letter is a state; the same letter with a date (matched below) is a date. So
    // `#D` is doing where `#D-YYYY-MM-DD` is due, and `#C` is cancelled where `#C-YYYY-MM-DD`
    // is completion. The words the two were minted as (`#doing`, `#cancelled`) are NOT read:
    // ADR 0032 re-minted them before any production graph carried them.
    if (token === '#D') return { kind: 'doing', value: '' }
    if (token === '#C') return { kind: 'cancelled', value: '' }
    if (token === '#P1' || token === '#P2' || token === '#P3') {
        return { kind: 'priority', value: token.slice(2) }
    }
    const dated = /^#([DCS])-(.+)$/.exec(token)
    if (dated && DATE.test(dated[2])) {
        const kind = dated[1] === 'D' ? 'due' : dated[1] === 'C' ? 'completion' : 'scheduled'
        return { kind, value: dated[2] }
    }
    return null
}

/**
 * Parse the leading tag run of a task's text — the label, i.e. the line with its `- [ ]`
 * marker already stripped. {@link parseTaskLine} handles a raw source line instead.
 *
 * **First of a kind wins** (ADR 0032): a second `#P2` after a `#P1` is still a tag, so it
 * does not end the run, but it is ignored. That way a stray duplicate costs the user the
 * tag, never the rest of their metadata.
 */
export function parseTaskTags(label: string): TaskTags {
    const tags = { ...EMPTY }
    // Tokens are whitespace-separated; `rest` tracks where the run ended in the ORIGINAL
    // string so the returned text keeps its own spacing rather than a re-joined guess.
    let rest = label
    for (;;) {
        const match = /^(\s*)(\S+)/.exec(rest)
        if (!match) break
        const tag = readTag(match[2])
        if (!tag) break
        switch (tag.kind) {
            case 'priority':
                if (tags.priority === null) tags.priority = Number(tag.value) as TaskPriority
                break
            case 'waiting':
                tags.waiting = true
                break
            case 'doing':
                tags.doing = true
                break
            case 'cancelled':
                tags.cancelled = true
                break
            case 'due':
                if (tags.due === null) tags.due = tag.value
                break
            case 'completion':
                if (tags.completion === null) tags.completion = tag.value
                break
            case 'scheduled':
                if (tags.scheduled === null) tags.scheduled = tag.value
                break
        }
        rest = rest.slice(match[0].length)
    }
    return { ...tags, text: rest.trimStart() }
}

/** A raw source line's task state, or null when the line is not a [[Task]]. */
export interface ParsedTaskLine extends TaskTags {
    done: boolean
}

/**
 * Parse a whole source line as a task. Returns null for anything that is not a task line,
 * which is what makes this usable as the [[Tasks View]]'s stale-line guard: a line that no
 * longer parses as a task is proof the index has drifted from the document.
 */
export function parseTaskLine(line: string): ParsedTaskLine | null {
    const marker = CHECKBOX.exec(line)
    if (!marker) return null
    return { done: marker[1].toLowerCase() === 'x', ...parseTaskTags(line.slice(marker[0].length)) }
}

/**
 * Where a raw source line's tag run sits: the columns from its first tag to the end of its last,
 * or null when the line is not a task or carries no tags. Read off {@link parseTaskTags}, so the
 * run is exactly what the grammar calls metadata: what [[Spell Check]] leaves alone.
 */
export function taskTagRun(line: string): { from: number; to: number } | null {
    const marker = CHECKBOX.exec(line)
    if (!marker) return null
    const label = line.slice(marker[0].length)
    // `text` is what follows the run, trimmed at its start: the run ends before that whitespace.
    const { text } = parseTaskTags(label)
    const run = label.slice(0, label.length - text.length)
    const from = marker[0].length + (run.length - run.trimStart().length)
    const to = marker[0].length + run.trimEnd().length
    return to > from ? { from, to } : null
}

/**
 * Flip a task line's checkbox, preserving everything else about the line byte for byte —
 * indentation, marker spacing, tag run and text. Returns null when the line is not a task.
 */
export function toggleTaskLine(line: string, done: boolean): string | null {
    const marker = /^(\s*-\s+\[)([ xX])(\])/.exec(line)
    if (!marker) return null
    return line.slice(0, marker[1].length) + (done ? 'x' : ' ') + line.slice(marker[1].length + 1)
}

/** A change to make to a [[Task]]'s tag run, as the `#` helper issues them. */
export type TaskTagCommand =
    | { kind: 'priority'; value: TaskPriority }
    | { kind: 'waiting' }
    | { kind: 'doing' }
    | { kind: 'cancelled' }
    | { kind: 'due' | 'scheduled' | 'completion'; value: string }

/** The order tags are written back in. Fixed, so the same set always reads the same way. */
const TAG_ORDER = ['priority', 'waiting', 'doing', 'cancelled', 'scheduled', 'due', 'completion'] as const

export function serialiseTags(tags: TaskTags): string[] {
    const out: string[] = []
    for (const kind of TAG_ORDER) {
        if (kind === 'priority' && tags.priority !== null) out.push(`#P${tags.priority}`)
        else if (kind === 'waiting' && tags.waiting) out.push('#W')
        else if (kind === 'doing' && tags.doing) out.push('#D')
        else if (kind === 'cancelled' && tags.cancelled) out.push('#C')
        else if (kind === 'scheduled' && tags.scheduled !== null) out.push(`#S-${tags.scheduled}`)
        else if (kind === 'due' && tags.due !== null) out.push(`#D-${tags.due}`)
        else if (kind === 'completion' && tags.completion !== null) out.push(`#C-${tags.completion}`)
    }
    return out
}

/**
 * Apply one tag change to a task line, returning the rewritten line (null if not a task).
 *
 * The semantics are AS Notes': issuing a **state** tag that is already set removes it, so the
 * same menu row both sets and clears — which is what makes the helper usable without a
 * separate "remove" list. Issuing a *different* priority replaces the current one, because
 * only the first of a kind counts (ADR 0032) and leaving both would silently ignore one.
 * A **date** tag always replaces: picking a date means that date.
 *
 * The run is rewritten in a fixed order rather than appended to, so a task's metadata reads
 * the same way whatever order it was set in. That does reorder tags the user typed by hand —
 * accepted deliberately: the run is an unordered set by definition (first of a kind wins),
 * and a predictable rendering is worth more than preserving an order that carries no meaning.
 */
export function applyTaskTag(line: string, command: TaskTagCommand): string | null {
    const marker = /^(\s*)(-\s+\[[ xX]\])\s?/.exec(line)
    if (!marker) return null
    const [, indent, checkbox] = marker
    const tags = parseTaskTags(line.slice(marker[0].length))

    switch (command.kind) {
        case 'priority':
            tags.priority = tags.priority === command.value ? null : command.value
            break
        case 'waiting':
            tags.waiting = !tags.waiting
            break
        case 'doing':
            tags.doing = !tags.doing
            break
        case 'cancelled':
            tags.cancelled = !tags.cancelled
            break
        default:
            tags[command.kind] = command.value
    }

    // Exactly one space between the checkbox, each tag, and the text — and no trailing
    // space when a task has tags but no text yet, which is how it looks mid-typing.
    return [indent + checkbox, ...serialiseTags(tags), tags.text].filter((part) => part !== '').join(' ')
}
