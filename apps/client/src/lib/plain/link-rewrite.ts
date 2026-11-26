/**
 * Keeping the links of a [[Plain Folder]] working when a file or a directory is moved or renamed.
 *
 * A link between two files is a relative path, so a move breaks it from both ends: the files that
 * pointed at what moved, and what moved, whose own links now start from somewhere else. After a
 * move in the tree, the links that would break are found (`planRewrites`) and, when the person
 * says so, written back so each leads where it led before (`applyRewrites`).
 *
 * The writes go to many files while other programs may be editing them, so each file is written
 * only if it is still exactly what the plan read. One that has changed since is left alone and
 * named, never overwritten (spec/link-rewrite).
 */
import { fencedBlocks } from '../document/fenced-code'
import { lineFeedsOnly } from '../document/line-endings'
import { opaqueLineFlags } from '../document/outliner'

import { decodeFile, encodeFile } from './file-form'
import { fileKindOf } from './file-kind'
import { expectedOf } from '../storage/fs/write-unless-moved'

import { type FolderTreeAdapter, isNotFound } from './folder-tree-adapter'
import type { PlainFolderStore } from './plain-folder-store'
import { relativeLink, resolveLink } from './plain-path'

/** A link's destination in a text: where it is, and what is written there. */
export interface LinkSpan {
    from: number
    to: number
    /** The destination as written, without the angle brackets some are wrapped in. */
    href: string
    /** It was written `<like this>`, as a destination holding spaces may be. */
    angled: boolean
}

/** `[text](destination "title")` and `![alt](destination)`: the destination is group 2. */
const INLINE = /(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)/g
/** `[label]: destination`, a link definition on a line of its own. */
const DEFINITION = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/

/** The character ranges of a line that are inside backticks. */
function codeSpans(line: string): Array<[number, number]> {
    const spans: Array<[number, number]> = []
    let open = -1
    for (let index = 0; index < line.length; index++) {
        if (line[index] !== '`') continue
        if (open < 0) open = index
        else {
            spans.push([open, index])
            open = -1
        }
    }
    return spans
}

/**
 * Every link destination in a markdown text, in order: inline links, pictures and link
 * definitions, outside fenced code, inline code and the frontmatter.
 */
export function linkDestinations(text: string): LinkSpan[] {
    const lines = text.split('\n')
    const opaque = opaqueLineFlags(lines, fencedBlocks(lines))
    const spans: LinkSpan[] = []
    let offset = 0
    lines.forEach((line, index) => {
        if (!opaque[index]) {
            const inCode = codeSpans(line)
            const add = (at: number, written: string) => {
                if (inCode.some(([from, to]) => at > from && at < to)) return
                const angled = written.startsWith('<') && written.endsWith('>')
                spans.push({ from: offset + at, to: offset + at + written.length, href: angled ? written.slice(1, -1) : written, angled })
            }
            const definition = DEFINITION.exec(line)
            if (definition) add(definition[1].length, definition[2])
            for (const match of line.matchAll(INLINE)) add(match.index + match[1].length, match[2])
        }
        offset += line.length + 1
    })
    return spans
}

/** A move in the tree: of one file, or of a directory with everything under it. */
export interface Move {
    from: string
    to: string
}

/** Where `path` is after `move`: itself when the move did not touch it. */
export function pathAfter(path: string, move: Move): string {
    if (path === move.from) return move.to
    return path.startsWith(`${move.from}/`) ? move.to + path.slice(move.from.length) : path
}

