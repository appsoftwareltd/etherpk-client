/**
 * The pure rules behind {@link markdownLinkAugmentation}: which spans of a document are
 * external hyperlinks, which syntax characters they hide, and what a click on one opens.
 *
 * Kept out of the augmentation so the shape-by-shape behaviour can be pinned down against a
 * parsed document rather than a mounted CodeMirror view — the edge cases all live here (GFM
 * autolinks plain text, so a `URL` node is not always something a browser can open, and the
 * same node type appears under an `Image`, a `Link`, and free-standing in prose).
 */

import type { Tree } from '@lezer/common'
import { fileLinkPath, isFileUrl } from '../../file-link'

import { assetNameFromRef } from '$lib/storage/fs/asset-store'

import { isImageTarget } from './image-target'
import { MARKDOWN_LINK, linkGroups } from '../../markdown-link-target'

/** `[label](url)` over the exact span of a Lezer `Link` node. The shared pattern allows a
 *  leading `!`; an image is the embed's business, not a link's, so it is refused below. */
const INLINE_LINK = new RegExp(`^${MARKDOWN_LINK}$`)

/** A leading `scheme:` — how a target with a scheme is told from a bare host or relative path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** The schemes a click may hand to the browser. */
const OPENABLE_SCHEME = /^(?:https?|mailto|tel|ftp):/i

/** A scheme-less host GFM autolinked, e.g. `www.example.com`. */
const BARE_HOST = /^www\./i

/** A scheme-less address GFM autolinked, e.g. `docs@example.com`. */
const BARE_EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/

export interface InlineLink {
    label: string
    url: string
}

/** Split `[label](url)`, or `null` when the source is not that shape (a `[[wikilink]]`, say). */
export function parseInlineLink(source: string): InlineLink | null {
    const match = INLINE_LINK.exec(source)
    if (!match) return null
    const { bang, label, target } = linkGroups(match)
    return bang === '' ? { label, url: target } : null
}

/**
 * The href a click should open for a raw link target, or `null` when it must not be opened
 * (in which case the link is left as raw text — better a visibly unstyled target than one
 * that looks clickable and silently does nothing).
 *
 * Two normalisations, both for GFM autolinks, which match plain text rather than URLs:
 * `www.example.com` carries no scheme and a browser would read it as a relative path, and
 * `docs@example.com` is an address. Targets carrying a scheme we do not open — `javascript:`,
 * `data:`, `vbscript:` — are refused: a document is shared, syncing content, and a click on a
 * link someone else wrote must not be able to run script in this app's origin.
 *
 * Anything else scheme-less (`notes/page.md`) is returned untouched, so an ordinary relative
 * markdown link still resolves against the app the way it always has.
 */
export function safeHref(target: string): string | null {
    // Read the target as the browser's URL parser will: it drops leading and trailing C0 controls
    // and spaces, and tabs and newlines anywhere, before it reads the scheme. Checking the raw
    // string instead lets `\u0001javascript:` or `java\tscript:` through as a "relative path".
    // eslint-disable-next-line no-control-regex -- matching C0 controls is the point: the URL parser strips them
    const raw = target.trim().replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')
    if (!raw) return null
    if (HAS_SCHEME.test(raw)) return OPENABLE_SCHEME.test(raw) ? raw : null
    if (BARE_HOST.test(raw)) return `https://${raw}`
    if (BARE_EMAIL.test(raw)) return `mailto:${raw}`
    return raw
}

/**
 * Whether `text` is, in its entirety, an address the browser would open: the [[Hyperlink]] rule
 * applied to a whole string rather than a link target. A relative path is not one (a share of
 * `notes/page.md` is words, not a link), nor is anything holding whitespace. What a
 * [[Share Target]] uses to tell "Chrome put the page's url in the text field" from prose.
 */
export function isOpenableUrl(text: string): boolean {
    const raw = text.trim()
    if (raw === '' || /\s/.test(raw)) return false
    const href = safeHref(raw)
    return href !== null && OPENABLE_SCHEME.test(href)
}

/**
 * What a link target renders as: a hyperlink the browser opens, a [[File Link]] whose path a click
 * copies, or nothing (left raw). The file case is decided BEFORE {@link safeHref}, which refuses
 * the scheme: a file url must never reach the browser, and a consumer that only knows `link`
 * pieces cannot open one by accident.
 */
function targetPiece(target: string): { kind: 'link'; href: string } | { kind: 'file-link'; path: string } | null {
    if (isFileUrl(target)) {
        const path = fileLinkPath(target)
        return path ? { kind: 'file-link', path } : null
    }
    const href = safeHref(target)
    return href ? { kind: 'link', href } : null
}

