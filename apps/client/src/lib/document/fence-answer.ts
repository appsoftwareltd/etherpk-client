/**
 * What an extension answered for a fence, through its registration's `publish` (a published site,
 * `publish/publish.ts`) or its `quote` (the reference lists, `view/quoted-fences.ts`, ADR 0146),
 * checked the one way both need: a picture is a PNG, WebP or SVG file with a size, and a link goes to
 * an `https` address, as does any picture in it. An SVG is cleaned afterwards by the caller, where
 * there is a DOM to clean it against (`security/svg-file.ts`).
 *
 * Each part of the answer is read once and the bytes are copied, so what was checked is what is
 * used, whatever the extension does with its own objects afterwards.
 *
 * Framework-free and DOM-free: the Headless Client's publisher reads it too.
 */
import type { PublishedFenceOutput } from './publish/publish'

type PictureType = Extract<PublishedFenceOutput, { kind: 'picture' }>['type']

const PICTURE_TYPES: ReadonlySet<string> = new Set<PictureType>(['image/svg+xml', 'image/png', 'image/webp'])

/** An `https` address as written, or null for any other. */
export function httpsAddress(value: unknown): string | null {
    if (typeof value !== 'string') return null
    try {
        return new URL(value).protocol === 'https:' ? value : null
    } catch {
        return null
    }
}

/** A positive, finite size, or undefined. */
function size(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * The answer as it may be used, or null where the extension said there is nothing to show. Throws,
 * saying why, for anything else: an answer missing altogether among them, which is a mistake rather
 * than a choice.
 */
export function checkedFenceAnswer(out: unknown): PublishedFenceOutput | null {
    if (out === null) return null
    if (typeof out !== 'object') throw new Error('it answered with something that is neither a picture nor a link')
    const answer = out as Record<string, unknown>
    const kind = answer.kind
    if (kind === 'picture') {
        const { type, bytes, alt } = answer
        const width = size(answer.width)
        const height = size(answer.height)
        if (typeof type !== 'string' || !PICTURE_TYPES.has(type) || !(bytes instanceof Uint8Array)) throw new Error('its picture is not an SVG, PNG or WebP file')
        if (width === undefined || height === undefined) throw new Error('its picture has no size')
        return { kind: 'picture', type: type as PictureType, bytes: new Uint8Array(bytes), width, height, alt: String(alt ?? '') }
    }
    if (kind === 'link') {
        const href = httpsAddress(answer.href)
        if (!href) throw new Error('its link is not an https address')
        const text = answer.text
        const image = answer.image
        let picture: { src: string; alt: string; width?: number; height?: number } | undefined
        if (image !== null && typeof image === 'object') {
            const { src: rawSrc, alt, width: rawWidth, height: rawHeight } = image as Record<string, unknown>
            const src = httpsAddress(rawSrc)
            const width = size(rawWidth)
            const height = size(rawHeight)
            if (src) picture = { src, alt: String(alt ?? ''), ...(width !== undefined && height !== undefined ? { width, height } : {}) }
        }
        return { kind: 'link', href, text: String(text ?? href), ...(picture ? { image: picture } : {}) }
    }
    throw new Error('it answered with something that is neither a picture nor a link')
}
