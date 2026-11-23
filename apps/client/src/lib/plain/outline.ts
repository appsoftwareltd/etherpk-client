/**
 * The headings of a markdown file, in order: what a [[Plain Folder]]'s Outline panel lists, and
 * where a link's `#fragment` lands.
 *
 * A heading is an ATX heading (`#` to `######` and a space) outside a fenced code block and the
 * frontmatter, which is the block model's own rule (outliner.ts, `isHeadingLine`). Each has the
 * anchor a repository host gives it, so `guide/soil.md#clay-soil` means the same line there and
 * here. Pure.
 */
import { fencedBlocks } from '../document/fenced-code'
import { isHeadingLine, opaqueLineFlags } from '../document/outliner'

import { headingSlugs } from './plain-path'

export interface OutlineHeading {
    /** 1 for `#`, up to 6. */
    level: number
    /** The heading's words, without its marker or a closing run of `#`. */
    text: string
    /** The 0-based line of the file the heading is on. */
    line: number
    /** Its anchor: what a link's `#fragment` names. */
    slug: string
}

export function headingsOf(text: string): OutlineHeading[] {
    const lines = text.split('\n')
    const opaque = opaqueLineFlags(lines, fencedBlocks(lines))
    const found: Array<Omit<OutlineHeading, 'slug'>> = []
    lines.forEach((line, index) => {
        if (opaque[index] || !isHeadingLine(line)) return
        const trimmed = line.trimStart()
        const level = trimmed.length - trimmed.replace(/^#+/, '').length
        found.push({ level, text: trimmed.slice(level).replace(/\s+#+\s*$/, '').trim(), line: index })
    })
    const slugs = headingSlugs(found.map((heading) => heading.text))
    return found.map((heading, index) => ({ ...heading, slug: slugs[index] }))
}

/** The line a link's fragment names in `text`, or null when no heading has that anchor. */
export function lineOfFragment(text: string, fragment: string): number | null {
    const wanted = fragment.toLowerCase()
    return headingsOf(text).find((heading) => heading.slug === wanted)?.line ?? null
}

/**
 * The headings `line` (0-based) is under, from the outermost in: the nearest at or above it, and
 * each one above that of a lower level. What the file bar shows after the file's name.
 */
export function headingTrail(headings: readonly OutlineHeading[], line: number): OutlineHeading[] {
    const trail: OutlineHeading[] = []
    for (const heading of headings) {
        if (heading.line > line) break
        while (trail.length > 0 && trail[trail.length - 1].level >= heading.level) trail.pop()
        trail.push(heading)
    }
    return trail
}

/** What {@link watchHeadings} needs of the folder's store. */
export interface HeadingSource {
    open(path: string): { getText(): string; subscribe(listener: (text: string) => void): () => void }
    onStateChanged(listener: (path: string) => void): () => void
}

/**
 * Call `listener` with the file's headings now and each time its text changes: reloaded from the
 * folder, or typed. An editor's own edits are not echoed to the document's other listeners, so the
 * store's state change (every edit marks the file unsaved) is what says the text moved under the
 * keys. Returns what stops it.
 */
export function watchHeadings(store: HeadingSource, path: string, listener: (headings: OutlineHeading[]) => void): () => void {
    const document = store.open(path)
    const read = () => listener(headingsOf(document.getText()))
    read()
    const offText = document.subscribe(read)
    const offState = store.onStateChanged((changed) => {
        if (changed === path) read()
    })
    return () => {
        offText()
        offState()
    }
}
