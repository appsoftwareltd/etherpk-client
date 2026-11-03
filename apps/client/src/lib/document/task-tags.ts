/**
 * The [[Task Tag]] grammar (ADR 0032), as one pure parser.
 *
 * A [[Task]]'s metadata is a **contiguous leading run of hash-tags immediately after the
 * checkbox**, and nothing else on the line is metadata. Parsing therefore stops dead at the
 * first token that is not a tag - which is the whole point of the grammar: `#hashtags` in
 * prose stay prose, so a task can talk about `#P1 incidents` without claiming to be one.
 * The editor does not leave a Task Tag typed later in a task as prose, though: tidy on leave moves
 * it into the run when the caret leaves the task ({@link applyStrayTaskTags}, ADR 0032 amended
 * 2026-11-03), so such words go in backticks there.
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
    /** `#T` — test: unticked and waiting on a check before it is done (ADR 0167). */
    test: boolean
    /** `#C` — minted; a cancelled task is *checked*, so the tag carries the truth. */
    cancelled: boolean
    /** `#A` — archived: ticked, and off every [[Kanban Board]] (ADR 0167). */
    archived: boolean
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
    test: false,
    cancelled: false,
    archived: false,
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

/** Whether `value` is a date as a dated task tag writes one: `YYYY-MM-DD`. */
export function isTaskDate(value: string): boolean {
    return DATE.test(value)
}

/** Where the checkbox ends on a raw task line, or -1 when the line is not a task. */
const CHECKBOX = /^\s*-\s+\[([ xX])\]\s?/

type TagKind = 'priority' | 'waiting' | 'doing' | 'test' | 'cancelled' | 'archived' | 'due' | 'completion' | 'scheduled'

/**
 * The bare-letter state tags and how each is written, in the order a tag run writes them. A bare
 * letter is a state; the same letter with a date is a date, so `#D` is doing where `#D-YYYY-MM-DD`
 * is due, and `#C` is cancelled where `#C-YYYY-MM-DD` is completion. The words two were minted as
 * (`#doing`, `#cancelled`) are NOT read: ADR 0032 re-minted them before any production graph
 * carried them. `#T` and `#A` came with ADR 0167.
 */
const STATE_TAGS = [
    ['waiting', '#W'],
    ['doing', '#D'],
    ['test', '#T'],
    ['cancelled', '#C'],
    ['archived', '#A'],
] as const

type StateKind = (typeof STATE_TAGS)[number][0]

const STATE_BY_TOKEN = new Map<string, StateKind>(STATE_TAGS.map(([kind, token]) => [token, kind]))

