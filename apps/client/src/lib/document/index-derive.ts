/**
 * The pure index-derivation layer (Dual Mode Editor.md → The derived index store).
 * Turns one document's text into the rows the SQLite index stores: blocks (with
 * parent/order/kind/range), wikilink occurrences (tagged with their containing
 * block, for outline-chain backlinks), and tasks.
 *
 * This is the *shared* derivation — the same pure code the server runs over the same
 * content, which is what makes the client and server indexes compatible by
 * construction (ADR 0015). Pure and DOM-free.
 */

import { conceptKey } from './backlinks/backlink-index'
import { type Block, parseBlocks } from './block-model'
import { fencedBlocks } from './fenced-code'
import { containsCipherFence } from './protection/fence-info'
import { parseTaskTags, type TaskPriority } from './task-tags'
import { wikilinkOccurrencesInSource } from './wikilink'

export interface BlockRow {
    /** Stable only within this document's derivation (0-based DFS order). */
    localId: number
    parentId: number | null
    /** Sibling order under the parent. */
    ord: number
    kind: Block['type']
    depth: number
    done?: boolean
    startLine: number
    endLine: number
    text: string
    /** Display label — first line, marker stripped (the outline-chain breadcrumb text). */
    label: string
}

export interface LinkRow {
    concept: string
    line: number
    lineText: string
    matchStart: number
    matchEnd: number
    /** The block whose own lines contain this link, or null if outside any block. */
    blockLocalId: number | null
}

export interface TaskRow {
    blockLocalId: number
    done: boolean
    /** The block label — the leading [[Task Tag]] run INCLUDED, exactly as authored. */
    text: string
    line: number
    priority: TaskPriority | null
    waiting: boolean
    doing: boolean
    cancelled: boolean
    due: string | null
    completion: string | null
    scheduled: string | null
}

/**
 * One [[Task Concept]] a task answers to (ADR 0051), from a wikilink on the task's own line
 * or on any ancestor [[Block]]. The document's own concept — the virtual root of that chain —
 * is added by the index when it writes these, because derivation sees text and not identity.
 */
export interface TaskConceptRow {
    blockLocalId: number
    /** As written, case preserved; the index keys it. */
    concept: string
}

export interface DerivedRows {
    blocks: BlockRow[]
    links: LinkRow[]
    tasks: TaskRow[]
    taskConcepts: TaskConceptRow[]
}

/**
 * One [[Wikilink]] inside a document's own name: the [[Scope]] of a [[Scoped Concept]]
 * (ADR 0083). Columns are within the concept string, which is what a backlink highlights.
 */
export interface TitleLinkRow {
    concept: string
    matchStart: number
    matchEnd: number
}

/**
 * A predicate over source line numbers: is this line inside a [[Fenced Code Block]]?
 *
 * A `- [ ] x` written inside a fence must not become a [[Task]]: the [[Tasks View]] would list
 * phantom tasks lifted out of code examples. The [[Block]] model now takes a complete fence
 * whole (block-model.ts), so no task starts inside one; this scan stays for what the block model
 * cannot know, that a [[Protected Document]] - an `etherpk-cipher` fence - never contributes a
 * task, whatever it holds. That is a rule, not an optimisation: the [[Derived Index]] is
 * plaintext at rest and outlives the session.
 *
 * "Inside a fence" is the EDITOR's answer, not a second one: the column-scoped pairing of
 * `fencedBlocks` (Editor Content Rules → "Inside a block"), so a task is indexed exactly when
 * the editor shows a task. This scan used to have rules of its own, and two live bugs on
 * 2026-09-11 each hid a task the author could plainly see: a fence opened on a bullet line
 * (`- ``` `) was read as text, and a stray unterminated fence was run on to the next
 * top-level block. Under the shared scan a fence on a bullet line opens a block and never
 * closes one, an unterminated opener is no fence at all (its region is plain text in the
 * editor too), and a non-blank line dedenting below a fence's column abandons that fence.
 *
 * The one exception is a [[Protected Document]]'s `etherpk-cipher` opener with no closer:
 * that still runs to the end of the document. Nothing beneath it can be trusted as plaintext,
 * and the index is plaintext at rest, so the conservative reading is the only safe one.
 */
