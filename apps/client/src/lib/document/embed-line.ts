/**
 * A line whose only content is one piece of image syntax, `![alt](target)`, whatever the target
 * is: the shape an **image line** (`image-line.ts`) and a **media line** (`media-line.ts`) share.
 * Each of those adds what the target has to be. Defined once, so the two can never read the same
 * line differently.
 *
 * Two shapes:
 *
 * - **standalone** — `![alt](target)` on its own line.
 * - **bullet** — `- ![alt](target)` or `- [ ] ![alt](target)`: the embed is a bullet's sole content.
 *
 * Pure over the line text, no DOM, no CodeMirror.
 */

import { MARKDOWN_LINK, linkGroups } from './markdown-link-target'

export type EmbedLineKind = 'standalone' | 'bullet'

/** A line that is exactly one markdown link or image (whitespace allowed around it). */
const STANDALONE_LINK = new RegExp(`^\\s*${MARKDOWN_LINK}\\s*$`)
/** A bullet (or task) whose sole content is one: group 1 is the marker prefix. */
const BULLET_LINK = new RegExp(`^(\\s*-\\s(?:\\[[ xX]\\]\\s)?)${MARKDOWN_LINK}\\s*$`)

export interface EmbedLine {
    kind: EmbedLineKind
    /** The raw alt text, size hint and all. */
    alt: string
    /** The target as written. */
    url: string
    /** Column where the `![` starts: 0-ish for a standalone embed, after the marker for a bullet's. */
    imageStart: number
}

/** The shared pattern makes the `!` optional, so an embed has to insist on it. */
function embedOf(match: RegExpExecArray | null): { alt: string; url: string } | null {
    if (!match) return null
    const { bang, label, target } = linkGroups(match)
    return bang === '!' ? { alt: label, url: target } : null
}

/** Parse `text` as a line that is one piece of image syntax and nothing else, or `null`. */
export function parseEmbedLine(text: string): EmbedLine | null {
    // Every such line holds `![`, and most lines of a document do not: skip the patterns for those.
    if (!text.includes('![')) return null
    const standalone = embedOf(STANDALONE_LINK.exec(text))
    if (standalone) return { kind: 'standalone', ...standalone, imageStart: text.indexOf('![') }
    const match = BULLET_LINK.exec(text)
    const bullet = embedOf(match)
    if (!match || !bullet) return null
    return { kind: 'bullet', ...bullet, imageStart: match[1].length }
}