/** A span to decorate: the clickable link text, or a run of syntax to hide behind it. */
export type LinkPiece =
    /**
     * A [[File Link]]: the text to underline, the native path a click copies (file-link.ts), and
     * the whole construct, syntax included, which the copy icon follows and a caret is "in".
     */
    | { kind: 'file-link'; from: number; to: number; path: string; construct: { from: number; to: number } }
    | { kind: 'link'; from: number; to: number; href: string }
    | { kind: 'hide'; from: number; to: number }

export interface LinkScan {
    tree: Tree
    /** The document text over a range — `EditorState.sliceDoc` in the augmentation. */
    sliceDoc: (from: number, to: number) => string
    /** Range to scan (a viewport slice). */
    from: number
    to: number
    /**
     * True when the caret is on the line holding `pos`. That line shows its raw syntax, so
     * nothing on it is hidden — the reveal that makes a rendered link editable.
     */
    isActiveLine: (pos: number) => boolean
}

/**
 * Every hyperlink span in `[from, to)`, in document order.
 *
 * Three shapes, all from the editor's markdown parser (GFM plus scheme-url-autolink.ts):
 * - `[text](url)` — a `Link`. The **text** is the link; `[` and `](url)` are hidden.
 * - `<https://example.com>` — a `URL` under an `Autolink`. The url is the link; `<`/`>` hidden.
 * - `https://example.com`, `www.example.com`, `docs@example.com` — a free-standing `URL` that
 *   GFM autolinked out of prose — or, for a dotless host GFM ignores (`http://localhost:5174/x`),
 *   that scheme-url-autolink.ts did. There is no syntax to hide: the text *is* the link.
 *
 * A fourth, `![text](url)` over a *non-image* url (a `.pdf` — the shape an import writes for an
 * attachment), renders exactly like `[text](url)`: the embed would only show a broken picture.
 *
 * A `file:` target in any of the three shapes is a `file-link` piece rather than a `link`: the
 * browser cannot open it, so it carries the native path a click copies (CONTEXT.md → File Link).
 *
 * Skipped: [[Asset]] targets (asset-link.ts owns those — it downloads rather than opens),
 * `![…]` images of real images (their url sits under an `Image`), a `[[wikilink]]`'s inner text and the
 * `(url)` half of a markdown link (both parse under a `Link`, which is handled as a whole),
 * and any target {@link safeHref} refuses.
 */
export function linkPieces(scan: LinkScan): LinkPiece[] {
    const { tree, sliceDoc, from, to, isActiveLine } = scan
    const pieces: LinkPiece[] = []
    const hideOffLine = (at: number, hideFrom: number, hideTo: number) => {
        if (hideTo > hideFrom && !isActiveLine(at)) pieces.push({ kind: 'hide', from: hideFrom, to: hideTo })
    }
    tree.iterate({
        from,
        to,
        enter(node) {
            if (node.name === 'Link' || node.name === 'Image') {
                // `![label](url)` differs from `[label](url)` only by the leading `!`.
                const bang = node.name === 'Image' ? 1 : 0
                const link = parseInlineLink(sliceDoc(node.from + bang, node.to))
                if (!link) return // a `[[wikilink]]`'s inner `[…]`, a reference link, …
                if (bang && isImageTarget(link.url)) return // a real image — the embed owns it
                if (assetNameFromRef(link.url) !== null) return
                const piece = targetPiece(link.url)
                if (!piece) return // not openable — leave the whole thing raw
                const labelFrom = node.from + bang + 1
                const labelTo = labelFrom + link.label.length
                if (labelTo <= labelFrom) return // empty label — leave it raw
                pieces.push(
                    piece.kind === 'file-link'
                        ? { ...piece, from: labelFrom, to: labelTo, construct: { from: node.from, to: node.to } }
                        : { ...piece, from: labelFrom, to: labelTo },
                )
                hideOffLine(node.from, node.from, labelFrom) // `[`
                hideOffLine(node.from, labelTo, node.to) // `](url)`
                return
            }
            if (node.name !== 'URL') return
            // A url under a `Link` or an `Image` belongs to that node, which owns its own
            // rendering — only a free-standing (or `<…>`-wrapped) url is ours.
            const parent = node.node.parent
            if (parent && (parent.name === 'Link' || parent.name === 'Image')) return
            const target = sliceDoc(node.from, node.to)
            if (assetNameFromRef(target) !== null) return
            const piece = targetPiece(target)
            if (!piece) return
            const construct = parent?.name === 'Autolink' ? { from: parent.from, to: parent.to } : { from: node.from, to: node.to }
            pieces.push(piece.kind === 'file-link' ? { ...piece, from: node.from, to: node.to, construct } : { ...piece, from: node.from, to: node.to })
            if (parent?.name === 'Autolink') {
                hideOffLine(node.from, parent.from, node.from) // `<`
                hideOffLine(node.from, node.to, parent.to) // `>`
            }
        },
    })
    return pieces
}
