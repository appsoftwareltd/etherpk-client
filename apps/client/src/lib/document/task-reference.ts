/**
 * A [[Task Reference]] (ADR 0114): what a person copies from a task to hand it to an agent. Two
 * lines, the task's words and then its [[Document URL]] with `#task=<line>-<fingerprint>` as the
 * fragment. The [[Headless Client]] and the Client both resolve it back to the task by its
 * position and its words, so nothing is written into the document, and a reference survives the
 * lines added above its task and the tags rewritten on it while an agent works.
 *
 * The fingerprint is the first 12 hex characters (48 bits) of the SHA-256 of the task's words:
 * the text after the checkbox and the [[Task Tag]] run, whitespace collapsed, Unicode NFC. Two
 * unrelated tasks sharing one by chance is not a practical concern at that length; two tasks with
 * the same words share it by design, and are reported as ambiguous rather than guessed between.
 *
 * Framework-free, and shared with the Headless Client through the `$lib` alias.
 */
import { documentUrl } from '../navigation/document-url'
import { fencedBlocks } from './fenced-code'
import { TASK_PRIORITY_FILTERS, TASK_STATUSES, type TaskQuery } from './index-db'
import { bulletLabel } from './index-derive'
import { parseTaskLine, parseTaskTags } from './task-tags'

/** The hex characters of the SHA-256 a reference keeps. */
export const FINGERPRINT_LENGTH = 12

export interface TaskReference {
    graphId: string
    /** The document's name when the reference was made; a rename is followed on resolving. */
    document: string
    /** 0-based body line, as the index, `tasks` and `read_document` count lines. */
    line: number
    fingerprint: string
}

/**
 * The words that identify a task while its tags change: the text after the checkbox and the tag
 * run, whitespace collapsed and Unicode NFC applied. A task written as tags alone is its tags.
 */
export function taskWords(label: string): string {
    const text = parseTaskTags(label).text || label
    return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The fingerprint of a task's words, from its label (tag run included or not). */
export async function taskFingerprint(label: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskWords(label)))
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, FINGERPRINT_LENGTH)
}

/** The reference's address: the Document URL with the task in its fragment, which a browser never sends. */
export function taskReferenceUrl(reference: TaskReference, origin = ''): string {
    return `${origin}${documentUrl(reference.graphId, reference.document)}#task=${reference.line}-${reference.fingerprint}`
}

/** The two lines a person copies: the task's words, then the address. */
export function formatTaskReference(reference: TaskReference, label: string, origin = ''): string {
    return `${taskWords(label)}\n${taskReferenceUrl(reference, origin)}`
}