function fencedLines(text: string): (line: number) => boolean {
    const lines = text.split('\n')
    const spans: Array<[number, number]> = fencedBlocks(lines).map((b) => [b.start, b.end])
    const inside = (line: number) => spans.some(([from, to]) => line >= from && line <= to)
    for (let index = 0; index < lines.length; index++) {
        if (inside(index)) continue
        if (containsCipherFence(lines[index])) {
            spans.push([index, Number.MAX_SAFE_INTEGER])
            break
        }
    }
    if (spans.length === 0) return () => false
    return inside
}

/** First line of a block's text with its bullet/heading marker stripped. */
export function blockLabel(block: Block): string {
    const first = block.text.split('\n', 1)[0]
    if (block.type === 'heading') return first.replace(/^#{1,6}\s+/, '')
    return bulletLabel(first)
}

/**
 * A block as a reader sees it: the marker stripped as in its {@link blockLabel}, and every line
 * after the first kept - continuation lines and fenced code, which a label drops. What a
 * references [[View]] quotes and a semantic passage embeds.
 */
export function blockContent(block: Pick<BlockRow, 'label' | 'text'>): string {
    const newline = block.text.indexOf('\n')
    return newline === -1 ? block.label : block.label + block.text.slice(newline)
}

/**
 * The label of a bullet or [[Task]] line — its marker and checkbox stripped, indentation
 * ignored. Exported because the [[Tasks View]]'s write-back guard has to ask "is the line in
 * the document still the task the index recorded?", and the only honest way to answer is with
 * the very function that produced the recorded label. Two regexes that agree today would not
 * stay agreed.
 */
export function bulletLabel(line: string): string {
    return line.trimStart().replace(/^-\s+(\[[ xX]\]\s+)?/, '')
}

/** Flatten the block tree into rows in document (DFS) order, recording parentage. */
function flatten(roots: Block[]): BlockRow[] {
    const rows: BlockRow[] = []
    const walk = (block: Block, parentId: number | null, ord: number) => {
        const localId = rows.length
        rows.push({
            localId,
            parentId,
            ord,
            kind: block.type,
            depth: block.depth,
            ...(block.done === undefined ? {} : { done: block.done }),
            startLine: block.startLine,
            endLine: block.endLine,
            text: block.text,
            label: blockLabel(block),
        })
        block.children.forEach((child, i) => walk(child, localId, i))
    }
    roots.forEach((root, i) => walk(root, null, i))
    return rows
}

/** Derive the index rows for a single document's text. Pure. */
export function deriveDoc(text: string): DerivedRows {
    const blocks = flatten(parseBlocks(text))

    // Map each source line to the deepest block whose own range covers it.
    const lineToBlock = new Map<number, number>()
    for (const b of blocks) {
        for (let line = b.startLine; line <= b.endLine; line++) lineToBlock.set(line, b.localId)
    }

    const links: LinkRow[] = wikilinkOccurrencesInSource(text).map((occ) => ({
        concept: occ.concept,
        line: occ.line,
        lineText: occ.lineText,
        matchStart: occ.matchStart,
        matchEnd: occ.matchEnd,
        blockLocalId: lineToBlock.get(occ.line) ?? null,
    }))

    // Scanning for fences costs a regex per line of the document, so it is worth deciding
    // whether there is anything to exclude first. Most documents hold no tasks at all, and on
    // a graph of a few thousand this runs for every one of them on a rebuild.
    const candidateTasks = blocks.filter((b) => b.kind === 'task')
    const fenced = candidateTasks.length === 0 ? () => false : fencedLines(text)
    const taskBlocks = candidateTasks.filter((b) => !fenced(b.startLine))
    const tasks: TaskRow[] = taskBlocks.map((b) => {
        const tags = parseTaskTags(b.label)
        return {
            blockLocalId: b.localId,
            done: b.done ?? false,
            text: b.label,
            line: b.startLine,
            priority: tags.priority,
            waiting: tags.waiting,
            doing: tags.doing,
            cancelled: tags.cancelled,
            due: tags.due,
            completion: tags.completion,
            scheduled: tags.scheduled,
        }
    })

    return { blocks, links, tasks, taskConcepts: deriveTaskConcepts(blocks, links, taskBlocks) }
}

/**
 * The [[Task Concept]] rows for one document (ADR 0051): for each task, every concept
 * wikilinked on its own block or on ANY ancestor, up to the root.
 *
 * Headings are ancestors here because they are ancestors in the [[Block]] tree — the heading
 * spine is the same tree the [[Backlink]] breadcrumb walks. That is what makes
 * `# Work on [[Acme]]` claim every task in the section, which is the intended, load-bearing
 * consequence rather than a leak.
 */
function deriveTaskConcepts(blocks: BlockRow[], links: LinkRow[], taskBlocks: BlockRow[]): TaskConceptRow[] {
    if (taskBlocks.length === 0) return []
    const byBlock = new Map<number, string[]>()
    for (const link of links) {
        if (link.blockLocalId === null) continue
        const existing = byBlock.get(link.blockLocalId)
        if (existing) existing.push(link.concept)
        else byBlock.set(link.blockLocalId, [link.concept])
    }
    // Nothing is linked anywhere, so every task's only Task Concept is its document's —
    // which the index adds. Skipping the walk keeps the common journal page free.
    if (byBlock.size === 0) return []

    const rows: TaskConceptRow[] = []
    for (const task of taskBlocks) {
        const seen = new Set<string>()
        for (let id: number | null = task.localId; id !== null; id = blocks[id]?.parentId ?? null) {
            for (const concept of byBlock.get(id) ?? []) {
                const key = conceptKey(concept)
                if (seen.has(key)) continue
                seen.add(key)
                rows.push({ blockLocalId: task.localId, concept })
            }
        }
    }
    return rows
}

/**
 * The references a document makes BY ITS NAME: every wikilink nested in the concept string, at
 * every depth, outermost first. `[[[[Physics]] Quantum]] Field Theory` names two,
 * `[[Physics]] Quantum` and `Physics`, and is a backlink of both (ADR 0083).
 *
 * A [[Scoped Concept]]'s name *contains* its [[Scope]]'s name - that is what a rename of the
 * scope follows when it cascades (ADR 0038) - so a page named `[[Dev Doc]] file name` is a
 * reference to Dev Doc whether or not any body mentions it. Without this row a folder of such
 * files, copied into `pages/`, surfaced none of their scopes: no pageless Dev Doc in Quick
 * Find, nothing under its backlinks.
 *
 * The scan is the one the cascade uses (`isScopedBy` over `wikilinkOccurrencesInSource`),
 * not a second reading of the string, so a page references its scope precisely when a rename of
 * that scope would carry the page along. A journal's name is a date and yields nothing. Pure.
 */
export function deriveTitleLinks(concept: string): TitleLinkRow[] {
    if (!concept.includes('[[')) return []
    return wikilinkOccurrencesInSource(concept).map((occ) => ({
        concept: occ.concept,
        matchStart: occ.matchStart,
        matchEnd: occ.matchEnd,
    }))
}

/** The ancestor labels of a block, root-first (the outline-chain breadcrumb). */
export function ancestorChain(blocks: readonly BlockRow[], localId: number | null): string[] {
    const chain: string[] = []
    let id = localId
    while (id !== null) {
        const b = blocks[id]
        if (!b) break
        chain.unshift(b.label)
        id = b.parentId
    }
    return chain
}
