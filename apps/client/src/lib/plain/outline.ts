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
