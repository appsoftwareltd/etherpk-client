/**
 * Missing blank lines after a list (ADR 0109). CommonMark carries a list item's paragraph on to the
 * next line whatever that line's indent (a lazy continuation), so a line typed at the margin directly
 * under a bullet is part of the bullet's text to every other markdown app. The editor reads a line
 * short of a bullet's content column as a line of its own, and the publisher reads it the same way
 * (`list-item-end-rule.ts`, whose parse finds the lines here).
 *
 * The fix puts the blank line other apps need before each such line, indented as the line is. The
 * editor's outline reads a whitespace-only line by its indent, so the blank line ends the branches
 * the line ends and keeps the owners the line keeps, and the outline reads every line as it did.
 * The fixed page is then parsed by the publisher's parser and the editor's, as other apps will read
 * it, and a line is flagged only when, after the fix:
 *
 * - it starts the same kind of block the publisher reads starting there now, a paragraph mostly. A
 *   line that would become a link reference definition, which a published page hides, or an HTML
 *   or code block, which takes the lines after it, is left.
 * - it starts no setext heading. Separated from the bullet, a line with a `---` or `===` under it
 *   would become a heading's text, where that underline is a rule or text now. A blank line,
 *   indented as the underline is, goes before the underline too, which must then start a rule or
 *   the block the publisher reads there now. A lone `-` after a blank line is a list item, which
 *   takes the lines below it, and a `===` is the paragraph's own text now, so a blank line before
 *   it would split the code spans and links running across it.
 * - the publisher reads every heading, rule and code or HTML block on the page as it does now, the
 *   editor's parser comes to disagree with it on no heading or rule where the two agree now, and the
 *   editor reads the same lines as code and the same links and inline code spans (`codeRanges`,
 *   `wikilinkOccurrencesInSource`), which decide the links and tasks it draws and the index counts.
 *   A change after an unclosed fence, or to a code span running from the bullet into the line, is
 *   left that way. Each line's blank lines are tried alone to find the lines that change something.
 *
 * Where the editor's parser and the publisher disagree on a heading or a rule now, because the
 * margin line keeps the bullet open to CommonMark for the lines after it, the fix brings the editor's
 * parser round to the publisher.
 */

import { parser as commonMark } from '@lezer/markdown'
import MarkdownIt, { type Token } from 'markdown-it'

import { markdownParser } from '../inline-parts'
import { listItemEndRule, parseListItemEnds } from '../publish/markdown/list-item-end-rule'
import { wikilinkOccurrencesInSource } from '../wikilink'
import { type CheckedText, type FormattingCheck, insertionFinding, metadataAndCodeLines } from './finding'
import type { SourceLine } from './line-diff'

/** A line that could start a `-` bullet, the only list the rule reads. A page with none is never parsed. */
const MAYBE_BULLET = /^ *-(?:[ \t]|$)/m

/**
 * The publisher's block parse: raw HTML on, as the publisher has it, because an HTML block can end a
 * paragraph. Its other options are inline, and only the block rules run.
 */
const parser = new MarkdownIt({ html: true })
parser.core.ruler.enableOnly(['normalize', 'block'])
listItemEndRule(parser)

/** How many times the fixed page is parsed again to settle before the page is left alone. */
const PASSES = 8

function reason(count: number): string {
    return count === 1 ? 'a line other apps read as part of the bullet above it' : `${count} lines other apps read as part of the bullets above them`
}

/**
 * A whitespace-only line indented as line `line` is, with the ending of the line before it, or null
 * when the indent holds anything but spaces and tabs: CommonMark reads only those as a blank line.
 */
function blankLike(source: CheckedText, line: number): SourceLine | null {
    const text = source.texts[line]
    const indent = text.slice(0, text.length - text.trimStart().length)
    return /^[ \t]*$/.test(indent) ? { text: indent, ending: source.lines[line - 1].ending } : null
}

/** The page with a blank line before each line `blanks` names: its lines, where each page line went, and back. */
function withBlanks(source: CheckedText, blanks: ReadonlyMap<number, SourceLine>): { lines: string[]; place: number[]; pageOf: number[] } {
    const lines: string[] = []
    const place: number[] = []
    const pageOf: number[] = []
    source.texts.forEach((text, i) => {
        const blank = blanks.get(i)
        if (blank) {
            lines.push(blank.text)
            pageOf.push(-1)
        }
        place.push(lines.length)
        pageOf.push(i)
        lines.push(text)
    })
    return { lines, place, pageOf }
}

/** The block starting at body line `line` in a parse: its first token there. */
function blockAt(tokens: readonly Token[], line: number): Token | undefined {
    return tokens.find((token) => token.map?.[0] === line)
}

function isSetextHeading(token: Token | undefined): boolean {
    return token?.type === 'heading_open' && (token.markup === '-' || token.markup === '=')
}

