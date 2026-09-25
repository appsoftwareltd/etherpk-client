/**
 * Augmentation host: **Inline Math** (CONTEXT.md; ADR 0022). `$…$` spans within a line render
 * in place via the *registered* `math` renderer — the same Contribution Point registration the
 * fence host dispatches to, so replacing or unregistering `math` affects both carriers and no
 * active registry means no rendering. Flip model: a span whose boundary the caret touches (or
 * that any selection overlaps) reveals its raw source; KaTeX resolves in a microtask, so the
 * flip is imperceptible. Lines inside fenced blocks are never scanned (fence content is code),
 * and the scanner itself handles escapes, currency, and inline code spans (math-inline-core).
 */

import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'

import { visibleFencedBlocks } from '../outliner-context'
import { scanInlineMath } from './math-inline-core'
import { rangeRevealed } from './reveal-policy'
import {
    hasRenderFailed,
    isDark,
    markRenderFailed,
    renderFailed,
    renderKey,
    themeTick,
} from './rendered-common'
import { type AugmentationRenderer, lookupAugmentationRenderer } from './renderers/contract'

class InlineMathWidget extends WidgetType {
    constructor(
        readonly tex: string,
        readonly dark: boolean,
        readonly renderer: AugmentationRenderer,
    ) {
        super()
    }

    eq(other: InlineMathWidget): boolean {
        return this.tex === other.tex && this.dark === other.dark
    }

    toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('span')
        wrap.setAttribute('data-augmentation', 'inline-math')
        this.renderer
            .render(this.tex, { dark: this.dark, inline: true })
            .then((node) => {
                wrap.replaceChildren(node)
                view.requestMeasure() // the swap changes the span's size behind CM's back
            })
            .catch(() => {
                // Raw source is the fallback: remember the failure and rebuild NOW (ADR 0022).
                markRenderFailed(renderKey('math', this.tex, this.dark))
                view.dispatch({ effects: renderFailed.of(null) })
            })
        return wrap
    }

    ignoreEvent(): boolean {
        return false // a click lands the caret at the span boundary, which touches → reveals
    }
}

function buildDecorations(state: EditorState): DecorationSet {
    const renderer = lookupAugmentationRenderer('math')
    if (!renderer) return Decoration.none
    const dark = isDark()
    // Fence content is never inline math — collect the fenced line numbers once (1-based).
    const fencedLines = new Set<number>()
    for (const block of visibleFencedBlocks(state)) {
        for (let n = block.start; n <= block.end; n++) fencedLines.add(n + 1)
    }
    const decos: Range<Decoration>[] = []
    for (let n = 1; n <= state.doc.lines; n++) {
        if (fencedLines.has(n)) continue
        const line = state.doc.line(n)
        if (!line.text.includes('$')) continue
        for (const span of scanInlineMath(line.text)) {
            const from = line.from + span.from
            const to = line.from + span.to
            // Touch-inclusive reveal: a caret adjacent to (or selection overlapping) the span
            // shows the raw `$…$` — the inline-format convention.
            const touched = rangeRevealed(state, from, to) // range-kind reveal (reveal-policy.ts)
            if (touched || hasRenderFailed(renderKey('math', span.tex, dark))) continue
            decos.push(Decoration.replace({ widget: new InlineMathWidget(span.tex, dark, renderer) }).range(from, to))
        }
    }
    return Decoration.set(decos, true)
}

/** The Inline Math augmentation (ADR 0022). Mounted in DocumentView alongside the others. */
export function mathInlineAugmentation(): Extension {
    const field = StateField.define<DecorationSet>({
        create: (state) => buildDecorations(state),
        update(deco, tr) {
            const ticked = tr.effects.some((e) => e.is(themeTick) || e.is(renderFailed))
            if (tr.docChanged || tr.selection || ticked) return buildDecorations(tr.state)
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })
    return [field]
}
