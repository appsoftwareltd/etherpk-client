/**
 * Inline markdown formatting — the Obsidian Live-Preview pattern (Dual Mode Editor.md
 * → Inline markdown formatting). It *styles* constructs and *hides* their syntax
 * markers, revealing the raw markers on whichever line the cursor/selection is on
 * (per-line reveal). A pure decoration over unaltered markdown (ADR 0001).
 *
 * Driven by the `@lezer/markdown` syntax tree the editor already builds — we walk it
 * directly (no `@lezer/highlight` tag system) over the visible ranges, so it is
 * incremental and avoids the whole-document re-parse of the wikilink decoration.
 *
 * Tables are handled separately (markdown-table.ts) as a block widget; this module
 * covers the inline set: headings (`#` and setext underlines), bold, italic, inline code, strikethrough,
 * highlight — and blockquotes,
 * whose `>` markers are hidden the same way and whose lines carry a Logseq-style panel (a shaded
 * box with a left rule, muted text). The panel is a line class here; the text's inset inside it is
 * the content-clamp's (content-clamp.ts), which owns every line's LEFT padding and inline style. Both read the quote's
 * lines from `blockquote-core.ts`, so they cannot disagree about where a quote starts or ends.
 * Thematic breaks (`---`, `***`, `___`) are the other line-level construct: their characters are
 * hidden off-line and the line draws a rule, a background that takes no space.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Line, type Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

import { isFrontmatterDelimiter } from '$lib/storage/fs/frontmatter-span'

import { contentColumn } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { fencedBlockAt } from '../outliner-context'
import { hiddenSyntax, hiddenSyntaxPlugin, type RevealState } from './base-renderer'
import { blockquoteLines } from './blockquote-core'
import { CODE_FONT_SCALE } from './code-highlight'

/** Node name → the style class applied over the construct's content. */
const STYLE: Record<string, string> = {
    ATXHeading1: 'cm-md-h1',
    ATXHeading2: 'cm-md-h2',
    ATXHeading3: 'cm-md-h3',
    ATXHeading4: 'cm-md-h4',
    ATXHeading5: 'cm-md-h5',
    ATXHeading6: 'cm-md-h6',
    StrongEmphasis: 'cm-md-strong',
    Emphasis: 'cm-md-em',
    InlineCode: 'cm-md-code',
    Strikethrough: 'cm-md-strike',
    Highlight: 'cm-md-highlight',
}

/**
 * A setext heading (text with a `===` / `---` line under it) → its style class. Kept apart from
 * {@link STYLE} because the class covers only the heading's text lines, not its underline.
 */
const SETEXT_STYLE: Record<string, string> = {
    SetextHeading1: 'cm-md-h1',
    SetextHeading2: 'cm-md-h2',
}

/** The line class that draws a thematic break (`---`, `***`, `___`) as a rule. */
export const RULE_LINE_CLASS = 'cm-md-hr'

/** The class on a quote's last line, whose panel ends a gap above the line's bottom. */
const QUOTE_LAST_LINE_CLASS = 'gk-quote-last'

/**
 * The bottom (viewport px) of the quote panel drawn on a rendered `.cm-line`, or null when that line
 * does not end a panel: the line's box less the gap the panel leaves below itself, read off its
 * `::after` so it holds at any font size. The outline guides run their threads down to it.
 */
export function quotePanelBottom(line: Element): number | null {
    if (!line.classList.contains(QUOTE_LAST_LINE_CLASS)) return null
    const gap = parseFloat(getComputedStyle(line, '::after').bottom)
    return line.getBoundingClientRect().bottom - (Number.isFinite(gap) ? gap : 0)
}

/** Marker nodes whose characters are hidden unless the cursor is on their line. */
const MARKERS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HighlightMark', 'QuoteMark'])

/** Marker nodes that exclude the whitespace after them (`# `, `> `): that whitespace is hidden with them. */
const MARKERS_WITH_TRAILING_SPACE = new Set(['HeaderMark', 'QuoteMark'])

/**
 * Whether a thematic break the parser found on `line`, starting at `ruleFrom`, is drawn as a rule.
 * Not when:
 *
 * - the editor's fence scan places the line inside a code block. It pairs fences by column and
 *   the parser can close a block earlier, and the editor's reading is the one every other
 *   augmentation (the code panel, the dots, the clamp) follows;
 * - it is the document's first line and a `---`: a Frontmatter opener still being typed (a closed
 *   one is its own node). Drawing it would flash a rule while the metadata is typed;
 * - something other than the outliner's lifted prefix or quote markers precedes it: after `* ` or
 *   `1. `, list markers the editor keeps as typed, the rule would be painted through the marker.
 */
