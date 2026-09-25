/**
 * Markdown parser extension: autolink an `http://` / `https://` url **whatever its host**, and a
 * `file://` url (a [[File Link]]) —
 * `http://localhost:5174/g/…`, `https://intranet/page`, `http://127.0.0.1:8080`.
 *
 * GFM's extended autolink (the `Autolink` parser in `@lezer/markdown`'s {@link GFM} bundle)
 * only recognises a *dotted* domain: `example.com` yes, `localhost` no. That is the right rule
 * for scheme-less text (`www.` is what tells `www.example.com` from a word), but a url that
 * carries `https://` has already announced itself, and a note full of links to a dev server or
 * an internal host was rendering them as plain prose. This parser runs after GFM's, so it only
 * ever sees the urls GFM declined, and emits the same `URL` node — {@link linkPieces} needs no
 * special case.
 *
 * Kept on the parser side rather than as a regex sweep in the augmentation so a url inside
 * code, a `[label](…)`, or an image is excluded the same way every other inline element is.
 */

import { fileLinkPath, isFileUrl } from '../../file-link'
import { Frontmatter } from './frontmatter-parse'
import { Highlight } from './highlight-mark'
import { GFM, type InlineContext, type MarkdownExtension } from '@lezer/markdown'

/**
 * `scheme://host[:port][/path]` — the host is anything up to a `/`, `:`, whitespace or angle bracket.
 * A `file://` url (CONTEXT.md → File Link) has no host to speak of, so it is any run of
 * non-whitespace after the scheme; what it names is checked afterwards by {@link fileLinkPath}.
 */
const SCHEME_URL = /(?:https?:\/\/[^\s<>/:]+(?::\d+)?(?:\/[^\s<>]*)?|file:\/\/[^\s<>]+)/iy

/** Trailing punctuation that is prose, not url (GFM's rule): `see http://localhost:5174/x.` */
const TRAILING = /[?!.,:*_~]/

/** Inside an open `[…` the url stops at an unbalanced bracket — the `]` closes the link, not the url. */
const NO_UNBALANCED_BRACKET = /([^[\]]|\[[^\]]*\])*/

function count(text: string, from: number, to: number, ch: string): number {
    let n = 0
    for (let i = from; i < to; i++) if (text[i] === ch) n++
    return n
}

/** The end (exclusive, in `text` coordinates) of the url that starts at `from`, or -1. */
export function schemeUrlEnd(text: string, from: number, hasOpenLink = false): number {
    if (from > 0 && /\w/.test(text[from - 1])) return -1 // mid-word, e.g. `xhttp://…`
    SCHEME_URL.lastIndex = from
    const match = SCHEME_URL.exec(text)
    if (!match) return -1
    let end = from + match[0].length
    if (hasOpenLink) end = from + NO_UNBALANCED_BRACKET.exec(text.slice(from, end))![0].length
    for (;;) {
        const last = text[end - 1]
        if (TRAILING.test(last)) end--
        else if (last === ')' && count(text, from, end, ')') > count(text, from, end, '(')) end--
        else break
    }
    // Nothing left past `scheme://`? Then there was no host to link. A file url that names no
    // file (`file://`, `file:///`) is the same case.
    const url = text.slice(from, end)
    if (/^https?:\/\/$/i.test(url)) return -1
    if (isFileUrl(url) && fileLinkPath(url) === null) return -1
    return end
}

/** The extension itself — combine with {@link GFM}; it defers to GFM's `Autolink`. */
export const SchemeUrlAutolink: MarkdownExtension = {
    parseInline: [
        {
            name: 'SchemeUrlAutolink',
            after: 'Autolink',
            parse(cx: InlineContext, _next: number, absPos: number): number {
                const pos = absPos - cx.offset
                const end = schemeUrlEnd(cx.text, pos, cx.hasOpenLink)
                if (end < 0) return -1
                cx.addElement(cx.elt('URL', absPos, end + cx.offset))
                return end + cx.offset
            },
        },
    ],
}

/** Every parser extension the editor's markdown language is built with. */
export const editorMarkdownExtensions: MarkdownExtension[] = [...GFM, Highlight, SchemeUrlAutolink, Frontmatter]
