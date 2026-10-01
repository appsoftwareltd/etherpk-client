/**
 * Naming the pages of a folder vault in EtherPK's one flat namespace. Obsidian and AS Notes both
 * keep notes in any folder and name a note after its file, while a graph has one `pages/`
 * directory and one concept per name. Folders therefore flatten: a page keeps its file's name,
 * and only names that clash across folders become [[Scoped Concept]]s, each scoped by as many of
 * its nearest folders as it takes to tell it apart (`projects/alpha/Notes.md` → `[[alpha]] Notes`),
 * so the folder survives as a backlink.
 */

import { portableFileStem } from '$lib/document/wikilink'

import { dedupeConcept, scopedConceptName } from './convert-shared'
import type { ReportEntry } from './types'

/** A page to be named: its file's stem and the folders it sits in. */
export interface FolderPage {
    stem: string
    /** Root-relative directory, `''` at the root. */
    dir: string
    /** `dir` split at its slashes, `[]` at the root. */
    segments: string[]
}

/** Concepts and file names already given out, both lower-cased (identity is case-insensitive). */
export interface TakenNames {
    concepts: Set<string>
    fileNames: Set<string>
}

/** A page with the concept and file name it was given. */
export interface PlacedPage<T> {
    page: T
    concept: string
    fileName: string
}

/**
 * Give `concept` to a document: suffixed ` (2)`, ` (3)`... when another document already has
 * it, with a file name suffixed the same way when two concepts share a file name.
 */
export function claimPageName(concept: string, taken: TakenNames): { concept: string; fileName: string } {
    const claimed = dedupeConcept(concept, (key) => taken.concepts.has(key))
    taken.concepts.add(claimed.toLowerCase())
    let fileName = `${portableFileStem(claimed)}.md`
    for (let n = 2; taken.fileNames.has(fileName.toLowerCase()); n++) {
        fileName = `${portableFileStem(claimed)} (${n}).md`
    }
    taken.fileNames.add(fileName.toLowerCase())
    return { concept: claimed, fileName }
}

/**
 * Name every page. Pages are grouped by stem, case-insensitively: a stem only one page has stays
 * the bare concept, and each page of a larger group outside the root takes the shortest chain of
 * its nearest folders that no other page in the group shares. Each scoped page is reported as a
 * collision. The result lists pages group by group, in the order each stem was first seen.
 */
export function placeFolderPages<T extends FolderPage>(pages: T[], taken: TakenNames, report: ReportEntry[]): PlacedPage<T>[] {
    const byStem = new Map<string, T[]>()
    for (const page of pages) {
        const key = page.stem.toLowerCase()
        byStem.set(key, [...(byStem.get(key) ?? []), page])
    }

    const placed: PlacedPage<T>[] = []
    for (const [, group] of byStem) {
        for (const page of group) {
            let concept = page.stem
            if (group.length > 1 && page.segments.length > 0) {
                for (let depth = 1; depth <= page.segments.length; depth++) {
                    concept = scopedConceptName([...page.segments.slice(-depth), page.stem])
                    const clashes = group.some(
                        (other) =>
                            other !== page &&
                            scopedConceptName([...other.segments.slice(-depth), other.stem]).toLowerCase() ===
                                concept.toLowerCase(),
                    )
                    if (!clashes) break
                }
                report.push({
                    category: 'collision',
                    concept,
                    detail: `"${page.stem}" exists in more than one folder - "${page.dir}/${page.stem}" became the scoped concept "${concept}"`,
                })
            }
            placed.push({ page, ...claimPageName(concept, taken) })
        }
    }
    return placed
}
