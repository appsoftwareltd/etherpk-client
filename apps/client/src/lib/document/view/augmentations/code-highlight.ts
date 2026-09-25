/**
 * Live syntax highlighting for [[Fenced Code Block]]s (ADR 0018).
 *
 * Code stays editable text — never a replace-widget. `@codemirror/lang-markdown`'s
 * `codeLanguages` option nests a per-language Lezer parser inside each fence (the grammar
 * is lazy-loaded from `@codemirror/language-data` by info-string), and a {@link HighlightStyle}
 * colours the resulting tokens in place. `addKeymap: false` because the outliner keymap
 * (mounted at `Prec.high`) owns Enter/Tab — we don't want the markdown package injecting its
 * own list/Enter keymap to race with fence completion.
 *
 * The info-string → handler model: this is the *default arm* (no registered renderer). Specific
 * info-strings (`mermaid`, `d2`, …) will later resolve to an Augmentation renderer instead.
 */

import { defineLanguageFacet, HighlightStyle, Language, LanguageSupport, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { type Input, NodeType, Parser, type PartialParse, Tree, type TreeFragment } from '@lezer/common'
import { tags as t } from '@lezer/highlight'
import { type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { isBulletLine } from '../../outliner'
import { visibleFencedBlocks } from '../outliner-context'
import { CODE_TOKEN_STYLES } from './code-token-styles'
import { renderCompleted, rendererCollapsedStarts, themeTick } from './rendered-common'
import { editorMarkdownExtensions } from './scheme-url-autolink'

/** Code renders slightly smaller than prose. Exported so the content-clamp can measure the monospace
 *  space width at the SAME size when it aligns code blocks to the proportional content column. */
export const CODE_FONT_SCALE = 0.86

/** The code-block panel's paddings (in the code font). Exported for a code line's scroll container
 *  (code-scroll.ts), which spans the panel from the left padding's edge to the right one's, and for the
 *  content clamp, which publishes an unindented line's padding as the container's reach. */
export const CODE_PANEL_PAD_LEFT = '0.7em'
export const CODE_PANEL_PAD_RIGHT = '0.8em'

/** The extra gap above a form-1 opener's panel (`- ``` `), as top padding with the panel inset to match. */
const OPENER_DROP = '0.2em'

/**
 * Raw HTML in a document is prose (Editor Content Rules → Standard prose). `markdown()` mounts an
 * HTML grammar inside every `HTMLBlock`, inline `HTMLTag` and `CommentBlock`, and loads that
 * language's support extensions with it: the nested tokens took the code colours below (`<p>` in
 * tag green), and lang-html's tag auto-close typed `</p>` after every `<p>`. The option takes a
 * `LanguageSupport`, so this one's parser yields an empty tree and it carries no support: the tag
 * stays the plain text the user typed. A fenced ```html block is unaffected: it nests through
 * `codeLanguages`, whose lazily loaded grammar contributes its parser only.
 */
class EmptyTreeParser extends Parser {
    createParse(_input: Input, _fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
        // `Parser.startParse` always passes at least one range.
        const from = ranges[0].from
        const to = ranges[ranges.length - 1].to
        return {
            parsedPos: to,
            stoppedAt: null,
            stopAt() {},
            // The shape CodeMirror itself mounts while a fence grammar is still loading. Its public
            // `ParseContext.getSkippingParser()` makes the same tree but registers the ranges as skipped,
            // so the context would keep re-scheduling a parse that never has anything more to say.
            advance: () => new Tree(NodeType.none, [], [], to - from),
        }
    }
}
const htmlAsProse = new LanguageSupport(new Language(defineLanguageFacet(), new EmptyTreeParser(), [], 'html-as-prose'))

/**
 * Markdown parser with GFM (+ any-host url autolinking, scheme-url-autolink.ts) and nested
 * per-language highlighting for fenced code. Raw HTML is prose ({@link htmlAsProse}); the tag
 * completion source is off for the same reason (it would only speak once a completion extension
 * without an `override` list was mounted, which none is).
 */
export function markdownWithCodeHighlight(): Extension {
    return markdown({
        extensions: editorMarkdownExtensions,
        codeLanguages: languages,
        addKeymap: false,
        htmlTagLanguage: htmlAsProse,
        completeHTMLTags: false,
    })
}

/** Token colours for nested code: the table the read-only quotes share (code-token-styles.ts). */
const codeHighlightStyle = HighlightStyle.define(CODE_TOKEN_STYLES)

/**
 * Markdown's own tokens take no code colour. GFM tags a task's `[ ]` as `atom`, and `atom` inherits
 * from `keyword` in `@lezer/highlight`, so any `[ ]` the task-checkbox augmentation does not own —
 * a nested `- - [ ] x`, which is not a task and gets no special handling; the user corrects it —
 * rendered in keyword green. Scoped to the markdown language so an atom inside a fenced block keeps
 * its colour. Registered BEFORE the code style: the view mounts style modules in reverse facet
 * order, so the earlier extension's rules land later in the sheet and win the cascade.
 */
const markdownNoCodeColour = HighlightStyle.define([{ tag: t.atom, color: 'inherit' }], { scope: markdownLanguage })

/**
 * Live-preview styling (ADR 0018): fenced-code source lines are monospaced and sit on a shaded
 * code-block background, so the block reads as "rendered" while staying editable. The ``` fence
 * lines are dimmed when the caret is outside the block, and brighten when it enters to edit.
 * `gk-code-line` is applied by the content-clamp (non-bullet code lines); `gk-code-fence-dim` is
 * applied caret-awarely by {@link fenceDimPlugin} below.
 */
const codeLineTheme = EditorView.baseTheme({
    // `gk-code-line` is applied by the content-clamp to non-bullet code lines (monospace only;
    // the shaded panel comes from `gk-code-block` so the bullet-opener line is covered too).
    '.cm-line.gk-code-line': {
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    },
    // The shaded code-block panel is drawn by a `::after` rectangle, NOT a line background — so it can
    // start exactly at the fence column and carry real rounded corners there. It spans to the right edge
    // and the full line height, BEHIND the text, so a code line's own indentation sits on the panel
    // instead of being whited out by the clamp mask (which stops at this same edge — see
    // content-clamp.ts). Inside a bullet the panel begins AT the fence column (one space right of the
    // `- ` marker) so it no longer butts against the bullet; the code is slightly smaller than prose.
    '.cm-line.gk-code-block': {
        position: 'relative',
        isolation: 'isolate',
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontSize: `${CODE_FONT_SCALE}em`,
        // Tighter than the prose `line-height: 1.7` — code reads better compact, and the loose leading
        // is what made the top/bottom panel padding dwarf the side padding (`0.7em`). At 1.4 the leading
        // is small enough that the first/last rows' padding lands the fences `0.7em` from the panel edge,
        // matching the sides.
        lineHeight: '1.4',
        paddingTop: '0.2em',
        paddingBottom: '0.2em',
        paddingLeft: `calc(var(--code-inset, 0px) + ${CODE_PANEL_PAD_LEFT})`,
        paddingRight: CODE_PANEL_PAD_RIGHT,
    },
    '.cm-line.gk-code-block::after': {
        content: '""',
        position: 'absolute',
        left: 'var(--code-inset, 0px)',
        right: '0',
        top: '0',
        bottom: '0',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        zIndex: '-1',
        pointerEvents: 'none',
    },
    // Make the fence rows sit the same distance from the panel edge top & bottom as the code does from the
    // left (~0.7em of breathing room). A backtick is a HIGH glyph — its ink hugs the top of the line box —
    // so the two edges need different treatment: the top row needs padding to push the fence down off the
    // edge, but the bottom row has a tall empty gap *below* the high backticks that padding can't remove,
    // so the panel's bottom edge is pulled UP into that gap via the `::after` `bottom` inset. (Tuned for
    // the `--gk-mono` metrics; scales with the font via `em`.)
    '.cm-line.gk-code-block-first': { paddingTop: '0.6em' },
    // A form-1 opener (`- ``` `) sits on a bullet line whose invisible base-size `- ` prefix already makes
    // the row ~0.45em taller than a pure-code opener (prose or a form-2 indented fence), so it needs much
    // less top padding to land the fence at the same distance from the edge. (The bullet dot on this line
    // is lifted to the panel's top-left corner in bullet-marker.ts, decoupling it from the padded fence.)
    // A further `OPENER_DROP` makes up the row this opener loses to the tighter code line-height + lifted
    // dot, so its bullet sits the same distance below the bullet above it as any other pair (the whole
    // block, including everything below, shifts down together — only the gap ABOVE the block grows).
    // The drop is PADDING with the panel inset by the same amount, never a margin: CodeMirror's height
    // map measures a line's border box, which excludes margins, so a margin here put the map 0.2em
    // behind the DOM for every line below each bulleted code block, and a selection drawn from the map
    // (or a click mapped through it) landed that much higher per block above it (ADR 0022).
    '.cm-line.gk-code-block-first-bullet': { paddingTop: `calc(0.14em + ${OPENER_DROP})` },
    '.cm-line.gk-code-block-first-bullet::after': { top: OPENER_DROP },
    '.cm-line.gk-code-block-first::after': { borderTopLeftRadius: '5px', borderTopRightRadius: '5px' },
    '.cm-line.gk-code-block-last': { paddingBottom: '0' },
    '.cm-line.gk-code-block-last::after': { bottom: '0.42em', borderBottomLeftRadius: '5px', borderBottomRightRadius: '5px' },
    // Dim is a MARK over the fence text only (backticks + language id) — the panel background,
    // a line decoration behind it, is unaffected, so fence lines and body share one background.
    '.gk-code-fence-dim': { opacity: '0.5' },
    // A form-1 opener (`- ``` `) is a bullet line that also opens a code block, so the whole line is
    // monospaced by `gk-code-block`. That makes the `- ` marker render in the (wider) mono font, pushing
    // the bullet dot right of its siblings and the fence off the proportional content column — worse with
    // depth. This mark restores the prose font (at the editor base size, not the line's smaller code size)
    // over JUST the structural prefix (indent + `- `), so the dot lines up with sibling bullets and the
    // backticks fall exactly on the proportional content column. The fence run after it stays monospace.
    '.gk-code-opener-prefix': {
        fontFamily: 'var(--gk-sans, "Inter", system-ui, sans-serif)',
        fontSize: 'var(--editor-font-size, 1rem)',
    },
    // The panel's left edge is aligned to the content column (where the opener fence sits), so the body
    // code lands one PANEL_PAD inside the panel. Nudge the form-1 opener's fence run right by the same
    // amount so the opener `` ``` `` lines up with the padded body instead of sitting flush at the edge.
    // (Must match `PANEL_PAD` in content-clamp.ts; kept a local literal to avoid an import cycle.)
    '.gk-code-opener-fence': { marginLeft: '0.6em' },
    // An unterminated fence reads as plain text: strip the nested-language token colours (and any
    // bold/italic) the parser applied to its content. The `.cm-line.x span` selector out-specifies the
    // single-class highlight tokens; `!important` covers it regardless of stylesheet order.
    '.cm-line.gk-fence-incomplete span': {
        color: 'inherit !important',
        fontStyle: 'normal !important',
        fontWeight: 'normal !important',
    },
})

const fenceTextDim = Decoration.mark({ class: 'gk-code-fence-dim' })
/** Restores the prose font over a form-1 opener's `[indent]- ` prefix (see the theme rule). */
const openerPrefixProse = Decoration.mark({ class: 'gk-code-opener-prefix' })
/** Nudges a form-1 opener's fence run right by one PANEL_PAD so it sits inside the panel, aligned with
 *  the padded body code, instead of flush at the panel's left edge (see the theme rule). */
const openerFenceInset = Decoration.mark({ class: 'gk-code-opener-fence' })

/**
 * Build the code-block panel decorations from the **complete** fenced blocks (paired opener+closer
 * via the line-scan — so an unterminated fence never shades the document below it). Each block line
 * gets the shaded panel (a line decoration, uniform background inset to the fence column); the first
 * and last lines get vertical padding. When the caret is outside the block, the fence backticks and
 * language id are dimmed via a MARK over just that text — leaving the panel background untouched, so
 * the fence lines and the body share one background.
 */
function buildCodeBlockDecorations(view: EditorView): DecorationSet {
    const { state } = view
    const decos: Range<Decoration>[] = []
    const inCompleteBlock = new Set<number>() // 1-based line numbers inside a real (closed) block
    // Blocks currently collapsed to a rendered widget (ADR 0022): they are still complete blocks
    // (so the incomplete-fence neutralisation below must not touch them) but must get NO panel,
    // dim, or prefix styling — for a collapsed form-1 the opener line stays visible, and a shaded
    // diagram-tall code panel behind the widget is exactly what suppression prevents.
    const collapsed = rendererCollapsedStarts(state)
    for (const block of visibleFencedBlocks(state)) {
        const startLine = state.doc.line(block.start + 1)
        const endLine = state.doc.line(block.end + 1)
        if (collapsed.has(block.start)) {
            for (let n = block.start; n <= block.end; n++) inCompleteBlock.add(n + 1)
            continue
        }
        const caretInside = state.selection.ranges.some((r) => r.from <= endLine.to && r.to >= startLine.from)
        // form-1: the opener sits on a bullet line (`- ``` `). Render its `[indent]- ` prefix in the prose
        // font so the dot and content column match the surrounding bullets (the rest stays monospace).
        const form1 = isBulletLine(startLine.text)
        if (form1 && block.fenceColumn > 0) {
            decos.push(openerPrefixProse.range(startLine.from, startLine.from + block.fenceColumn))
            // The fence run (backticks + info) after the prefix: nudge it right to sit inside the panel,
            // aligned with the padded body code. Only when there is a run to shift (a bare `- ``` `).
            if (startLine.from + block.fenceColumn < startLine.to) {
                decos.push(openerFenceInset.range(startLine.from + block.fenceColumn, startLine.to))
            }
        }
        for (let n = block.start; n <= block.end; n++) {
            const line = state.doc.line(n + 1)
            inCompleteBlock.add(n + 1)
            const classes = ['gk-code-block']
            if (n === block.start) {
                classes.push('gk-code-block-first')
                // A form-1 (bullet-line) opener is taller than a pure-code opener, so it takes a reduced
                // top padding; prose and form-2 openers keep the default.
                if (form1) classes.push('gk-code-block-first-bullet')
            }
            if (n === block.end) classes.push('gk-code-block-last')
            // Class only — the panel's left inset (`--code-inset`) is set by the content-clamp, which
            // owns each line's `style` (margin + padding) and the per-depth code shift, so the opener's
            // panel and the (shifted) body panels line up. Two line decorations can't both set `style`.
            decos.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
            // Dim the fence text (backticks + language id) when the caret is away — text only, not the bg.
            const isFence = n === block.start || n === block.end
            if (isFence && !caretInside) {
                const textFrom = line.from + block.fenceColumn // skip indent / the `- ` marker
                if (textFrom < line.to) decos.push(fenceTextDim.range(textFrom, line.to))
            }
        }
    }
    // An UNTERMINATED fence reads as plain text — no panel and no nested syntax colouring. The PARSER
    // still tags its content as code (its `FencedCode` node runs to the doc end / the next bare fence),
    // and that pairing can differ from ours (it is unaware of outliner-block scoping). So neutralise the
    // token colours on every line the parser thinks is code but our balance-aware scan does NOT place in
    // a real block — leaving prose (and genuine blocks) untouched. The line class's descendant-span rule
    // out-specifies the single-class highlight tokens.
    for (const n of parserCodeLines(state)) {
        if (!inCompleteBlock.has(n)) {
            decos.push(Decoration.line({ class: 'gk-fence-incomplete' }).range(state.doc.line(n).from))
        }
    }
    // Line decorations sort before marks at the same position; `sort: true` orders the rest.
    return Decoration.set(decos, true)
}

/** 1-based line numbers the markdown parser places inside a `FencedCode` node (its own pairing). */
function parserCodeLines(state: EditorState): Set<number> {
    const set = new Set<number>()
    syntaxTree(state).iterate({
        enter: (node) => {
            if (node.name !== 'FencedCode') return
            const first = state.doc.lineAt(node.from).number
            const last = state.doc.lineAt(Math.min(node.to, state.doc.length)).number
            for (let n = first; n <= last; n++) set.add(n)
        },
    })
    return set
}

const codeBlockPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet
        constructor(view: EditorView) {
            this.decorations = buildCodeBlockDecorations(view)
        }
        update(update: ViewUpdate) {
            // themeTick / renderCompleted change the rendered-fence collapse state without a doc or
            // selection change — the panel suppression must follow it (rendered-common.ts).
            const ticked = update.transactions.some((tr) =>
                tr.effects.some((e) => e.is(themeTick) || e.is(renderCompleted)),
            )
            if (update.docChanged || update.viewportChanged || update.selectionSet || ticked) {
                this.decorations = buildCodeBlockDecorations(update.view)
            }
        }
    },
    { decorations: (v) => v.decorations },
)

/** The highlight-style + theme + code-block panel half (the parser half is {@link markdownWithCodeHighlight}). */
export function codeHighlighting(): Extension {
    return [syntaxHighlighting(markdownNoCodeColour), syntaxHighlighting(codeHighlightStyle), codeLineTheme, codeBlockPlugin]
}
