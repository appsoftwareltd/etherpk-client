/**
 * Augmentation: present [[Frontmatter]] the way a [[Fenced Code Block]] is presented — the same
 * shaded panel, the same monospace, and its `---` delimiters **visible and dimmed** exactly as a
 * fence's backticks are. Never hidden: that was the complaint this exists to answer.
 *
 * The block itself is a real node in the tree (`frontmatter-parse.ts`), so this module only has
 * to paint it. Everything that made the old behaviour wrong — the vanishing closing delimiter,
 * YAML values rendered as markdown — is fixed by the parse rather than patched here.
 *
 * The panel classes are the fenced-code ones (`gk-code-block` and its first/last variants), so
 * the two constructs cannot drift apart visually: change the fence panel and Frontmatter follows.
 *
 * Two more things live here because they are about the block as the user sees it (ADR 0061):
 *
 * - **The editing episode.** What the block says about identity — `title`, `aliases` — is a
 *   proposal, applied when the user is *done* with the block: the caret leaves it, the editor
 *   loses focus, or the editor goes away. The decision is `frontmatter-episode.ts`; the plugin
 *   here only feeds it and reports the end to the View, which hands it to the workspace.
 *
 * What is NOT here: the block's edges. Body text may not join onto the closing delimiter and the
 * block may not grow past what was typed into it - those are transaction filters, and live with
 * the other filters in `view/frontmatter-boundary.ts`.
 * - **The mismatch mark.** When the block disagrees with the registry and nobody is typing in it
 *   — a proposal left unanswered on another device, a concurrent rename — a small mark on the
 *   opening line says which name the document actually answers to, and offers to apply the block
 *   or restore the name. Hidden only while an editing episode in the block is open - there, the
 *   difference is just typing - and never on caret or focus alone: clicking one of its buttons
 *   focuses the editor and lands the caret on the block's first line, and a mark that hid on that
 *   removed its own button between mousedown and click.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Range, RangeSet, StateEffect } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'

import type { ProposalStep } from '$lib/document/frontmatter/proposal'

import { analysisFor } from '../analysis/editor-analysis'
import { EXTERNAL } from '../cm-document'
import { isOwnEditing } from '../own-editing'
import { FrontmatterEpisode } from './frontmatter-episode'
import { FRONTMATTER_MARK, FRONTMATTER_NODE } from './frontmatter-parse'

export interface FrontmatterOptions {
    /**
     * What `blockText` — the block alone, delimiters included — proposes against the registry
     * for this document. Empty when it agrees, when there is no block, or outside a graph.
     */
    proposal: (blockText: string) => ProposalStep[]
    /** The name the document answers to, for the mark's wording; null outside a graph. */
    documentName: () => string | null
    /** An editing episode in the block ended. Reported once per episode, after the update. */
    onEpisodeEnd: () => void
    /** The mark's "Restore": put the registry's identity back into the block. */
    onRestore: () => void
}

/**
 * Dispatched by the View when the registry changed underneath the document — a rename that
 * arrived, aliases that moved — so the mark is recomputed against it. The text is unchanged, so
 * nothing else would trigger it.
 */
export const frontmatterIdentityTick = StateEffect.define<void>()

/** The Frontmatter node's range, or null. Always at the document start, so only the first child. */
function frontmatterRange(state: EditorState): { from: number; to: number } | null {
    const first = syntaxTree(state).topNode.firstChild
    return first && first.name === FRONTMATTER_NODE ? { from: first.from, to: first.to } : null
}

function buildDecorations(state: EditorState): DecorationSet {
    const range = frontmatterRange(state)
    if (!range) return Decoration.none

    const decos: Range<Decoration>[] = []
    const firstLine = state.doc.lineAt(range.from).number
    const lastLine = state.doc.lineAt(range.to).number
    for (let n = firstLine; n <= lastLine; n += 1) {
        const line = state.doc.line(n)
        // The same panel a fence gets: one class for the shading and monospace, plus the
        // first/last variants that round the corners and trim the padding.
        const classes = ['gk-code-block', 'gk-frontmatter']
        if (n === firstLine) classes.push('gk-code-block-first')
        if (n === lastLine) classes.push('gk-code-block-last')
        decos.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
    }

    // Dim the delimiters over their text only, so the panel behind them is untouched — the same
    // mark a fence puts over its backticks and info-string.
    syntaxTree(state).iterate({
        from: range.from,
        to: range.to,
        enter(node) {
            if (node.name === FRONTMATTER_MARK) {
                decos.push(Decoration.mark({ class: 'gk-code-fence-dim' }).range(node.from, node.to))
            }
        },
    })
    return RangeSet.of(decos, true)
}

