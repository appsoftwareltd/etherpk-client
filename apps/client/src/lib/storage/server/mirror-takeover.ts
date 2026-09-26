/**
 * What choosing a folder for the [[Local Mirror]] would do to it, decided before anything is
 * written (ADR 0008).
 *
 * The mirror is faithful: its first full pass deletes every Markdown file under journals/ and
 * pages/ that is not a document of the graph, deletes its own attachment files the graph no
 * longer holds, and rewrites EtherPK's files in etherpk/. That is right for a folder the mirror
 * owns and destructive for any other, and a native folder picker makes the wrong folder an easy
 * slip. The check looks at all four folders the mirror manages, since a folder with just an
 * assets/ (a website project, a Markdown vault's attachments) has files to lose too. It also
 * tells a local graph's own folder apart from your own old mirror: one generic "already has
 * content" dialog for both would teach people to click through it.
 *
 * So, in order:
 *
 * 1. **Refuse a folder this device knows belongs to something else**, recognised by handle, never
 *    by name: a local graph's own folder or another graph's mirror (`isSameEntry`), a folder inside
 *    one (`resolve`), or a folder whose journals/, pages/, assets/ or etherpk/ is one - the mirror
 *    writes into those four and nowhere else, so a graph folder further down is left alone. Two
 *    graphs in one folder delete each other's files, and confirming is never the right answer.
 * 2. **Start at once in a folder with nothing in the four folders the mirror manages.**
 * 3. **Otherwise ask, naming the folder and counting what the first pass would delete, replace
 *    and leave alone**, worked out with the same name planner the mirror runs, so the numbers are
 *    the mirror's own and a re-chosen mirror of this graph reads differently from someone
 *    else's notes.
 *
 * Framework-free: the folder is read through {@link FolderReader}, which never creates anything
 * (the user may still say no), and handles are anything with `isSameEntry`.
 */
import type { Subdir } from '$lib/storage/fs/directory-adapter'
import type { GraphRecord } from '$lib/storage/graph-registry'
import type { MirrorFolderRecord } from '$lib/storage/mirror-folder-idb'

import { assetFileFates, isMirrorMetadataFileName } from './local-mirror'
import { type MirrorDocument, type MirrorFile, claimedConcept, planMirrorNames } from './mirror-names'
import { assetIdFromRef } from './server-asset-store'

/** A graph whose folder this device knows: a local graph's own folder, or a synced graph's mirror. */
export interface FolderGraph {
    kind: 'local-graph' | 'mirror'
    graphId: string
    name: string
}

/**
 * Whose folder a chosen folder already is, and how: `same` folder, `inside` it, or it `holds` the
 * graph's folder as the managed `subfolder` the mirror would write into.
 */
export type FolderOwner = FolderGraph &
    ({ relation: 'same' | 'inside' } | { relation: 'holds'; subfolder: string })

/** A folder handle this device holds, and what it belongs to. */
export interface KnownFolder {
    /** A `FileSystemDirectoryHandle`, as the graph registry and the mirror store keep it. */
    handle: unknown
    owner: FolderGraph
}

/** The two `FileSystemDirectoryHandle` methods that say how two folders relate on disk. */
export interface ComparableHandle {
    isSameEntry(other: never): Promise<boolean>
    /** The path from this folder down to `possibleDescendant`, or null when it is not inside. */
    resolve(possibleDescendant: never): Promise<string[] | null>
}

/** The read-only view of a folder the check needs. It must never create anything. */
export interface FolderReader {
    /** File names directly under `subdir`; [] when the subdir does not exist. */
    list(subdir: Subdir): Promise<string[]>
    read(subdir: Subdir, name: string): Promise<string>
}

/** What the mirror's first full pass would do to a folder's current contents. */
export interface MirrorFolderImpact {
    /** Files now in journals/, pages/, assets/ and etherpk/. Zero is an empty folder. */
    present: number
    /** Markdown files that no document of this graph claims: deleted. */
    deletedDocuments: number
    /** Markdown files a document of this graph claims: rewritten with the graph's text. */
    replacedDocuments: number
    /** Attachment files in the mirror's own name shape that this graph does not hold: deleted. */
    deletedAssets: number
    /** False when the graph's attachment list could not be fetched: `deletedAssets` is then an upper bound. */
    assetsKnown: boolean
    /**
     * Files in etherpk/ with the names the mirror writes (settings, name, themes, quick notes,
     * dictionary, protection record): overwritten, or removed when the graph has no such theme or
     * record. An upper bound: `settings.json` and `graph.json` stay when the graph has none.
     */
    replacedMetadata: number
    /** Attachment files of assets the graph holds: kept, under the names its documents use. */
    keptAssets: number
    /** Everything else in those four folders, which the mirror never touches. */
    untouched: number
}

