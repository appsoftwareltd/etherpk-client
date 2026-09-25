/**
 * How a document is named on disk, shared by every backend that writes a folder: the
 * [[Filesystem Backend]] (`fs/filesystem-store.ts`, `allocateFileName`) and the [[Local Mirror]]
 * (`server/mirror-names.ts`, `planMirrorNames`). One rule, the one the Logseq and Obsidian
 * converters already follow: **suffix the file name, keep the title**.
 *
 * A document's file is `<portable stem of its concept>.md`. The stem is lossy - `etc` and `etc.`,
 * `A/B` and `A_B`, `CON` and `CON_` are distinct concepts on one stem - so a second document
 * wanting a name already taken gets ` (2)`, ` (3)` and so on. The title inside is never touched:
 * identity is the frontmatter `title` (ADR 0007, ADR 0061), so a suffixed file invents no concept,
 * which is what keeps this clear of ADR 0038's refusal of `(2)` suffixes for *concept* collisions.
 * A folder either backend wrote is read back the same way by the other, and by [[Import]].
 *
 * Pure: strings only.
 */

import { portableFileStem } from '$lib/document/wikilink/derive'

import { fileStem } from './fs/identity'

/** The unsuffixed file name for a concept: its portable stem plus the markdown extension. */
export function portableFileName(concept: string): string {
    return `${portableFileStem(concept)}.md`
}

/** `Foo.md` at index 1, `Foo (2).md` at 2, and so on. */
export function suffixedFileName(base: string, index: number): string {
    if (index <= 1) return base
    return `${fileStem(base)} (${index}).md`
}
