/**
 * What a [[Local Mirror]] calls each document on disk, and how it works out which file on disk
 * is which document's (ADR 0008, decision recorded in
 * [[2026-09-09 Local Mirror Robustness And Assets]]).
 *
 * The rule is the one the Logseq and Obsidian converters already follow: **suffix the file name,
 * keep the title**. A page is `<portable stem of its title>.md`, a journal is `<date>.md`, and a
 * second document wanting a name already taken gets ` (2)`, ` (3)` and so on. The title inside is
 * never touched, so no wikilink is broken by a rename on disk and both [[Import]] targets need no
 * special case: a synced graph reads identity from the title and discards the file name, a
 * [[Filesystem Backend]] keeps the suffixed file with its true title, which is a valid page.
 *
 * Two different collisions arrive here:
 *
 * - **Distinct concepts, one file name** - `A/B` and `A_B`, or two titles that truncate to the
 *   same stem. Nothing is ambiguous in the graph, only on disk.
 * - **Two documents, one concept** - a concurrent creation race between devices leaves two
 *   registry entries with the same title or date. The mirror writes both rather than losing one;
 *   the rename that makes them two concepts happens on Import.
 *
 * **The file name follows the title, exactly as a local graph names its own files**, so a mirror
 * imported as a local graph is indistinguishable from one that was always local. A file found
 * under any other name - an earlier mirror lower-cased and hyphenated everything - is renamed to
 * the name the title gives it. Ownership is still read from the folder: a mirror file says which
 * concept it holds (the title it carries, else its own stem), which is how the planner knows
 * which existing file is which document's, and therefore what to rename rather than what to
 * write afresh. Among documents competing for one name, one that already holds exactly that
 * name keeps it, so a genuine collision does not reshuffle on every pass.
 *
 * Pure: strings and maps, no adapter, no store.
 */

import { portableFileName, suffixedFileName } from '$lib/storage/file-names'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { conceptKey, fileStem } from '$lib/storage/fs/identity'
import type { Subdir } from '$lib/storage/fs/directory-adapter'

/** A document as the mirror sees it: identity plus the id that survives a rename. */
export interface MirrorDocument {
    /** The graph-registry document id - stable identity, and the tie-break between duplicates. */
    docId: string
    kind: 'journal' | 'page'
    concept: string
    aliases?: readonly string[]
}

/** A markdown file already in the mirror folder, and the concept it claims. */
export interface MirrorFile {
    name: string
    concept: string
}

/** A document that had to take a suffixed name, for the Mirror tab to report. */
export interface MirrorNameCollision {
    concept: string
    fileName: string
}

export interface MirrorNamePlan {
    /** docId → the file name to write it as. */
    byDocId: Map<string, string>
    /**
     * docId → the file it has NOW, for every document whose current file is not called what
     * `byDocId` says: the mirror renames it rather than leaving a stray behind. Absent when a
     * document has no file yet, or already has the right one.
     */
    renameFrom: Map<string, string>
    /** Every name this plan claims, lower-cased, per subdir: everything else is a stray. */
    claimed: Map<Subdir, Set<string>>
    collisions: MirrorNameCollision[]
}

/**
 * Code-unit ordering, not `localeCompare`. Every device mirroring the same graph has to allocate
 * the same names, and locale collation varies with the browser's ICU data - it sorts `a/b` after
 * `a_b` where code units put it first.
 */
function byCodeUnit(a: string, b: string): number {
    if (a === b) return 0
    return a < b ? -1 : 1
}

/** The content subdir a document of this kind lives in. */
export function mirrorSubdir(kind: MirrorDocument['kind']): Subdir {
    return kind === 'journal' ? 'journals' : 'pages'
}

/**
 * The concept a mirror file claims: the `title` its [[Frontmatter]] carries, else its own stem.
 * The same rule the EtherPK converter and the Filesystem Backend's scan read identity by, so a
 * file the mirror wrote is understood the same way by everything that later reads the folder.
 */
export function claimedConcept(fileName: string, text: string): string {
    const title = parseFrontmatter(text).data.title
    if (typeof title === 'string' && title.trim() !== '') return title
    return fileStem(fileName)
}

/**
 * The unsuffixed file name for a document. The rule itself lives in `storage/file-names.ts`,
 * where the Filesystem Backend reads it too, so both backends name a folder the same way.
 */
export function baseFileName(doc: Pick<MirrorDocument, 'kind' | 'concept'>): string {
    return portableFileName(doc.concept)
}