export type MirrorTakeover =
    | { kind: 'start' }
    | { kind: 'refuse'; title: string; message: string }
    | { kind: 'confirm'; title: string; message: string; confirmLabel: string; destructive: boolean }

const MANAGED: readonly Subdir[] = ['journals', 'pages', 'assets', 'etherpk']

/**
 * The folders this device knows belong to something: every local graph's folder, and every
 * other graph's mirror. `exceptMirrorOf` is the graph choosing a folder: its own mirror record
 * is no reason to refuse its own folder. A mirror record whose graph this device no longer holds
 * (deleted, left or forgotten here) mirrors nothing any more, and is ignored.
 */
export function knownFolders(
    graphs: readonly Pick<GraphRecord, 'id' | 'name' | 'backend' | 'handle'>[],
    mirrors: readonly MirrorFolderRecord[],
    exceptMirrorOf?: string,
): KnownFolder[] {
    const names = new Map(graphs.map((graph) => [graph.id, graph.name]))
    const out: KnownFolder[] = []
    for (const graph of graphs) {
        if (graph.backend !== 'filesystem' || !graph.handle) continue
        out.push({ handle: graph.handle, owner: { kind: 'local-graph', graphId: graph.id, name: graph.name } })
    }
    for (const mirror of mirrors) {
        if (mirror.graphId === exceptMirrorOf || !mirror.handle) continue
        const name = names.get(mirror.graphId)
        if (name === undefined) continue
        out.push({ handle: mirror.handle, owner: { kind: 'mirror', graphId: mirror.graphId, name } })
    }
    return out
}

/** A comparison that throws - a remembered handle to a folder that has since gone - is no match. */
async function attempt<T>(compare: () => Promise<T>): Promise<T | null> {
    try {
        return await compare()
    } catch {
        return null
    }
}

/**
 * The graph `handle` already belongs to among `known`, compared as entries on disk rather than by
 * name. The same folder wins over one it is inside, which wins over one it holds.
 */
export async function findFolderOwner(
    handle: ComparableHandle,
    known: readonly KnownFolder[],
): Promise<FolderOwner | null> {
    for (const entry of known) {
        if (await attempt(() => handle.isSameEntry(entry.handle as never))) return { ...entry.owner, relation: 'same' }
    }
    for (const entry of known) {
        const other = entry.handle as Partial<ComparableHandle> | null
        if (typeof other?.resolve !== 'function') continue
        const down = await attempt(() => other.resolve!(handle as never))
        if (down && down.length > 0) return { ...entry.owner, relation: 'inside' }
    }
    for (const entry of known) {
        const up = await attempt(() => handle.resolve(entry.handle as never))
        const subfolder = up?.length === 1 ? up[0] : undefined
        if (subfolder && MANAGED.some((managed) => managed === subfolder.toLowerCase())) {
            return { ...entry.owner, relation: 'holds', subfolder }
        }
    }
    return null
}

/**
 * What the mirror's first pass would do to the folder, read without changing it. The Markdown
 * rule is the mirror's own: `planMirrorNames` over the files' claimed concepts says which files
 * are this graph's documents (kept, or renamed onto the document's name) and which are strays.
 */