/** Read one token as a tag, or null if it is not one (which ends the run). */
function readTag(token: string): { kind: TagKind; value: string } | null {
    const state = STATE_BY_TOKEN.get(token)
    if (state) return { kind: state, value: '' }
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
        case 'test':
        case 'cancelled':
        case 'archived':
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
const TASK_TAG_SHAPED = /^(?:P\d+|W|D|T|C|A|[DCS]-[\d-]*)$/i

/** Whether `word` (without its `#`) can be a [[Free Tag]]: what the Task Editor checks a new tag by. */
export function isFreeTagWord(word: string): boolean {
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
 * `which` keeps the tags it says no to: the Task Editor takes out one tag and leaves the rest.
 */
export function withoutFreeTags(text: string, which: (word: string) => boolean = () => true): string {
    let out = ''
    let at = 0
    for (const { word, from, to } of freeTagMatches(text)) {
        if (!which(word)) continue
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

/**
 * The [[Task Status]]es, in the order a task moves through them. Mutually exclusive by
 * construction ({@link taskStatus}), so a task is in exactly one.
 */
export type TaskStatus = 'open' | 'doing' | 'waiting' | 'test' | 'done' | 'cancelled' | 'archived'

/**
 * A task's [[Task Status]], from its checkbox and its bare-letter tags: the one statement of the
 * rule, which the index's SQL (`STATUS_SQL` in index-db.ts) mirrors.
 *
 * A ticked task is Archived with `#A`, otherwise Cancelled with `#C`, otherwise Done. An unticked
 * one takes the state furthest along that it carries: Test, then Waiting, then Doing, then Open.
 * A state the checkbox contradicts (`#A` unticked, `#T` ticked) is ignored, so the checkbox alone
 * decides whether a task is finished.
 */
export function taskStatus(done: boolean, tags: Pick<TaskTags, 'waiting' | 'doing' | 'test' | 'cancelled' | 'archived'>): TaskStatus {
    if (done) return tags.archived ? 'archived' : tags.cancelled ? 'cancelled' : 'done'
    return tags.test ? 'test' : tags.waiting ? 'waiting' : tags.doing ? 'doing' : 'open'
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
    | { kind: 'test' }
    | { kind: 'cancelled' }
    | { kind: 'archived' }
    | { kind: 'due' | 'scheduled' | 'completion'; value: string }

/**
 * The tag run for `tags`, in a fixed order (priority, the states, then scheduled, due and
 * completion), so the same set always reads the same way.
 */
export function serialiseTags(tags: TaskTags): string[] {
    const out: string[] = []
    if (tags.priority !== null) out.push(`#P${tags.priority}`)
    for (const [kind, token] of STATE_TAGS) if (tags[kind]) out.push(token)
    if (tags.scheduled !== null) out.push(`#S-${tags.scheduled}`)
    if (tags.due !== null) out.push(`#D-${tags.due}`)
    if (tags.completion !== null) out.push(`#C-${tags.completion}`)
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
        case 'doing':
        case 'test':
        case 'cancelled':
        case 'archived':
            tags[command.kind] = !tags[command.kind]
            break
        default:
            tags[command.kind] = command.value
    }

    // Exactly one space between the checkbox, each tag, and the text — and no trailing
    // space when a task has tags but no text yet, which is how it looks mid-typing.
    return [indent + checkbox, ...serialiseTags(tags), tags.text].filter((part) => part !== '').join(' ')
}

// ── Writing a status (ADR 0113) ───────────────────────────────────────────────────────────

/** What to change about a task. Anything left out stays as it is. */
export interface TaskChanges {
    status?: TaskStatus
    priority?: TaskPriority | null
    /** `YYYY-MM-DD`, or null to remove the date. */
    due?: string | null
    scheduled?: string | null
}

const MARKER = /^(\s*-\s+\[)[ xX](\])\s?/

/**
 * `line` with `changes` made, or null when `line` is not a task.
 *
 * A changed tag run is written in the fixed order the `#` helper writes (`serialiseTags`), for
 * the reason `applyTaskTag` gives: the run is a set, and a predictable order is worth more than
 * one that carries no meaning. A task already as asked comes back untouched, so a move that
 * changes nothing reorders nothing either.
 */
export function taskLineWith(line: string, changes: TaskChanges): string | null {
    const parsed = parseTaskLine(line)
    const marker = MARKER.exec(line)
    if (!parsed || !marker) return null
    const { done: wasDone, ...current } = parsed
    const tags: TaskTags = { ...current }
    const done = changes.status === undefined ? wasDone : withStatus(tags, changes.status)
    if (changes.priority !== undefined) tags.priority = changes.priority
    if (changes.due !== undefined) tags.due = changes.due
    if (changes.scheduled !== undefined) tags.scheduled = changes.scheduled
    if (done === wasDone && sameTags(tags, current)) return line
    // One space between the checkbox, each tag and the text, and none at the end when a task has
    // tags but no text: the way the `#` helper writes a run.
    return [`${marker[1]}${done ? 'x' : ' '}${marker[2]}`, ...serialiseTags(tags), tags.text].filter((part) => part !== '').join(' ')
}

/** How each [[Task Status]] is written: its checkbox, and the state tag it carries, if any. */
const STATUS_LINE: Record<TaskStatus, { done: boolean; state: StateKind | null }> = {
    open: { done: false, state: null },
    doing: { done: false, state: 'doing' },
    waiting: { done: false, state: 'waiting' },
    test: { done: false, state: 'test' },
    done: { done: true, state: null },
    cancelled: { done: true, state: 'cancelled' },
    archived: { done: true, state: 'archived' },
}

/**
 * Write `status` into `tags`, exclusive as a status is: its one state tag set and every other
 * state cleared. Returns whether the checkbox is ticked.
 */
function withStatus(tags: TaskTags, status: TaskStatus): boolean {
    const line = STATUS_LINE[status]
    for (const [state] of STATE_TAGS) tags[state] = state === line.state
    return line.done
}

function sameTags(a: TaskTags, b: TaskTags): boolean {
    return (
        a.priority === b.priority &&
        STATE_TAGS.every(([state]) => a[state] === b[state]) &&
        a.due === b.due &&
        a.scheduled === b.scheduled &&
        a.completion === b.completion
    )
}

// ── Stray Task Tags (Editor Content Rules → Tidy on leave) ────────────────────────────────

/** A word of a line: whitespace or the line's edge on both sides. */
const WORD = /(?<=^|\s)\S+(?=\s|$)/g

/** Columns of a line that hold no prose, such as inline maths, which the caller finds. */
export interface LineSpan {
    from: number
    to: number
}

/** The `#` helper's command for a Task Tag read off the text. */
function commandFor(tag: { kind: TagKind; value: string }): TaskTagCommand {
    switch (tag.kind) {
        case 'priority':
            return { kind: 'priority', value: Number(tag.value) as TaskPriority }
        case 'due':
        case 'scheduled':
        case 'completion':
            return { kind: tag.kind, value: tag.value }
        default:
            return { kind: tag.kind }
    }
}

/**
 * `line` with one stray tag set. A state tag sets the [[Task Status]] it names, as a [[Kanban Board]]
 * move to that lane writes it ({@link taskLineWith}): its one state tag, and the checkbox ticked for
 * `#C` and `#A` and unticked for `#W`, `#D` and `#T`, because a state the checkbox contradicts counts
 * for nothing and the person who typed `#C` meant the task cancelled. A priority or a date is set as
 * the `#` helper sets it ({@link applyTaskTag}), except that a priority the run already carries is
 * kept rather than cleared by the helper's toggle; a date always replaces, so it is already a set.
 */
function withStrayTag(line: string, command: TaskTagCommand): string {
    if (isStateCommand(command)) return taskLineWith(line, { status: command.kind }) ?? line
    if (command.kind === 'priority' && parseTaskLine(line)?.priority === command.value) return line
    return applyTaskTag(line, command) ?? line
}

const STATE_KINDS = new Set<string>(STATE_TAGS.map(([kind]) => kind))

/** Whether `command` sets a bare-letter state, whose kind is also the [[Task Status]] it names. */
function isStateCommand(command: TaskTagCommand): command is { kind: StateKind } {
    return STATE_KINDS.has(command.kind)
}

/** `text` with the columns of `span` (clamped to it) blanked to spaces, every offset kept. */
function blanked(text: string, span: LineSpan): string {
    const from = Math.max(0, span.from)
    const to = Math.min(text.length, span.to)
    return to <= from ? text : text.slice(0, from) + ' '.repeat(to - from) + text.slice(to)
}

/**
 * The Task Tags in a label written after its leading run, each as its own word and in prose: a tag
 * in a code span, a link or an autolink is part of that (blanked as for Free Tags), as is one in a
 * `skip` span (label columns), and one joined to other characters (`#P1,`, `item#P1`, a URL's
 * `/#P1`) is not a word of its own.
 */
function strayTagsIn(label: string, skip: readonly LineSpan[]): { from: number; to: number; command: TaskTagCommand }[] {
    const runEnd = scanRun(label).end
    const prose = skip.reduce(
        (text, span) => blanked(text, span),
        label.replace(NOT_PROSE, (span) => ' '.repeat(span.length)),
    )
    const out: { from: number; to: number; command: TaskTagCommand }[] = []
    for (const match of label.matchAll(WORD)) {
        const from = match.index
        const to = from + match[0].length
        if (from < runEnd || prose.slice(from, to) !== match[0]) continue
        const tag = readTag(match[0])
        if (tag) out.push({ from, to, command: commandFor(tag) })
    }
    return out
}

/**
 * A task line with its stray [[Task Tag]]s moved into the leading run, or null when the line is not
 * a task or has none. A person who types `#P1` at the end of a task means it as metadata, but the
 * grammar reads only the leading run (ADR 0032), so the tag would sit there as prose.
 *
 * Each stray word is taken out with the whitespace before it, and its tag set in the order written
 * ({@link withStrayTag}): a later `#P2` replaces a leading `#P1`, a date replaces the date of its
 * kind, and a state tag sets the task's [[Task Status]], ticking or unticking the checkbox to match,
 * so of several state tags the last written wins. A stray tag never clears: a priority the run
 * already carries stays set, because a typed tag says what the person wants and no menu showed them
 * it was set. [[Free Tag]]s stay where they are written. `skip` holds the line's columns that are not
 * prose beyond what this module can see (inline maths). Tidy on leave (`view/leave-tidy.ts`) calls
 * this as the caret leaves the task, never while it is being typed in, and brings the nested tasks
 * along when the status it sets ticks, archives or unticks the task (`task-cascade.ts`).
 */
export function applyStrayTaskTags(line: string, skip: readonly LineSpan[] = []): string | null {
    const marker = CHECKBOX.exec(line)
    if (!marker) return null
    const start = marker[0].length
    const label = line.slice(start)
    const strays = strayTagsIn(
        label,
        skip.map(({ from, to }) => ({ from: from - start, to: to - start })),
    )
    if (strays.length === 0) return null
    let rest = ''
    let at = 0
    for (const { from, to } of strays) {
        rest += label.slice(at, from).trimEnd()
        at = to
    }
    let out = line.slice(0, start) + rest + label.slice(at)
    for (const { command } of strays) out = withStrayTag(out, command)
    return out === line ? null : out
}