/**
 * Which file each document is written to, given what is already in the folder.
 *
 * First every document is paired with the file that already claims its concept, if any: that is
 * the file it will be renamed from when the names differ, and the reason a rename is a rename
 * rather than a delete and a fresh write. Then names are allocated, each document taking the
 * first free candidate of `Title.md`, `Title (2).md`, ... Documents whose current file already
 * IS their bare name go first, so an existing holder of a contested name keeps it; the rest
 * follow in a deterministic order (concept, then document id), so two devices mirroring one
 * graph into two folders produce the same names.
 */
export function planMirrorNames(
    docs: readonly MirrorDocument[],
    existing: ReadonlyMap<Subdir, readonly MirrorFile[]>,
): MirrorNamePlan {
    const byDocId = new Map<string, string>()
    const renameFrom = new Map<string, string>()
    const claimed = new Map<Subdir, Set<string>>([
        ['journals', new Set<string>()],
        ['pages', new Set<string>()],
    ])
    const collisions: MirrorNameCollision[] = []

    for (const subdir of ['journals', 'pages'] as const) {
        const here = docs
            .filter((doc) => mirrorSubdir(doc.kind) === subdir)
            .sort(
                (a, b) =>
                    byCodeUnit(conceptKey(a.concept), conceptKey(b.concept)) ||
                    byCodeUnit(a.docId, b.docId),
            )
        // Concept → its documents, in the order above. More than one is a duplicate concept.
        const groups = new Map<string, MirrorDocument[]>()
        for (const doc of here) {
            const key = conceptKey(doc.concept)
            const group = groups.get(key)
            if (group) group.push(doc)
            else groups.set(key, [doc])
        }
        // Concept → the files already claiming it.
        const filesByConcept = new Map<string, MirrorFile[]>()
        for (const file of existing.get(subdir) ?? []) {
            const key = conceptKey(file.concept)
            const held = filesByConcept.get(key)
            if (held) held.push(file)
            else filesByConcept.set(key, [file])
        }

        // Which existing file is which document's. Two documents with one concept (a concurrent
        // creation race) pair with that concept's files in a stable order, bare name first.
        const current = new Map<string, MirrorFile>()
        for (const [key, group] of groups) {
            const base = baseFileName(group[0]).toLowerCase()
            const held = [...(filesByConcept.get(key) ?? [])].sort(
                (a, b) =>
                    Number(a.name.toLowerCase() !== base) - Number(b.name.toLowerCase() !== base) ||
                    byCodeUnit(a.name, b.name),
            )
            for (const [index, doc] of group.entries()) {
                const file = held[index]
                if (file) current.set(doc.docId, file)
            }
        }
        // Allocation. A document already sitting on its own bare name is served first, so a
        // genuine collision keeps whoever had the name rather than reshuffling every pass.
        const holdsOwnName = (doc: MirrorDocument) =>
            current.get(doc.docId)?.name.toLowerCase() === baseFileName(doc).toLowerCase()
        const ordered = [...here.filter(holdsOwnName), ...here.filter((doc) => !holdsOwnName(doc))]
        for (const doc of ordered) {
            const base = baseFileName(doc)
            for (let index = 1; ; index++) {
                const candidate = suffixedFileName(base, index)
                if (claimed.get(subdir)!.has(candidate.toLowerCase())) continue
                byDocId.set(doc.docId, candidate)
                claimed.get(subdir)!.add(candidate.toLowerCase())
                break
            }
            const file = current.get(doc.docId)
            if (file && file.name !== byDocId.get(doc.docId)) renameFrom.set(doc.docId, file.name)
        }
        // A collision is a document that could not have its own name because something ELSE
        // holds it, and nothing else. A file simply kept from an earlier session under a
        // different naming rule is not one: keeping it is the whole point of reading ownership
        // out of the folder, and renaming thousands of files would be the harm this avoids.
        // Reporting those as collisions listed most of a real 2,875-document graph (2026-09-09).
        //
        // Both halves compare case-insensitively, as every other name test here does. Comparing
        // the name case-SENSITIVELY against a claim recorded in lower case made a document
        // collide with itself: a folder written under the old lower-cased rule holds
        // `accessibility.md` for `Accessibility`, which differs from its own preferred name in
        // case alone, and the claim it had just made was read as somebody else's (2026-09-09).
        for (const doc of here) {
            const name = byDocId.get(doc.docId)!.toLowerCase()
            const base = baseFileName(doc).toLowerCase()
            if (name === base) continue
            if (!claimed.get(subdir)!.has(base)) continue
            collisions.push({ concept: doc.concept, fileName: byDocId.get(doc.docId)! })
        }
    }

    return { byDocId, renameFrom, claimed, collisions }
}