export async function inspectMirrorFolder(
    folder: FolderReader,
    docs: readonly MirrorDocument[],
    heldAssetIds: readonly string[] | null,
): Promise<MirrorFolderImpact> {
    const listings = new Map<Subdir, string[]>()
    for (const subdir of MANAGED) listings.set(subdir, await folder.list(subdir).catch(() => []))
    const present = [...listings.values()].reduce((sum, names) => sum + names.length, 0)
    const impact: MirrorFolderImpact = {
        present,
        deletedDocuments: 0,
        replacedDocuments: 0,
        deletedAssets: 0,
        assetsKnown: heldAssetIds !== null,
        replacedMetadata: 0,
        keptAssets: 0,
        untouched: 0,
    }
    if (present === 0) return impact

    const existing = new Map<Subdir, MirrorFile[]>()
    for (const subdir of ['journals', 'pages'] as const) {
        const files: MirrorFile[] = []
        for (const name of listings.get(subdir)!) {
            if (!name.toLowerCase().endsWith('.md')) {
                impact.untouched += 1
                continue
            }
            // A file that cannot be read is judged by its name alone, as a stray would be.
            const text = await folder.read(subdir, name).catch(() => '')
            files.push({ name, concept: claimedConcept(name, text) })
        }
        existing.set(subdir, files)
    }
    const plan = planMirrorNames(docs, existing)
    const renamed = new Set([...plan.renameFrom.values()].map((name) => name.toLowerCase()))
    for (const [subdir, files] of existing) {
        for (const file of files) {
            const key = file.name.toLowerCase()
            if (plan.claimed.get(subdir)!.has(key) || renamed.has(key)) impact.replacedDocuments += 1
            else impact.deletedDocuments += 1
        }
    }

    // The asset pass's own rule. Without the list, every attachment-named file counts as one the
    // graph might not hold ("up to"). Without the documents' references, no copy is judged
    // stale, so held files are reported as kept under the documents' names rather than as
    // untouched: the pass does remove a second copy under a name no document uses.
    const fates = assetFileFates(
        listings.get('assets')!,
        (name) => assetIdFromRef(`../assets/${name}`),
        new Set(heldAssetIds ?? []),
        null,
    )
    for (const fate of fates.values()) {
        if (fate === 'not-held' || fate === 'stale-name') impact.deletedAssets += 1
        else if (fate === 'held') impact.keptAssets += 1
        else impact.untouched += 1
    }
    for (const name of listings.get('etherpk')!) {
        if (isMirrorMetadataFileName(name)) impact.replacedMetadata += 1
        else impact.untouched += 1
    }
    return impact
}