/** The page lines inside a heading, drawn as a rule, and inside a code or HTML block, as one parser reads a page. */
interface Readings {
    heading: Set<number>
    rule: Set<number>
    code: Set<number>
    /**
     * The editor's only: each wikilink the index reads, and each inline code span, link, image or
     * comment that can hide one or carry one, by page line and column. The site's paragraphs are the
     * same after the fix, so its inline reading is too.
     */
    inline: Set<string>
}

/** Inline nodes whose extent decides whether a wikilink inside them is read (`wikilink/code-ranges.ts`), and links themselves. */
const EDITOR_INLINE = new Set(['InlineCode', 'Comment', 'Link', 'Image', 'Autolink'])

/** markdown-it's code and HTML blocks. */
const SITE_CODE = new Set(['fence', 'code_block', 'html_block'])

/** Code and HTML blocks as plain CommonMark reads them: the lines the editor's links and tasks, and the index, skip (`wikilink/code-ranges.ts`). */
const EDITOR_CODE = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock'])

/** The publisher's readings of a body's parse, `pageLine` taking a body line to the page's. */
function publisherReadings(tokens: readonly Token[], pageLine: (line: number) => number): Readings {
    const readings: Readings = { heading: new Set(), rule: new Set(), code: new Set(), inline: new Set() }
    for (const token of tokens) {
        if (!token.map) continue
        if (token.type === 'heading_open') for (let line = token.map[0]; line < token.map[1]; line++) readings.heading.add(pageLine(line))
        else if (token.type === 'hr') readings.rule.add(pageLine(token.map[0]))
        else if (SITE_CODE.has(token.type)) for (let line = token.map[0]; line < token.map[1]; line++) readings.code.add(pageLine(line))
    }
    return readings
}

/**
 * The editor's readings of a page's lines, `pageLine` taking a line to the page's: headings and rules
 * as its markdown parser draws them, code as its links, its tasks and the index skip it, and the
 * links the index reads.
 */
function editorReadings(lines: readonly string[], pageLine: (line: number) => number): Readings {
    const starts: number[] = []
    let offset = 0
    for (const line of lines) {
        starts.push(offset)
        offset += line.length + 1
    }
    const lineAt = (position: number) => {
        let low = 0
        let high = starts.length - 1
        while (low < high) {
            const middle = (low + high + 1) >> 1
            if (starts[middle] <= position) low = middle
            else high = middle - 1
        }
        return low
    }
    const readings: Readings = { heading: new Set(), rule: new Set(), code: new Set(), inline: new Set() }
    const text = lines.join('\n')
    const at = (position: number) => {
        const line = lineAt(position)
        return `${pageLine(line)}:${position - starts[line]}`
    }
    markdownParser.parse(text).iterate({
        enter(node) {
            if (/^(?:ATX|Setext)Heading\d$/.test(node.name)) {
                for (let line = lineAt(node.from); line <= lineAt(node.to); line++) readings.heading.add(pageLine(line))
                return false
            }
            if (node.name === 'HorizontalRule') readings.rule.add(pageLine(lineAt(node.from)))
            return undefined
        },
    })
    commonMark.parse(text).iterate({
        enter(node) {
            if (EDITOR_INLINE.has(node.name)) readings.inline.add(`${node.name}@${at(node.from)}-${at(node.to)}`)
            if (!EDITOR_CODE.has(node.name)) return undefined
            for (let line = lineAt(node.from); line <= lineAt(node.to); line++) readings.code.add(pageLine(line))
            return false
        },
    })
    for (const link of wikilinkOccurrencesInSource(text)) readings.inline.add(`[[${link.concept}]]@${pageLine(link.line)}:${link.matchStart}`)
    return readings
}

/** What the publisher and the editor read on a page. */
interface PageReadings {
    site: Readings
    editor: Readings
}

/**
 * The page lines the fix would change: a heading, rule or code block the publisher reads
 * differently, a heading or rule the editor's parser comes to disagree with the publisher about,
 * a line that becomes code or stops being code to the editor, or a link or inline span the editor
 * and the index read differently.
 */
function changedReadings(before: PageReadings, after: PageReadings): number[] {
    const lines = new Set<number>()
    for (const readings of [before.site, before.editor, after.site, after.editor]) for (const line of [...readings.heading, ...readings.rule, ...readings.code]) lines.add(line)
    const changed = [...lines].filter(
        (line) =>
            line >= 0 &&
            ((['heading', 'rule', 'code'] as const).some((kind) => after.site[kind].has(line) !== before.site[kind].has(line)) ||
                (['heading', 'rule'] as const).some(
                    (kind) => after.editor[kind].has(line) !== after.site[kind].has(line) && before.editor[kind].has(line) === before.site[kind].has(line),
                ) ||
                after.editor.code.has(line) !== before.editor.code.has(line)),
    )
    // An inline span or link on one side only: its first line, after the `@`.
    for (const mark of [...before.editor.inline, ...after.editor.inline]) {
        if (before.editor.inline.has(mark) && after.editor.inline.has(mark)) continue
        changed.push(Number(mark.slice(mark.lastIndexOf('@') + 1).split(':')[0]))
    }
    return changed
}

