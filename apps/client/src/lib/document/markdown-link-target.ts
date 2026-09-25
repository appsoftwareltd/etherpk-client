/**
 * The one definition of markdown link syntax, shared by every reader of one.
 *
 * Ten places used to spell this out, and each spelled the destination `[^)\s]+`, which stops at
 * the FIRST closing parenthesis. That is wrong the moment a file name contains one, and imported
 * attachments contain them all the time - `Estimate_320_from_B_Sprake_ltd_(1)_1706517395516_0.pdf`
 * is a real example. Every reader then saw the same truncated target, so the link styling and the
 * download and delete controls landed in the middle of the text, and the [[Local Mirror]] reported
 * the stub as a document link to an attachment the graph plainly had (2026-09-10).
 *
 * Sharing only the destination would have left the same duplication one layer down: nine call
 * sites each re-spelling `\[([^\]]*)\]\(` around it. So the whole link is defined here, once, as
 * regex source with **named groups** - which is also what lets a caller read `groups.target`
 * without counting brackets, and what stops the next change to the grammar from silently missing
 * a site.
 *
 * Source rather than a compiled RegExp, because what varies between callers is not the link: it is
 * the anchoring and what surrounds it. One wants a whole line to be nothing but an image, one
 * wants a Logseq `{:height 100}` suffix after it, one scans prose. Each composes what it needs.
 *
 * CommonMark's rule for the unbracketed destination form: no whitespace, and parentheses only in
 * balanced pairs. Nesting is bounded here at two levels, one more than any real file name uses,
 * because an unbounded version needs a recursive parser and would buy nothing.
 *
 * Pure: strings of regex source, no DOM, no CodeMirror.
 */

/**
 * The destination grammar. `excluded` adds characters the caller's context forbids on top of
 * whitespace and parentheses - an HTML attribute cannot hold its own quote, and a target inside
 * markdown brackets cannot hold `]`.
 */
export function linkTargetPattern(excluded = ''): string {
    const plain = `[^\\s()${excluded}]`
    return `(?:${plain}|\\((?:${plain}|\\(${plain}*\\))*\\))+`
}

/** A markdown link destination: `../assets/report_(1).pdf` in full, not `../assets/report_(1`. */
export const LINK_TARGET = linkTargetPattern()

/**
 * A link's label: everything up to its closing bracket, which may hold one balanced `[…]` pair
 * (`[a [b] c](url)`, as CommonMark allows). A bare `[` ends it: were `[` allowed, every `[` in a
 * document with no `]` after it would scan to the end of the text, so a paste of brackets costs
 * time in the square of its length on every edit. With it excluded the scan is linear.
 */
export const LINK_LABEL = '(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*'

/**
 * A whole markdown link or image, as regex source with named groups.
 *
 * - `bang` - `!` for an image, empty for a link.
 * - `label` - the alt text or link text, size hint and all.
 * - `target` - the destination.
 *
 * A regex may not repeat a group name, so compose this **once** per pattern. Wrap it in a group of
 * your own where you need the whole link as one capture.
 */
export const MARKDOWN_LINK = `(?<bang>!?)\\[(?<label>${LINK_LABEL})\\]\\((?<target>${LINK_TARGET})\\)`

/** What {@link MARKDOWN_LINK} captures, once a match is in hand. */
export interface MarkdownLinkGroups {
    bang: string
    label: string
    target: string
}

/** A match's groups, typed. Every {@link MARKDOWN_LINK} match has all three. */
export function linkGroups(match: RegExpMatchArray): MarkdownLinkGroups {
    return match.groups as unknown as MarkdownLinkGroups
}

/** Every markdown link and image in `text`, in document order, with its span. */
export function* markdownLinks(
    text: string,
): Generator<MarkdownLinkGroups & { from: number; to: number; whole: string }> {
    for (const match of text.matchAll(new RegExp(MARKDOWN_LINK, 'g'))) {
        yield {
            ...linkGroups(match),
            from: match.index,
            to: match.index + match[0].length,
            whole: match[0],
        }
    }
}
