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
 * not an image line: the link augmentations render it ({@link isImageTarget}). Over an audio or
 * video file it is a media line (`media-line.ts`). The shape itself is `embed-line.ts`'s.
 *
 * Pure over the line text, no DOM, no CodeMirror.
 */

import { isImageTarget } from './view/augmentations/image-target'
import { type EmbedLine, type EmbedLineKind, parseEmbedLine } from './embed-line'

export type ImageLineKind = EmbedLineKind

/** A line that is one piece of image syntax (`embed-line.ts`) over a target an `<img>` can show. */
export type ImageLine = EmbedLine

/** Parse `text` as an image line, or `null` when it is anything else. */
export function parseImageLine(text: string): ImageLine | null {
    const embed = parseEmbedLine(text)
    return embed && isImageTarget(embed.url) ? embed : null
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