/** The block's own text, closer included, or null when the document has none. */
function blockText(state: EditorState): string | null {
    const end = analysisFor(state).frontmatterEnd
    return end >= 0 ? state.sliceDoc(0, end + 1) : null
}

/** What the episode plugin tells the mismatch plugin: whether the user is mid-edit in the block. */
interface EditingSession {
    editing: boolean
}

/** Feeds the episode tracker from editor updates and reports the end to the View. */
function episodePlugin(options: FrontmatterOptions, session: EditingSession): Extension {
    return ViewPlugin.fromClass(
        class {
            private readonly episode = new FrontmatterEpisode()

            update(update: ViewUpdate): void {
                const changes: { from: number; to: number }[] = []
                for (const tr of update.transactions) {
                    // Only this user's own editing counts (ADR 0061): a write-back from the
                    // workspace (EXTERNAL) and another member's edit arriving through the
                    // collaborative binding carry no user event, and neither may open an episode -
                    // a half-typed title arriving over sync must never raise a dialog here.
                    if (!tr.docChanged || tr.annotation(EXTERNAL) || !isOwnEditing(tr)) continue
                    tr.changes.iterChangedRanges((fromA, toA) => changes.push({ from: fromA, to: toA }))
                }
                const ended = this.episode.update({
                    blockEndBefore: analysisFor(update.startState).frontmatterEnd,
                    blockEndAfter: analysisFor(update.state).frontmatterEnd,
                    changes,
                    caret: update.state.selection.main.head,
                    focused: update.view.hasFocus,
                })
                session.editing = this.episode.open
                // After the update cycle, so the View's own listener has already forwarded the
                // text to the store the workspace will read.
                if (ended) queueMicrotask(() => options.onEpisodeEnd())
            }

            destroy(): void {
                session.editing = false
                if (this.episode.close()) options.onEpisodeEnd()
            }
        },
    )
}

/** What the mark says and offers, derived from the proposal's steps. */
function describe(steps: readonly ProposalStep[], name: string | null): { text: string; apply: string; title: string } {
    const title = steps.find((step): step is Extract<ProposalStep, { property: 'title' }> => step.property === 'title')
    const who = name === null ? 'this document' : `“${name}”`
    if (title) {
        return {
            text: `Name here differs: this document is ${who}`,
            apply: `Rename to “${title.to}”…`,
            title: `The block says “${title.to}”, but this document answers to ${who}. Apply the block's name, or put the document's name back.`,
        }
    }
    return {
        text: `Aliases here differ from ${who}'s`,
        apply: 'Apply aliases',
        title: `The aliases in this block are not the ones the document has. Apply them, or put the document's aliases back.`,
    }
}

class MismatchWidget extends WidgetType {
    constructor(
        private readonly steps: readonly ProposalStep[],
        private readonly name: string | null,
        private readonly options: FrontmatterOptions,
    ) {
        super()
    }

    eq(other: MismatchWidget): boolean {
        return other.name === this.name && JSON.stringify(other.steps) === JSON.stringify(this.steps)
    }

    toDOM(): HTMLElement {
        const { text, apply, title } = describe(this.steps, this.name)
        const mark = document.createElement('span')
        mark.className = 'gk-frontmatter-mismatch'
        mark.setAttribute('data-testid', 'frontmatter-mismatch')
        mark.title = title
        mark.contentEditable = 'false'
        const label = document.createElement('span')
        label.className = 'gk-frontmatter-mismatch-text'
        label.textContent = text
        mark.append(label, this.button(apply, 'apply', () => this.options.onEpisodeEnd()))
        mark.append(this.button('Restore', 'restore', () => this.options.onRestore()))
        return mark
    }

    private button(label: string, action: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'gk-frontmatter-mismatch-action'
        button.setAttribute('data-action', action)
        button.textContent = label
        // The editor must not take the click as a caret placement into the block.
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', (event) => {
            event.preventDefault()
            onClick()
        })
        return button
    }

    /** Real interactive DOM: CodeMirror must not swallow its events. */
    ignoreEvent(): boolean {
        return false
    }
}

/**
 * The mismatch mark. Recomputed only when the block's text or the registry moved — a proposal
 * is a YAML parse, not something to redo per caret move — and hidden only while an editing
 * episode in the block is open. Sits after the episode plugin in the extension list, so within
 * one update it sees the episode's verdict for that update.
 */
