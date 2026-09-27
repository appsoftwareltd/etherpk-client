/**
 * Obsidian's own syntax that EtherPK does not have: comments, callouts, footnotes and tags. The
 * converter either turns each into the nearest markdown EtherPK draws, or keeps it and says so in
 * the [[Import Report]], so the report's "nothing is silently dropped" stays true.
 *
 * Code is left alone throughout: a fence's interior and an inline code span are literal in
 * Obsidian too.
 */

import { createFenceTracker, outsideInlineCode } from './convert-shared'

/** One `%% … %%` comment: its span in the body, and its text without the markers. */
export interface ObsidianComment {
    from: number
    to: number
    text: string
}

/**
 * Every closed comment in a note body, outside fences and inline code. An opener with no closer
 * is text, as Obsidian shows it, so it is not a comment here either. A comment may run over
 * several lines; nothing inside one opens a fence or a code span.
 */
export function obsidianComments(body: string): ObsidianComment[] {
    const comments: ObsidianComment[] = []
    const inFence = createFenceTracker()
    let open: number | null = null
    let offset = 0
    for (const line of body.split('\n')) {
        if (open !== null || !inFence(line)) {
            let i = 0
            while (i < line.length) {
                if (open === null && line[i] === '`') {
                    const run = /^`+/.exec(line.slice(i))![0]
                    const close = line.indexOf(run, i + run.length)
                    i = close === -1 ? i + run.length : close + run.length
                    continue
                }
                if (line.startsWith('%%', i)) {
                    if (open === null) {
                        open = offset + i
                    } else {
                        comments.push({ from: open, to: offset + i + 2, text: body.slice(open + 2, offset + i) })
                        open = null
                    }
                    i += 2
                    continue
                }
                i++
            }
        }
        offset += line.length + 1
    }
    return comments
}

/**
 * The body without its comments. A comment that has its lines to itself takes them with it, so
 * removing one leaves no blank line where it was; one inside a line leaves the rest of the line.
 */
export function withoutComments(body: string, comments: readonly ObsidianComment[]): string {
    let out = ''
    let cursor = 0
    for (const { from, to } of comments) {
        const lineStart = body.lastIndexOf('\n', from - 1) + 1
        const nextBreak = body.indexOf('\n', to)
        const lineEnd = nextBreak === -1 ? body.length : nextBreak
        const alone = body.slice(lineStart, from).trim() === '' && body.slice(to, lineEnd).trim() === ''
        if (alone && lineStart >= cursor) {
            out += body.slice(cursor, lineStart)
            cursor = nextBreak === -1 ? body.length : nextBreak + 1
        } else {
            out += body.slice(cursor, from)
            // Between two words, the words keep one space between them, not two.
            cursor = body[from - 1] === ' ' && body[to] === ' ' ? to + 1 : to
        }
    }
    return out + body.slice(cursor)
}

/** A callout's header line: the quote markers, then `[!type]`, a fold sign, and an optional title. */
const CALLOUT = /^(\s*(?:>\s?)+)\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/

/**
 * A callout header as a quote with a bold heading, as Obsidian heads the box: the type, and the
 * title after it when the note gives one. The quote's body lines are already plain markdown.
 * Null for a line that is not a callout header.
 */
export function calloutHeading(line: string): { line: string; type: string } | null {
    const match = CALLOUT.exec(line)
    if (!match) return null
    const [, quote, type, , title] = match
    const label = type[0].toUpperCase() + type.slice(1).toLowerCase()
    const heading = title.trim() === '' || title.trim().toLowerCase() === type.toLowerCase() ? label : `${label}: ${title.trim()}`
    return { line: `${quote}**${heading}**`, type }
}

/** Footnote references and definitions, `[^1]` and `[^note]:`. */
const FOOTNOTE = /\[\^[^\]\s]+\]/

/**
 * Obsidian tags: `#` then a name with at least one letter, nesting with `/`. Not a heading (`# `),
 * and not in the middle of a word or a url fragment.
 */
const TAG = /(?:^|[\s(])#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/gu

/** A markdown link's destination, `](…)`: an in-note anchor there (`](#section)`) is no tag. */
const LINK_DESTINATION = /\]\([^)]*\)/g

/** What a note body holds that EtherPK keeps as written: its footnotes and its tags. */
export function unsupportedConstructs(body: string): { footnotes: boolean; tags: string[] } {
    const inFence = createFenceTracker()
    let footnotes = false
    const tags = new Set<string>()
    for (const line of body.split('\n')) {
        if (inFence(line)) continue
        outsideInlineCode(line, (segment) => {
            if (FOOTNOTE.test(segment)) footnotes = true
            for (const match of segment.replace(LINK_DESTINATION, ']').matchAll(TAG)) tags.add(`#${match[1]}`)
            return segment
        })
    }
    return { footnotes, tags: [...tags] }
}
