/**
 * The [[Task Tag]] grammar (ADR 0032), as one pure parser.
 *
 * A [[Task]]'s metadata is a **contiguous leading run of hash-tags immediately after the
 * checkbox**, and nothing else on the line is metadata. Parsing therefore stops dead at the
 * first token that is not a tag - which is the whole point of the grammar: `#hashtags` in
 * prose stay prose, so a task can talk about `#P1 incidents` without claiming to be one.
 *
 * A [[Free Tag]] (`#bug`) is a person's own word, written anywhere in the text, which carries no
 * metadata (ADR 0166). One in the leading run is passed over rather than ending it, so
 * `#bug #P1 Fix the gate` is still priority 1, and it stays in `text`, so rewriting the run never
 * drops it. {@link freeTagsIn} and {@link withoutFreeTags} read them from the text.
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
    /**
     * The text with the leading run's [[Task Tag]]s removed: any [[Free Tag]] in the run first,
     * then what follows the run. A task list shows it without its Free Tags ({@link withoutFreeTags}).
     */
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

/** The leading run of a label: its Task Tags, the Free Tags in it, and where the text after it starts. */
interface LeadingRun {
    tags: Omit<TaskTags, 'text'>
    freeTags: string[]
    /** The offset in the label where the run ends, before the whitespace that follows it. */
    end: number
}

/** Record one tag in `tags`, the first of a kind winning (ADR 0032). */
function recordTag(tags: Omit<TaskTags, 'text'>, tag: { kind: TagKind; value: string }): void {
    switch (tag.kind) {
        case 'priority':
            tags.priority ??= Number(tag.value) as TaskPriority
            break
        case 'waiting':
        case 'doing':
        case 'cancelled':
            tags[tag.kind] = true
            break
        default:
            // The dated tags: due, completion and scheduled.
            tags[tag.kind] ??= tag.value
    }
}

function scanRun(label: string): LeadingRun {
    const tags = { ...EMPTY }
    const freeTags: string[] = []
    // Tokens are whitespace-separated; `offset` tracks where the run ended in the ORIGINAL
    // string so the returned text keeps its own spacing rather than a re-joined guess.
    let offset = 0
    for (;;) {
        const match = /^(\s*)(\S+)/.exec(label.slice(offset))
        if (!match) break
        const tag = readTag(match[2])
        if (tag) recordTag(tags, tag)
        // A Free Tag is passed over, so a person's own tag written first costs no metadata.
        else if (isFreeTagToken(match[2])) freeTags.push(match[2])
        else break
        offset += match[0].length
    }
    return { tags, freeTags, end: offset }
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
    const run = scanRun(label)
    // A run of Task Tags alone keeps the text's own spacing; Free Tags in the run lead it.
    const rest = label.slice(run.end).trimStart()
    const text = [...run.freeTags, rest].filter((part) => part !== '').join(' ')
    return { ...run.tags, text }
}

// ── Free Tags (ADR 0166) ──────────────────────────────────────────────────────────────────

/** A Free Tag's word: letters and digits in words joined by single hyphens. */
const FREE_TAG_WORD = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

/**
 * Anything a [[Task Tag]] is or could be, in any case: `#p1` and `#P4` are not Task Tags, but a
 * person who wrote them meant one, so neither is a Free Tag either.
 */
const TASK_TAG_SHAPED = /^(?:P\d+|W|D|C|[DCS]-[\d-]*)$/i

function isFreeTagWord(word: string): boolean {
    return FREE_TAG_WORD.test(word) && /[A-Za-z]/.test(word) && !TASK_TAG_SHAPED.test(word)
}

/** True when a whitespace-separated token is exactly one Free Tag. */
function isFreeTagToken(token: string): boolean {
    return token.startsWith('#') && isFreeTagWord(token.slice(1))
}

/**
 * What holds hash text that is not prose: code spans, wikilinks, markdown links and images, and
 * autolinks. They are blanked out before looking for Free Tags, keeping every offset.
 */
const NOT_PROSE = /(`+)[\s\S]*?\1|\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>/g

/**
 * A Free Tag in prose: `#` at the start or after whitespace, the word, then the end, whitespace
 * or punctuation. `#bug.` is `bug`; `#my_tag`, `#a/b` and `item#4` are not tags.
 */
const FREE_TAG = /(?<=^|\s)#([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=$|[\s.,;:!?'")\]}])/g

/** Each Free Tag in `text` with where it is, in the order written. */
function freeTagMatches(text: string): { word: string; from: number; to: number }[] {
    const prose = text.replace(NOT_PROSE, (span) => ' '.repeat(span.length))
    const out: { word: string; from: number; to: number }[] = []
    for (const match of prose.matchAll(FREE_TAG)) {
        if (isFreeTagWord(match[1])) out.push({ word: match[1], from: match.index, to: match.index + match[0].length })
    }
    return out
}

/**
 * The [[Free Tag]]s in a task's text, without their `#`, in the order written and once each:
 * matched ignoring case, kept in the spelling first written.
 */
export function freeTagsIn(text: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const { word } of freeTagMatches(text)) {
        const key = word.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(word)
    }
    return out
}

/**
 * The text with its Free Tags taken out, each with the whitespace before it (after it, at the
 * start), so `Fix the gate #bug.` reads `Fix the gate.`. Empty when the text is only Free Tags.
 */
export function withoutFreeTags(text: string): string {
    let out = ''
    let at = 0
    for (const { from, to } of freeTagMatches(text)) {
        const before = text.slice(at, from)
        out += from === 0 ? '' : before.trimEnd()
        at = to
        if (out === '') at += /^\s*/.exec(text.slice(at))![0].length
    }
    return (out + text.slice(at)).trim()
}

/**
 * What a task list shows for a task's label: its words, without the tag run or its Free Tags, and
 * the Free Tags as written, for pills. A task whose text is only Free Tags shows them as its words
 * with no pills, and one written as Task Tags alone shows its tags.
 */
export function taskDisplay(label: string): { text: string; freeTags: string[] } {
    const text = parseTaskTags(label).text
    const words = withoutFreeTags(text)
    return words === '' ? { text: text || label, freeTags: [] } : { text: words, freeTags: freeTagsIn(text) }
}

/** The [[Task Tag]]s in a label's leading run, as written and in order, without the Free Tags in it. */
export function taskTagTokens(label: string): string[] {
    return label.slice(0, scanRun(label).end).split(/\s+/).filter((token) => readTag(token) !== null)
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
    const run = label.slice(0, scanRun(label).end)
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
