/**
 * What to make of a folder the person has chosen (ADR 0194): a graph EtherPK already knows, a
 * Graph Folder, something to refuse, or a folder to ask about.
 *
 * Two steps, so the decision is pure. `probeFolder` looks inside through the read half of the tree
 * adapter and never writes: until now choosing any folder created four directories and two files
 * in it before the person had been asked anything. `classifyFolder` turns what was seen, and what
 * this device already holds there, into a verdict.
 */
import { AGENTS_MD_BEGIN, AGENTS_MD_FILE } from '../storage/fs/agents-md'
import type { FolderOwner } from '../storage/synced/mirror-takeover'
import { detectFormat } from '../import/detect'
import type { ImportFormat } from '../import/types'

import type { FolderTreeAdapter } from './folder-tree-adapter'
import { extensionOf, joinPath } from './plain-path'

/** What the folder holds, counted for the sentence the dialog shows. */
export interface FolderCounts {
    markdown: number
    images: number
    pdfs: number
    ebooks: number
    other: number
}

/** What a look inside the folder found. Reading it changed nothing. */
export interface FolderProbe {
    /** The folder holds nothing at all. */
    empty: boolean
    /** It has an `etherpk` directory at its root: EtherPK keeps a graph's own files there. */
    hasEtherpkDir: boolean
    /** It has `journals` and `pages` directories at its root. */
    hasJournalsAndPages: boolean
    /** Its `AGENTS.md` carries the section EtherPK writes into every Graph Folder. */
    hasManagedAgentsSection: boolean
    /** What the import would read it as. `markdown` is a folder with no other tool's marks. */
    format: ImportFormat
    counts: FolderCounts
    /** Directories the count left out (`.git`, `node_modules`), for the dialog to say so. */
    skipped: string[]
    /** The walk stopped at its limit: the counts are a floor, not a total. */
    truncated: boolean
}

/** What the dialog offers first. */
export type FolderChoice = 'plain' | 'graph' | 'import'

export type FolderVerdict =
    /** This device already has the folder as a graph: open that. */
    | { kind: 'known-graph'; graphId: string }
    /** It is a Graph Folder: open it as a Folder graph, as before, without asking. */
    | { kind: 'graph-folder' }
    /** It belongs to something else here. Opening it either way would damage that. */
    | { kind: 'refuse'; reason: 'mirror' | 'inside-graph'; owner: FolderOwner }
    /** Ask. `choices` are in the order shown, and `preferred` is the one selected. */
    | { kind: 'ask'; empty: boolean; choices: FolderChoice[]; preferred: FolderChoice; probe: FolderProbe }

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'])
const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd'])
const EBOOK = new Set(['epub', 'mobi', 'azw3', 'fb2', 'cbz'])

/** Directories a walk never enters: other tools' own, and dependency trees of no interest. */
export function isSkippedDirectory(name: string): boolean {
    return name.startsWith('.') || name === 'node_modules'
}

/** Files that say nothing about a folder: the ones a file manager leaves behind. */
function isClutter(name: string): boolean {
    return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini'
}

/** The walk's limits: enough to describe a repository, never a crawl of a home directory. */
const MAX_ENTRIES = 5000
const MAX_DEPTH = 16

/** Which count a file adds to, by its extension. */
function countOf(name: string): keyof FolderCounts {
    const extension = extensionOf(name)
    if (MARKDOWN.has(extension)) return 'markdown'
    if (IMAGE.has(extension)) return 'images'
    if (extension === 'pdf') return 'pdfs'
    return EBOOK.has(extension) ? 'ebooks' : 'other'
}

/** What a walk has gathered so far. */
interface Walk {
    counts: FolderCounts
    skipped: Set<string>
    /** Paths as `detectFormat` reads them: files, and a trailing-slash entry for a dot-directory. */
    paths: string[]
    rootNames: string[]
    /** The directories still to list, in the order found. */
    queue: Array<{ dir: string; depth: number }>
}

/** Note one entry of the directory `dir`: count a file, queue a directory, or mark one that is skipped. */
function noteEntry(walk: Walk, dir: string, depth: number, entry: { name: string; kind: 'file' | 'directory' }): void {
    const path = joinPath(dir, entry.name)
    if (entry.kind === 'file') {
        if (isClutter(entry.name)) return
        walk.paths.push(path)
        walk.counts[countOf(entry.name)]++
        return
    }
    if (!isSkippedDirectory(entry.name)) {
        if (depth < MAX_DEPTH) walk.queue.push({ dir: path, depth: depth + 1 })
        return
    }
    if (depth === 0) walk.skipped.add(entry.name)
    // Its presence is the mark another tool leaves (`.obsidian`, `.asnotes`).
    walk.paths.push(`${path}/`)
}