function drawsAsRule(state: EditorState, line: Line, ruleFrom: number): boolean {
    if (fencedBlockAt(state, line.from)) return false
    if (line.number === 1 && isFrontmatterDelimiter(line.text)) return false
    const contentStart = line.from + contentColumn(line.text)
    const lead = ruleFrom > contentStart ? state.doc.sliceString(contentStart, ruleFrom) : ''
    return /^(?:\s*>)*\s*$/.test(lead)
}

/** Hide `[from, line end]` and draw the line as a rule. */
function pushRule(decos: Range<Decoration>[], line: Line, from: number): void {
    if (from < line.to) decos.push(hiddenSyntax.range(from, line.to))
    decos.push(Decoration.line({ class: RULE_LINE_CLASS }).range(line.from))
}

/**
 * Where hiding starts on a line whose syntax begins at `markFrom`: back over any quote markers
 * before it, which the parser does not mark on a setext underline (`> ---`), but never over the
 * leading indent, which the content-clamp lifts out of the flow.
 */
function hideFromOnLine(line: Line, markFrom: number): number {
    const lead = line.text.slice(0, markFrom - line.from)
    return /^\s*(?:>\s*)+$/.test(lead) ? line.from + (lead.length - lead.trimStart().length) : markFrom
}

/**
 * How the editor reads a line the parser took as a setext heading's underline.
 *
 * - `heading`: CommonMark's reading, and the publisher's. The text above is a heading.
 * - `rule`: a `---` under a GFM table. `@lezer/markdown` reads the table as the heading's text,
 *   but the editor's analysis sees the table end above the dashes, and GFM renderers (the
 *   publisher) draw the table and then a rule.
 * - `text`: kept as typed, the text above it prose. CommonMark reads these as underlines too, but
 *   the outliner does not:
 *   - a run of one or two characters. That covers an empty bullet (`- `: an empty list item cannot
 *     interrupt a paragraph, so the parser takes its dash as an underline, and Tab on an empty line
 *     under prose makes exactly that), and the first keystrokes of a bullet, a rule or an
 *     `==highlight==`, which would restyle the line above and move everything below it;
 *   - a line the editor's fence scan places inside a code block ({@link drawsAsRule}).
 */
function underlineReading(state: EditorState, heading: SyntaxNode, underline: SyntaxNode): 'heading' | 'rule' | 'text' {
    const line = state.doc.lineAt(underline.from)
    if (underline.to - underline.from < 3 || fencedBlockAt(state, line.from)) return 'text'
    const first = state.doc.lineAt(heading.from).number - 1
    const underTable = analysisFor(state).tables.some((t) => t.startLine <= first && first <= t.endLine && t.endLine < line.number - 1)
    if (underTable) return state.doc.sliceString(underline.from, underline.from + 1) === '-' ? 'rule' : 'text'
    return 'heading'
}

/**
 * The marks and hidden markers in `[from, to]`; line-kind reveal (reveal-policy.ts) shows a line's
 * markers raw. Pure over the state, so the rule tables read it in Node (outliner-keymap.rules.test.ts).
 */
