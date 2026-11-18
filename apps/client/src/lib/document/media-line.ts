/**
 * What a **media line** is: a line whose only content is `![alt](target)` over an audio or video
 * [[Asset]], which the editor draws a player under ([[2026-11-18 Audio And Video Players]]).
 *
 * The syntax is the image form of an [[Asset Reference]], and the file's type decides what is
 * drawn: a picture for an image (`image-line.ts`), a player for a recording. Both read the line
 * through `embed-line.ts`.
 *
 * Only an Asset Reference (`../assets/clip.webm`) is a media line. A recording on another site
 * (`![clip](https://example.com/clip.mp4)`) is not played: the Client's Content Security Policy
 * lets media come from the graph's own files only, so it stays the link it is.
 *
 * Pure over the line text, no DOM, no CodeMirror.
 */

import { assetNameFromRef, mediaKindOfExt } from '#lib/storage/fs/asset-store.js'

import { type EmbedLine, parseEmbedLine } from './embed-line'

export type MediaKind = 'audio' | 'video'

/** Whether a file with this extension is played, and as what: the Asset Store's list, as `isImageExt` is. */
export const mediaKindOfExtension: (extension: string) => MediaKind | null = mediaKindOfExt

/**
 * Whether `![…](target)` names a recording in the graph's own files, and of which kind. Only an
 * [[Asset Reference]] can: the same question the asset link asks (`assetNameFromRef`), so a media
 * line always has its link above the player and its file where the Asset Store looks.
 */
export function mediaKindOfTarget(target: string): MediaKind | null {
    const name = assetNameFromRef(target.trim())
    if (name === null) return null
    const dot = name.lastIndexOf('.')
    return dot <= 0 ? null : mediaKindOfExtension(name.slice(dot + 1))
}

export interface MediaLine extends EmbedLine {
    media: MediaKind
}

/** Parse `text` as a media line, or `null` when it is anything else. */
export function parseMediaLine(text: string): MediaLine | null {
    const embed = parseEmbedLine(text)
    if (!embed) return null
    const media = mediaKindOfTarget(embed.url)
    return media ? { ...embed, media } : null
}

export function isMediaLine(text: string): boolean {
    return parseMediaLine(text) !== null
}