/** `3 files`, `1 file`. */
function count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(parts: readonly string[]): string {
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The confirmation for a folder that holds something, saying exactly what would happen to it. */
export function takeoverConfirmation(folder: string, impact: MirrorFolderImpact): MirrorTakeover & { kind: 'confirm' } {
    const effects: string[] = []
    const { deletedDocuments, deletedAssets, replacedDocuments, replacedMetadata, keptAssets, untouched } = impact
    if (deletedDocuments > 0) {
        effects.push(
            `deletes ${count(deletedDocuments, 'Markdown file')} that ${deletedDocuments === 1 ? 'is not a document' : 'are not documents'} of this graph`,
        )
    }
    if (deletedAssets > 0) {
        effects.push(
            `${impact.assetsKnown ? 'deletes' : 'can delete up to'} ${count(deletedAssets, 'attachment file')} this graph does not hold`,
        )
    }
    if (replacedDocuments > 0) effects.push(`replaces ${count(replacedDocuments, 'Markdown file')} with this graph’s version`)
    if (replacedMetadata > 0) effects.push(`overwrites or removes up to ${count(replacedMetadata, 'EtherPK file')} in etherpk/`)

    const destructive = effects.length > 0
    const sentences = [
        `“${folder}” already has ${count(impact.present, 'file')} in journals/, pages/, assets/ or etherpk/.`,
        destructive ? `Mirroring here ${joinAnd(effects)}.` : 'Mirroring here deletes and replaces none of them.',
        ...(keptAssets > 0
            ? [
                  `${count(keptAssets, 'attachment file')} this graph holds ${keptAssets === 1 ? 'is' : 'are'} kept, under the names its documents use.`,
              ]
            : []),
        untouched > 0
            ? `${count(untouched, 'other file')} ${untouched === 1 ? 'is' : 'are'} left alone, as is everything outside those four folders.`
            : 'Everything outside those four folders is left alone.',
    ]
    if (destructive) sentences.push('This cannot be undone.')
    return {
        kind: 'confirm',
        title: 'Mirror to this folder?',
        message: sentences.join(' '),
        confirmLabel: destructive ? 'Mirror and replace contents' : 'Mirror to this folder',
        destructive,
    }
}

/** Why a folder that already belongs to something is not taken over, by how it relates to it. */
export function takeoverRefusal(folder: string, owner: FolderOwner): MirrorTakeover & { kind: 'refuse' } {
    const name = `“${owner.name}”`
    const held = `“${folder}/${owner.relation === 'holds' ? owner.subfolder : ''}”`
    if (owner.kind === 'local-graph') {
        const [title, what] =
            owner.relation === 'same'
                ? [
                      'This is a local graph’s folder',
                      `“${folder}” is the folder of your local graph ${name}. Mirroring a synced graph into it would delete and overwrite that graph’s pages.`,
                  ]
                : owner.relation === 'inside'
                  ? [
                        'This folder is inside a local graph’s folder',
                        `“${folder}” is inside the folder of your local graph ${name}. Mirroring a synced graph there would write its files into that graph’s folder.`,
                    ]
                  : [
                        'This folder holds a local graph’s folder',
                        `${held} is the folder of your local graph ${name}. Mirroring a synced graph into “${folder}” would write into that graph’s folder and delete files in it.`,
                    ]
        return { kind: 'refuse', title, message: `${what} Choose another folder, ideally an empty one.` }
    }
    const [title, what] =
        owner.relation === 'same'
            ? [
                  'This folder is another graph’s mirror',
                  `“${folder}” is where ${name} is mirrored on this device. Two graphs mirrored to one folder delete each other’s files.`,
              ]
            : owner.relation === 'inside'
              ? [
                    'This folder is inside another graph’s mirror',
                    `“${folder}” is inside the folder where ${name} is mirrored on this device. A mirror there would mix this graph’s files into that one’s.`,
                ]
              : [
                    'This folder holds another graph’s mirror',
                    `${held} is where ${name} is mirrored on this device. Mirroring into “${folder}” would write into that mirror’s folder and delete files in it.`,
                ]
    return {
        kind: 'refuse',
        title,
        message: `${what} Choose another folder, or first stop mirroring ${name} under its Settings > Mirror and Export.`,
    }
}

/**
 * The Graphs page's answer when **Open folder** is given a folder that is a synced graph's
 * mirror: working in it as a local graph would be undone by that mirror's next pass.
 */
export function openAsLocalGraphRefusal(folder: string, mirror: FolderOwner): string {
    const what =
        mirror.relation === 'same'
            ? `“${folder}” is where “${mirror.name}” is mirrored on this device, so changes made to it as a local graph would be undone the next time that mirror runs.`
            : `“${folder}” overlaps the folder where “${mirror.name}” is mirrored on this device, and a local graph there would mix its files with the mirror’s.`
    return `${what} Choose another folder, or first stop mirroring “${mirror.name}” under its Settings > Mirror and Export.`
}

export interface MirrorTakeoverCheck {
    /** The folder the user chose. */
    handle: ComparableHandle
    /** Its display name. */
    folder: string
    /** Every folder this device knows belongs to something, from {@link knownFolders}. */
    known: readonly KnownFolder[]
    /** The same folder, read without creating anything. */
    reader: FolderReader
    /** The graph's documents, as the mirror will name them. */
    docs: readonly MirrorDocument[]
    /** The graph's attachments by id, or null when the server cannot say. Asked only when needed. */
    heldAssetIds: () => Promise<readonly string[] | null>
}

/** Decide what choosing `handle` as the mirror folder does: start, ask, or refuse. */
export async function checkMirrorTakeover(check: MirrorTakeoverCheck): Promise<MirrorTakeover> {
    const owner = await findFolderOwner(check.handle, check.known)
    if (owner) return takeoverRefusal(check.folder, owner)
    // An empty folder needs no attachment list, and asking the server for one would only delay
    // the common case.
    const listed = await Promise.all(MANAGED.map((subdir) => check.reader.list(subdir).catch(() => [])))
    if (listed.every((names) => names.length === 0)) return { kind: 'start' }
    const held = await check.heldAssetIds().catch(() => null)
    const impact = await inspectMirrorFolder(check.reader, check.docs, held)
    return impact.present === 0 ? { kind: 'start' } : takeoverConfirmation(check.folder, impact)
}