export function formatDecorations(state: EditorState, from: number, to: number, reveal: RevealState): Range<Decoration>[] {
    const decos: Range<Decoration>[] = []
    const { doc } = state
    {
        syntaxTree(state).iterate({
            from,
            to,
            enter(node) {
                // A thematic break: its characters hidden off-line and the line drawn as a rule. The
                // parser decides which `---` lines these are, so the editor agrees with every other
                // markdown renderer (the publisher included): never the Frontmatter's delimiters,
                // which are their own node, and never a heading's underline (below).
                if (node.name === 'HorizontalRule') {
                    const line = doc.lineAt(node.from)
                    if (drawsAsRule(state, line, node.from) && !reveal.lineRevealedAt(node.from)) {
                        // A bullet's `- ` stays real text, so the line keeps its dot and stays a block
                        // (`- ---`, Logseq's divider); the rule starts at the content column, where the
                        // content-clamp begins the line's content box. A quote's `> ` is a QuoteMark,
                        // hidden below.
                        pushRule(decos, line, Math.max(node.from, line.from + contentColumn(line.text)))
                    }
                    return
                }
                // A setext heading: its text lines styled, and its underline hidden until the caret is
                // anywhere in the heading (block-kind reveal), so editing the text shows why it is a
                // heading. Unless the editor reads the underline otherwise (underlineReading). The
                // children are still walked: the text's own emphasis, links and marks.
                const setext = SETEXT_STYLE[node.name]
                if (setext) {
                    const underline = node.node.getChild('HeaderMark')
                    if (!underline) return
                    const line = doc.lineAt(underline.from)
                    const reading = underlineReading(state, node.node, underline)
                    if (reading === 'heading') {
                        if (line.from - 1 > node.from) decos.push(Decoration.mark({ class: setext }).range(node.from, line.from - 1))
                        if (!reveal.blockRevealedAt(node.from, node.to)) decos.push(hiddenSyntax.range(hideFromOnLine(line, underline.from), line.to))
                    } else if (reading === 'rule' && drawsAsRule(state, line, underline.from) && !reveal.lineRevealedAt(line.from)) {
                        pushRule(decos, line, hideFromOnLine(line, underline.from))
                    }
                    return
                }
                const cls = STYLE[node.name]
                if (cls && node.to > node.from) {
                    decos.push(Decoration.mark({ class: cls }).range(node.from, node.to))
                    return
                }
                if (MARKERS.has(node.name) && node.to > node.from) {
                    // A `CodeMark` is emitted for BOTH inline code (backticks inside `InlineCode`)
                    // and fenced code (the ``` fences inside `FencedCode`). Only hide the inline
                    // kind — fenced-code fences stay visible source (ADR 0018).
                    if (node.name === 'CodeMark' && node.node.parent?.name !== 'InlineCode') return
                    // A setext underline was decided with its heading, above.
                    if (node.name === 'HeaderMark' && SETEXT_STYLE[node.node.parent?.name ?? '']) return
                    // Reveal the raw marker on the cursor's line; hide it elsewhere.
                    if (!reveal.lineRevealedAt(node.from)) {
                        let to = node.to
                        // The heading `#` and quote `>` marks exclude the space after them — hide
                        // that whitespace too, so a hidden `## ` or `> ` leaves no leading gap.
                        if (MARKERS_WITH_TRAILING_SPACE.has(node.name)) {
                            const line = doc.lineAt(node.from)
                            let col = node.to - line.from
                            while (col < line.text.length && (line.text[col] === ' ' || line.text[col] === '\t')) {
                                col++
                            }
                            to = line.from + col
                        }
                        decos.push(hiddenSyntax.range(node.from, to))
                    }
                }
            },
        })
    }
    // The quote panel: a class per quoted line (the ends take the vertical padding and corners). The
    // line's LEFT padding — the text's inset inside the panel — is the content-clamp's, which owns
    // every line's inline style.
    for (const [n, quote] of blockquoteLines(syntaxTree(state), doc, from, to)) {
        const classes = ['gk-quote-line']
        if (quote.first) classes.push('gk-quote-first')
        if (quote.last) classes.push(QUOTE_LAST_LINE_CLASS)
        decos.push(Decoration.line({ class: classes.join(' ') }).range(doc.line(n).from))
    }
    return decos
}

/** Vertical breathing room inside the quote panel, on its first and last line. */
const QUOTE_PAD_Y = '0.45em'
/** How far below its line's top the panel begins: the bullet's dot, pinned to the row top, then sits
 *  just inside the panel's top-left corner (Logseq's quote block) rather than level with its edge. */
const QUOTE_GAP_ABOVE = '0.4em'
/** Clear space below the panel before the next line, so the box does not butt against what follows. */
const QUOTE_GAP_BELOW = '0.5em'

/** A rule's colour: the theme's strong border, the one the quote panel's left rule uses. */
const RULE_COLOUR = 'var(--gk-border-strong, rgba(127,127,127,0.4))'