function mismatchPlugin(options: FrontmatterOptions, session: EditingSession): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet = Decoration.none
            private block: string | null = null
            private steps: ProposalStep[] = []
            private hidden = false

            constructor(view: EditorView) {
                this.refresh(view.state, true)
            }

            update(update: ViewUpdate): void {
                const ticked = update.transactions.some((tr) => tr.effects.some((e) => e.is(frontmatterIdentityTick)))
                if (update.docChanged || ticked || session.editing !== this.hidden) {
                    this.refresh(update.state, update.docChanged || ticked)
                }
            }

            private refresh(state: EditorState, recompute: boolean): void {
                this.hidden = session.editing
                const block = blockText(state)
                if (block === null) {
                    this.block = null
                    this.steps = []
                    this.decorations = Decoration.none
                    return
                }
                if (recompute || block !== this.block) {
                    this.block = block
                    this.steps = options.proposal(block)
                }
                if (this.steps.length === 0 || session.editing) {
                    this.decorations = Decoration.none
                    return
                }
                const opener = state.doc.line(1)
                const widget = new MismatchWidget(this.steps, options.documentName(), options)
                this.decorations = Decoration.set([Decoration.widget({ widget, side: 1 }).range(opener.to)])
            }
        },
        { decorations: (v) => v.decorations },
    )
}

/** The air between the block and the first body line: about one line of the editor's base font. */
const FRONTMATTER_GAP = 'calc(var(--editor-font-size, 1rem) * 1.6)'

const theme = EditorView.baseTheme({
    // The panel and monospace come from `gk-code-block` (code-highlight.ts). What is specific to
    // Frontmatter is the vertical padding of its first and last rows. The fence panel's padding
    // is tuned for a BACKTICK, a high glyph whose ink hugs the top of its line box: the first row
    // carries extra top padding to push the fence down off the panel edge, and the last row's
    // panel edge is pulled UP into the empty gap below the high glyph. A dash is a mid-height
    // glyph with no such gap, so under those rules the opening `---` floated far from the top
    // edge while the closing one sat almost on the bottom edge (live, 2026-09-04). Here both
    // rows keep the body's own 0.2em and the panel edge stays put, which lands the dash the same
    // distance from each edge — and about the same distance as a fence's backticks from theirs.
    // Three classes out-specify the fence's two whatever order the base themes land in.
    '.cm-line.gk-frontmatter.gk-code-block-first': { paddingTop: '0.2em' },
    // The gap below the block - close to one body line, so the first line of content does not sit
    // flush against the metadata - is PADDING inside the last row with the panel edge pulled up
    // past it, the way the fence panel makes its own gap. Not a margin: CodeMirror measures a
    // line by its border box, and a margin outside it put every line below out of step with the
    // editor's height map, so a click on one line landed on the next. Sized off the editor's BASE
    // font, not the panel's smaller mono one, so it is one body line whatever the code font is.
    '.cm-line.gk-frontmatter.gk-code-block-last': {
        paddingBottom: `calc(0.2em + ${FRONTMATTER_GAP})`,
    },
    '.cm-line.gk-frontmatter.gk-code-block-last::after': { bottom: FRONTMATTER_GAP },
    // The mismatch mark sits on the opening line after the dimmed `---`, in the prose font so it
    // reads as chrome rather than as part of the YAML.
    '.gk-frontmatter-mismatch': {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: '0.5em',
        marginLeft: '1em',
        fontFamily: 'var(--gk-font-prose, inherit)',
        fontSize: '0.8em',
        color: 'var(--gk-text-subtle, #6b7280)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
    },
    '.gk-frontmatter-mismatch-action': {
        padding: '0.05em 0.5em',
        borderRadius: '4px',
        border: '1px solid var(--gk-border-soft, rgba(127,127,127,0.45))',
        background: 'transparent',
        color: 'var(--gk-text-default, inherit)',
        cursor: 'pointer',
        font: 'inherit',
    },
})

export function frontmatterAugmentation(options: FrontmatterOptions): Extension {
    const plugin = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet
            constructor(view: EditorView) {
                this.decorations = buildDecorations(view.state)
            }
            update(update: ViewUpdate) {
                // The block only ever sits at the document start, so any document change can
                // create or destroy it — and a reparse can arrive without one.
                if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
                    this.decorations = buildDecorations(update.state)
                }
            }
        },
        { decorations: (v) => v.decorations },
    )
    const session: EditingSession = { editing: false }
    return [plugin, episodePlugin(options, session), mismatchPlugin(options, session), theme]
}