/** The page with a set of blank lines put in, and what the publisher and the editor read on it. */
function readWith(source: CheckedText, blanks: ReadonlyMap<number, SourceLine>): { fixed: ReturnType<typeof withBlanks>; tokens: Token[]; readings: () => PageReadings } {
    const top = source.frontmatter
    const fixed = withBlanks(source, blanks)
    const { tokens } = parseListItemEnds(parser, fixed.lines.slice(top).join('\n'))
    return {
        fixed,
        tokens,
        readings: () => ({
            site: publisherReadings(tokens, (line) => fixed.pageOf[top + line]),
            editor: editorReadings(fixed.lines, (line) => fixed.pageOf[line]),
        }),
    }
}

export const blankLineAfterList: FormattingCheck = {
    id: 'blank-line-after-list',
    label: 'Missing blank line after a list',
    help: 'A line directly under a bullet and left of its text is a line of its own in the editor and on a published page. Other markdown apps read it as part of the bullet unless a blank line comes before it.',
    find(source) {
        const top = source.frontmatter
        const body = source.texts.slice(top).join('\n')
        if (!MAYBE_BULLET.test(body)) return null
        const skip = metadataAndCodeLines(source)
        const now = parseListItemEnds(parser, body)
        // Lines the editor reads as code or metadata, where the parser reads them otherwise, are left.
        let flagged = now.ends.map((end) => end + top).filter((line) => !skip[line] && !skip[line - 1])
        if (flagged.length === 0) return null
        // The kind of block the publisher reads starting at a line now: at a flagged line, a paragraph mostly.
        const kindNow = (line: number) => blockAt(now.tokens, line - top)?.type
        const kind = new Map(flagged.map((line) => [line, kindNow(line)]))
        const before: PageReadings = { site: publisherReadings(now.tokens, (line) => line + top), editor: editorReadings(source.texts, (line) => line) }
        // A flagged line's blank line, and its underline's when it needs one, by the line each goes before.
        const blanks = new Map<number, SourceLine>()
        const underline = new Map<number, number>()
        for (const line of flagged) blanks.set(line, blankLike(source, line)!) // the rule reads space indents only
        const drop = (line: number) => {
            blanks.delete(line)
            const under = underline.get(line)
            if (under !== undefined) blanks.delete(under)
            underline.delete(line)
            flagged = flagged.filter((other) => other !== line)
        }
        for (let pass = 0; ; pass++) {
            if (pass === PASSES) return null // still changing: leave the page rather than guess
            const { fixed, tokens, readings } = readWith(source, blanks)
            const startsAt = (line: number) => blockAt(tokens, fixed.place[line] - top)
            // First the underlines: a separated line that would become a setext heading's text gets a blank
            // line before the underline too, and the page is parsed again before anything is judged.
            let added = false
            for (const line of flagged) {
                const block = startsAt(line)
                if (!isSetextHeading(block) || underline.has(line)) continue
                const under = fixed.pageOf[top + block!.map![1] - 1]
                const blank = under > line ? blankLike(source, under) : null
                if (!blank) continue // judged below
                blanks.set(under, blank)
                underline.set(line, under)
                added = true
            }
            if (added) continue
            // Then each line: the block other apps will read starting there is the one the publisher
            // reads now, and its underline, if it has one, starts a rule or what is there now. A `===`
            // is the paragraph's own text now, so a blank line before it would split that paragraph,
            // and the code spans and links running across it.
            const failing = flagged.filter((line) => {
                const block = startsAt(line)
                const under = underline.get(line)
                const underBlock = under === undefined ? undefined : startsAt(under)?.type
                const underlineHolds = under === undefined || underBlock === 'hr' || underBlock === kindNow(under)
                return isSetextHeading(block) || block?.type !== kind.get(line) || !underlineHolds
            })
            if (failing.length > 0) {
                for (const line of failing) drop(line)
                continue
            }
            // Then the page as a whole. Where something changes, each line's blank lines are tried
            // alone, and the lines that change something on their own are left; when none does, only
            // their mix changes it, and the page is left.
            if (changedReadings(before, readings()).length === 0) break
            const culprits = flagged.filter((line) => {
                const own = new Map<number, SourceLine>([[line, blanks.get(line)!]])
                const under = underline.get(line)
                if (under !== undefined) own.set(under, blanks.get(under)!)
                return changedReadings(before, readWith(source, own).readings()).length > 0
            })
            if (culprits.length === 0) return null
            for (const line of culprits) drop(line)
        }
        return insertionFinding(source, blanks, () => reason(flagged.length))
    },
}