/** The part of a destination after its path: `?query` and `#fragment`, kept as written. */
function suffixOf(href: string): string {
    const at = href.search(/[?#]/)
    return at < 0 ? '' : href.slice(at)
}

/**
 * The text of a file with the links a move would break written to lead where they led. `before` is
 * the file's path when its links were written, `after` its path now. A link is rewritten only if it
 * would otherwise lead somewhere else, so one the move left alone keeps its own spelling.
 */
export function rewriteLinks(text: string, before: string, after: string, move: Move): { text: string; changed: number } {
    let out = ''
    let from = 0
    let changed = 0
    for (const span of linkDestinations(text)) {
        const target = resolveLink(before, span.href)
        if (target.kind !== 'file') continue
        // A link to the file itself (`#heading`) moves with it.
        if (span.href.startsWith('#')) continue
        const wanted = pathAfter(target.path, move)
        const still = resolveLink(after, span.href)
        if (still.kind === 'file' && still.path === wanted) continue
        const path = relativeLink(after, wanted)
        const written = span.angled ? `<${decodeURIComponent(path)}${suffixOf(span.href)}>` : `${path}${suffixOf(span.href)}`
        out += text.slice(from, span.from) + written
        from = span.to
        changed++
    }
    return { text: out + text.slice(from), changed }
}

/** One file whose links a move would break, with its text as read and as it would be written. */
export interface RewritePlan {
    /** The file's path now, after the move. */
    path: string
    /** Its text when the plan was made, with its own line endings. */
    before: string
    after: string
    /** How many links change. */
    changed: number
}

type Tree = Pick<FolderTreeAdapter, 'read' | 'write'>

/** The most markdown files a plan reads. Beyond it, links are left for the person to mend. */
export const REWRITE_FILE_LIMIT = 2000

/**
 * Find the links a move broke. `files` are the folder's files as they are now, after the move.
 * Resolves with one plan for each file with a link to change, or null when there are too many
 * markdown files to read.
 */
export async function planRewrites(tree: Tree, files: readonly string[], move: Move): Promise<RewritePlan[] | null> {
    const markdown = files.filter((path) => fileKindOf(path) === 'markdown')
    if (markdown.length > REWRITE_FILE_LIMIT) return null
    /** Where each file was before the move: the inverse of `pathAfter`. */
    const pathBefore = (path: string) => pathAfter(path, { from: move.to, to: move.from })
    const plans: RewritePlan[] = []
    for (const path of markdown) {
        let decoded
        try {
            decoded = decodeFile((await tree.read(path)).bytes)
        } catch {
            continue
        }
        if (!decoded.ok) continue
        const rewritten = rewriteLinks(decoded.text, pathBefore(path), path, move)
        if (rewritten.changed > 0) plans.push({ path, before: decoded.text, after: rewritten.text, changed: rewritten.changed })
    }
    return plans
}

export interface RewriteOutcome {
    /** The files whose links were written. */
    written: string[]
    /** The files left as they are: each changed after the plan read it, or could not be read. */
    skipped: string[]
}

type RewriteStore = Pick<PlainFolderStore, 'stateOf' | 'open' | 'flushDocument'>

/** Change a file open in a tab through its buffer. False when the person's text must win instead. */
async function rewriteOpenFile(store: RewriteStore, plan: RewritePlan): Promise<boolean> {
    const state = store.stateOf(plan.path)!
    const document = store.open(plan.path)
    const buffer = document.getText()
    // Typed in since the plan was made, or not editable: the person's text wins.
    if (buffer !== lineFeedsOnly(plan.before) || state.readOnly !== null || state.conflict !== null) return false
    document.applyChange({ from: 0, to: buffer.length, insert: lineFeedsOnly(plan.after) }, 'external')
    await store.flushDocument(plan.path)
    return true
}

/** Write a file that is not open, if it is still exactly what the plan read. False when it is not. */
async function rewriteClosedFile(tree: Tree, plan: RewritePlan): Promise<boolean> {
    try {
        const read = await tree.read(plan.path)
        const decoded = decodeFile(read.bytes)
        if (!decoded.ok || decoded.text !== plan.before) return false
        // Nothing between the read above and this write: in a browser, the one moment another write
        // can still slip into. An installed app's shell refuses this write then.
        await tree.write(plan.path, encodeFile(plan.after, decoded.form), expectedOf(read))
        return true
    } catch (error) {
        if (!isNotFound(error)) console.warn(`[link-rewrite] could not update the links of ${plan.path}`, error)
        return false
    }
}

/**
 * Write the planned links. A file open in a tab is changed through the store, so its editor shows
 * the new links and its own save writes them. Any other file is read again and written only if it
 * is still exactly what the plan read.
 */
export async function applyRewrites(tree: Tree, store: RewriteStore, plans: readonly RewritePlan[]): Promise<RewriteOutcome> {
    const outcome: RewriteOutcome = { written: [], skipped: [] }
    for (const plan of plans) {
        const done = store.stateOf(plan.path)?.loaded ? await rewriteOpenFile(store, plan) : await rewriteClosedFile(tree, plan)
        ;(done ? outcome.written : outcome.skipped).push(plan.path)
    }
    return outcome
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The question put to the person after a move: how many links it broke, in how many files. */
export function rewriteQuestion(plans: readonly RewritePlan[]): string {
    const links = plans.reduce((sum, plan) => sum + plan.changed, 0)
    const one = links === 1
    return `${count(links, 'link', 'links')} in ${count(plans.length, 'file', 'files')} no longer ${one ? 'leads' : 'lead'} where ${one ? 'it' : 'they'} did. Update ${one ? 'it' : 'them'} to follow the move?`
}

/** What a rewrite did, for the notice after it: the links written, and the files left as they are, by name. */
export function describeRewrite(plans: readonly RewritePlan[], outcome: RewriteOutcome): string {
    const links = plans.filter((plan) => outcome.written.includes(plan.path)).reduce((sum, plan) => sum + plan.changed, 0)
    const written = outcome.written.length === 0 ? 'No links were updated.' : `Updated ${count(links, 'link', 'links')} in ${count(outcome.written.length, 'file', 'files')}.`
    if (outcome.skipped.length === 0) return written
    // A file that changed while the question was open is left as it is, and named.
    const one = outcome.skipped.length === 1
    return `${written} Left as ${one ? 'it is' : 'they are'}, because ${one ? 'it' : 'they'} changed meanwhile: ${outcome.skipped.join(', ')}.`
}
