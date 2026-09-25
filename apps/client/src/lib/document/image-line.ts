/**
 * What an **image line** is — the one definition shared by the editor's structural analysis
 * (which counts them) and the image embed augmentation (which renders them). Before this module
 * each kept its own copy of the two patterns, and any change to one silently missed the other.
 *
 * Two shapes, both a line whose *only* content is one markdown image:
 *
 * - **standalone** — `![alt](url)` on its own line; rendered as a block image.
 * - **bullet** — `- ![alt](url)` or `- [ ] ![alt](url)`: the image is a bullet's sole content;
 *   rendered inline after the marker so the line stays a list item.
 *
 * Image syntax over a non-image target (`![doc](…pdf)`, as an import writes for an attachment) is
 * not an image line: the link augmentations render it ({@link isImageTarget}).
 *
 * Pure over the line text, no DOM, no CodeMirror.
 */

import { isImageTarget } from './view/augmentations/image-target'
import { MARKDOWN_LINK, linkGroups } from './markdown-link-target'

export type ImageLineKind = 'standalone' | 'bullet'

/** A line that is exactly one markdown link or image (whitespace allowed around it). */
const STANDALONE_LINK = new RegExp(`^\\s*${MARKDOWN_LINK}\\s*$`)
/** A bullet (or task) whose sole content is one: group 1 is the marker prefix. */
const BULLET_LINK = new RegExp(`^(\\s*-\\s(?:\\[[ xX]\\]\\s)?)${MARKDOWN_LINK}\\s*$`)

/** The shared pattern makes the `!` optional, so an IMAGE line has to insist on it. */
function imageOf(match: RegExpExecArray | null): { alt: string; url: string } | null {
    if (!match) return null
    const { bang, label, target } = linkGroups(match)
    if (bang !== '!' || !isImageTarget(target)) return null
    return { alt: label, url: target }
}


export interface ImageLine {
    kind: ImageLineKind
    /** The raw alt text, size hint and all (see `image-display-size.ts` for the hint grammar). */
    alt: string
    url: string
    /** Column where the `![` starts: 0-ish for a standalone image, after the marker for a bullet image. */
    imageStart: number
}

/** Parse `text` as an image line, or `null` when it is anything else. */
export function parseImageLine(text: string): ImageLine | null {
    const standalone = imageOf(STANDALONE_LINK.exec(text))
    if (standalone) return { kind: 'standalone', ...standalone, imageStart: text.indexOf('![') }
    const match = BULLET_LINK.exec(text)
    const bullet = imageOf(match)
    if (!match || !bullet) return null
    return { kind: 'bullet', ...bullet, imageStart: match[1].length }
}

/** The kind of image line `text` is, or `null`. Cheaper than {@link parseImageLine} when only the kind matters. */
export function imageLineKind(text: string): ImageLineKind | null {
    return parseImageLine(text)?.kind ?? null
}

export function isImageLine(text: string): boolean {
    return imageLineKind(text) !== null
}

/** Whether the image sits in a bullet (its rendering drops below the row top so the dot reads as the corner). */
export function isBulletImageLine(text: string): boolean {
    return imageLineKind(text) === 'bullet'
}