const theme = EditorView.baseTheme({
    '.cm-md-h1': { fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3' },
    '.cm-md-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.3' },
    '.cm-md-h3': { fontSize: '1.2em', fontWeight: '700' },
    '.cm-md-h4': { fontSize: '1.1em', fontWeight: '700' },
    '.cm-md-h5': { fontWeight: '700' },
    '.cm-md-h6': { fontWeight: '700', opacity: '0.85' },
    '.cm-md-strong': { fontWeight: '700' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through' },
    // A thematic break drawn as a rule across the line's CONTENT box, which begins where the
    // content-clamp's padding places a bullet's or continuation's text, so a bullet's rule starts
    // right of its dot and a nested one at its own depth. A background rather than a border, a
    // margin or a widget: it takes no space, so the line stays exactly one line of text high and
    // nothing below it moves when the caret reveals the `---` (the block-widget height-map rule).
    [`.cm-line.${RULE_LINE_CLASS}`]: {
        backgroundImage: `linear-gradient(${RULE_COLOUR}, ${RULE_COLOUR})`,
        backgroundSize: '100% 2px',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundOrigin: 'content-box',
        backgroundClip: 'content-box',
    },
    // A highlight (`==text==`, highlight-mark.ts): a marker-pen wash behind the text, on the theme's
    // token so dark mode gets its own. Padding widens the wash without changing the line height.
    '.cm-md-highlight': {
        background: 'var(--gk-highlight-bg, rgba(250, 204, 21, 0.45))',
        borderRadius: '2px',
        padding: '0.05em 0.15em',
        margin: '0 -0.05em',
    },
    // Inline code matches a fenced block's font and size (code-highlight.ts), so a `command` in prose
    // reads as the same thing as the block below it rather than a larger, different typeface.
    '.cm-md-code': {
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: `${CODE_FONT_SCALE}em`,
        background: 'var(--gk-surface-2, rgba(0,0,0,0.06))',
        borderRadius: '4px',
        // Room around the text: horizontal padding plus a hair of vertical padding (inline padding does
        // not change the line height, it only widens the painted background).
        padding: '0.1em 0.4em',
        margin: '0 0.1em',
    },
    // A blockquote line (Logseq's quote rendering): muted text on a shaded panel with a left rule.
    // The panel is a `::after` rectangle behind the text, like the code-block panel
    // (code-highlight.ts), so it can start at the quote's content column — `--gk-quote-inset`,
    // set by the content-clamp — rather than at the line's edge under a bullet's dot. Theme-aware
    // through the translucent shade (the same as a code panel's) and the border / text tokens.
    '.cm-line.gk-quote-line': {
        position: 'relative',
        isolation: 'isolate',
        color: 'var(--gk-text-muted, #6b7280)',
        paddingRight: '0.8em',
    },
    '.cm-line.gk-quote-line::after': {
        content: '""',
        position: 'absolute',
        left: 'var(--gk-quote-inset, 0px)',
        right: '0',
        top: '0',
        bottom: '0',
        background: 'var(--gk-quote-bg, rgba(127,127,127,0.10))',
        borderLeft: '3px solid var(--gk-border-strong, rgba(127,127,127,0.4))',
        zIndex: '-1',
        pointerEvents: 'none',
    },
    // The gaps above and below the panel are PADDING on its end lines with the rectangle inset by the
    // same amount — not margins — so every pixel stays inside the line box CodeMirror measures (the
    // code panel's last line insets its rectangle the same way, code-highlight.ts).
    '.cm-line.gk-quote-first': { paddingTop: `calc(${QUOTE_GAP_ABOVE} + ${QUOTE_PAD_Y})` },
    // A bullet's dot (and a task's checkbox) ride in the lifted prefix (content-clamp.ts), whose static
    // position would follow the padded first row DOWN into the panel. Pin it to the line's top instead:
    // the dot then sits exactly where a sibling bullet's does, with the panel beginning QUOTE_GAP_ABOVE
    // below the row top — Logseq's quote block, whose dot marks the box's top-left corner while the
    // quoted text sits a padding lower inside it.
    '.cm-line.gk-quote-first .cm-line-prefix': { top: '0' },
    '.cm-line.gk-quote-first::after': { top: QUOTE_GAP_ABOVE, borderTopRightRadius: '4px' },
    [`.cm-line.${QUOTE_LAST_LINE_CLASS}`]: { paddingBottom: `calc(${QUOTE_PAD_Y} + ${QUOTE_GAP_BELOW})` },
    [`.cm-line.${QUOTE_LAST_LINE_CLASS}::after`]: { bottom: QUOTE_GAP_BELOW, borderBottomRightRadius: '4px' },
})

/** The inline markdown formatting augmentation (Dual Mode Editor.md). */
export function markdownFormatAugmentation(): Extension {
    const plugin = hiddenSyntaxPlugin({ pieces: (view, from, to, reveal) => formatDecorations(view.state, from, to, reveal) })
    return [plugin, theme]
}