/** Whether the folder's own `AGENTS.md` carries the section EtherPK manages. */
async function hasManagedSection(tree: Pick<FolderTreeAdapter, 'read'>, rootNames: readonly string[]): Promise<boolean> {
    if (!rootNames.includes(AGENTS_MD_FILE)) return false
    try {
        return new TextDecoder().decode((await tree.read(AGENTS_MD_FILE)).bytes).includes(AGENTS_MD_BEGIN)
    } catch {
        // Unreadable: taken as not EtherPK's, so the person is asked rather than assumed.
        return false
    }
}

/**
 * Look inside the folder without changing it. Breadth first, so the root and the levels near it
 * are always seen before the limit is reached.
 */
export async function probeFolder(tree: Pick<FolderTreeAdapter, 'list' | 'read'>): Promise<FolderProbe> {
    const walk: Walk = { counts: { markdown: 0, images: 0, pdfs: 0, ebooks: 0, other: 0 }, skipped: new Set(), paths: [], rootNames: [], queue: [{ dir: '', depth: 0 }] }
    let seen = 0
    let truncated = false
    // The queue grows as directories are found, so this visits them level by level.
    for (let at = 0; at < walk.queue.length && !truncated; at++) {
        const { dir, depth } = walk.queue[at]
        const entries = await tree.list(dir)
        if (dir === '') walk.rootNames = entries.filter((entry) => !isClutter(entry.name)).map((entry) => entry.name)
        truncated = seen + entries.length > MAX_ENTRIES
        for (const entry of entries.slice(0, MAX_ENTRIES - seen)) noteEntry(walk, dir, depth, entry)
        seen += entries.length
    }
    const { rootNames, paths } = walk
    return {
        empty: rootNames.length === 0,
        hasEtherpkDir: paths.some((path) => path.startsWith('etherpk/')) || rootNames.includes('etherpk'),
        hasJournalsAndPages: rootNames.includes('journals') && rootNames.includes('pages'),
        hasManagedAgentsSection: await hasManagedSection(tree, rootNames),
        format: detectFormat(paths),
        counts: walk.counts,
        skipped: [...walk.skipped].sort(),
        truncated,
    }
}

/** A folder EtherPK has written a graph's layout into. Such a folder is never offered as a Plain Folder. */
export function isGraphFolder(probe: FolderProbe): boolean {
    return probe.hasEtherpkDir || (probe.hasJournalsAndPages && probe.hasManagedAgentsSection)
}

/** What a folder this device already holds something at, around or inside comes to, or null to go on. */
function verdictForOwner(owner: FolderOwner | null): FolderVerdict | null {
    if (owner?.kind === 'mirror') return { kind: 'refuse', reason: 'mirror', owner }
    if (owner?.kind !== 'folder-graph') return null
    if (owner.relation === 'same') return { kind: 'known-graph', graphId: owner.graphId }
    // A folder inside a graph's own folder (its `pages`, say): editing it as plain files would
    // change the graph behind its back.
    return owner.relation === 'inside' ? { kind: 'refuse', reason: 'inside-graph', owner } : null
}

/**
 * The choice selected for a folder that holds something. Another tool's notes are best read by its
 * own converter. A bare journals-and-pages layout is a graph's export, which a graph can be created
 * over as it stands.
 */
function preferredChoice(format: FolderProbe['format']): FolderChoice {
    if (format === 'logseq' || format === 'obsidian' || format === 'asnotes') return 'import'
    return format === 'etherpk' ? 'graph' : 'plain'
}

/**
 * The verdict for a chosen folder. `owner` is what this device already holds at, around or inside
 * it (`findFolderOwner`), or null.
 */
export function classifyFolder(probe: FolderProbe, owner: FolderOwner | null): FolderVerdict {
    const held = verdictForOwner(owner)
    if (held) return held
    if (isGraphFolder(probe)) return { kind: 'graph-folder' }
    if (probe.empty) return { kind: 'ask', empty: true, choices: ['graph', 'plain'], preferred: 'graph', probe }
    return { kind: 'ask', empty: false, choices: ['plain', 'graph', 'import'], preferred: preferredChoice(probe.format), probe }
}