const REFERENCE = /\/g\/([^/?#\s]+)\/d\/([^?#\s]+?)(?:\?[^#\s]*)?#task=(\d+)-([0-9a-f]{12})(?![0-9a-f])/

/**
 * The reference in `input`: the two lines as copied, the address alone, with any origin or none,
 * or null when `input` holds none.
 */
export function parseTaskReference(input: string): TaskReference | null {
    const match = REFERENCE.exec(input)
    if (!match) return null
    const [, graph, path, line, fingerprint] = match
    try {
        return {
            graphId: decodeURIComponent(graph),
            document: path.split('/').map(decodeURIComponent).join('/'),
            line: Number(line),
            fingerprint,
        }
    } catch {
        // A malformed escape: this is no address EtherPK wrote.
        return null
    }
}

/** How a task was found: at the line the reference names, elsewhere in its document, or in another. */
export type TaskFoundBy = 'at_line' | 'moved' | 'other_document'

export interface ResolvedTaskReference {
    ok: true
    /** The document's name now. */
    document: string
    /** The task's 0-based body line now. */
    line: number
    /** The document's body as it was read, for a caller that goes on to read or write the task. */
    body: string
    foundBy: TaskFoundBy
}

export type TaskReferenceRefusal =
    | { ok: false; code: 'task_not_found' }
    | { ok: false; code: 'task_ambiguous'; candidates: { document: string; line: number }[] }
    | { ok: false; code: 'other_graph'; servedGraphId: string }

/** What resolving needs from wherever the graph is: the Client's workspace or the Headless Client. */
export interface TaskReferenceSources {
    /** The graph served, or null for a folder graph, whose id is local to each browser and is not checked. */
    graphId: string | null
    /** The name a document answers to now, through its aliases and whatever the case, or null. */
    resolveDocument(name: string): string | null
    /** A document's body, the text below any frontmatter, or null when it cannot be read. */
    readBody(document: string): Promise<string | null>
    /** Every task the index knows, by document, body line and label: where else to look. */
    allTasks(): Promise<readonly { document: string; line: number; label: string }[]>
}

/**
 * Find the task a reference names. First the named document's line, when the words there match;
 * then the one task in that document with those words; then the one task in the graph. None is
 * `task_not_found`, more than one `task_ambiguous`, since acting on a guess could change the
 * wrong task. A document that no longer answers to its name goes straight to the graph.
 */
export async function resolveTaskReference(reference: TaskReference, sources: TaskReferenceSources): Promise<ResolvedTaskReference | TaskReferenceRefusal> {
    if (sources.graphId !== null && sources.graphId !== reference.graphId) {
        return { ok: false, code: 'other_graph', servedGraphId: sources.graphId }
    }
    const named = sources.resolveDocument(reference.document)
    if (named !== null) {
        const body = await sources.readBody(named)
        if (body !== null) {
            const lines = body.split('\n')
            const matches = await taskLinesWith(lines, reference.fingerprint)
            if (matches.includes(reference.line)) return { ok: true, document: named, line: reference.line, body, foundBy: 'at_line' }
            if (matches.length === 1) return { ok: true, document: named, line: matches[0], body, foundBy: 'moved' }
            if (matches.length > 1) return { ok: false, code: 'task_ambiguous', candidates: matches.map((line) => ({ document: named, line })) }
        }
    }
    // Elsewhere in the graph: the index says where to look, and each document is read to confirm,
    // since the index can be a moment behind the text.
    const found: { document: string; line: number; body: string }[] = []
    const looked = new Set<string>(named === null ? [] : [named.toLowerCase()])
    for (const task of await sources.allTasks()) {
        if (looked.has(task.document.toLowerCase())) continue
        if ((await taskFingerprint(task.label)) !== reference.fingerprint) continue
        looked.add(task.document.toLowerCase())
        const body = await sources.readBody(task.document)
        if (body === null) continue
        for (const line of await taskLinesWith(body.split('\n'), reference.fingerprint)) found.push({ document: task.document, line, body })
    }
    if (found.length === 1) return { ok: true, ...found[0], foundBy: 'other_document' }
    if (found.length > 1) return { ok: false, code: 'task_ambiguous', candidates: found.map(({ document, line }) => ({ document, line })) }
    return { ok: false, code: 'task_not_found' }
}

/** The one round trip `everyIndexedTask` needs from an index client. */
export interface IndexedTaskSource {
    tasks(query: TaskQuery, offset: number, limit: number): Promise<{ hits: readonly { concept: string; line: number; text: string }[]; hasMore: boolean }>
}

/** How many tasks `everyIndexedTask` asks the index for at a time. */
const INDEX_PAGE = 500

/** Every task the index knows, in pages, as {@link TaskReferenceSources.allTasks} wants them. */
export async function everyIndexedTask(index: IndexedTaskSource, today: string): Promise<{ document: string; line: number; label: string }[]> {
    const query: TaskQuery = { concept: null, statuses: TASK_STATUSES, priorities: TASK_PRIORITY_FILTERS, due: 'any', groupBy: 'document', today }
    const out: { document: string; line: number; label: string }[] = []
    for (let offset = 0; ; offset += INDEX_PAGE) {
        const page = await index.tasks(query, offset, INDEX_PAGE)
        for (const hit of page.hits) out.push({ document: hit.concept, line: hit.line, label: hit.text })
        if (!page.hasMore) return out
    }
}

/** The lines of `lines` that hold a task with this fingerprint, never one inside a code fence. */
async function taskLinesWith(lines: readonly string[], fingerprint: string): Promise<number[]> {
    const inFence = new Set<number>()
    for (const block of fencedBlocks(lines)) for (let i = block.start; i <= block.end; i++) inFence.add(i)
    const out: number[] = []
    for (let i = 0; i < lines.length; i++) {
        if (inFence.has(i) || parseTaskLine(lines[i]) === null) continue
        if ((await taskFingerprint(bulletLabel(lines[i]))) === fingerprint) out.push(i)
    }
    return out
}
