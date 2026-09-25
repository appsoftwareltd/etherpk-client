/**
 * Augmentation: render a [[Task]]'s `[ ]` / `[x]` as a real checkbox, and make it clickable.
 *
 * A pure decoration + click handler over unaltered markdown (ADR 0001): the source stays
 * `- [ ] text`, so every outliner operation is unaffected. The three characters are painted
 * over, not replaced, and they gain a pointer cursor and a hit target.
 *
 * The click **toggles** (`[ ]` ⇄ `[x]`) rather than cycling. `Mod-Shift-Enter` runs
 * {@link cycleTask}, which is a three-state cycle through *plain bullet* — right for a
 * keyboard chord that has to be able to create and remove the checkbox. A click on a
 * checkbox, though, is a click on a checkbox: making it vanish would be nobody's
 * expectation. The two are deliberately different operations, not an inconsistency.
 */

import { type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import { lineIndent, markerLength } from '../../outliner'
import { toggleTaskLine } from '../../task-tags'
import { isInCode } from '../../wikilink/code-ranges'
import { analysisFor } from '../analysis/editor-analysis'

/**
 * The `[ ]` / `[x]` span, styled as a fixed-size box with the three characters transparent
 * inside it (see the theme below for why a fixed box rather than painting over the glyphs).
 * A mark, not a replace-widget: the characters stay in the document flow, so `markerLength`,
 * the content column, the caret clamp and every outliner operation see exactly the source they
 * always did (ADR 0001). Replacing the range would change all of that arithmetic.
 *
 * The caret cannot land inside the hidden characters either: `caret-clamp.ts` already stops
 * it left of the content column, which on a task line is the end of `- [ ] `.
 */
const checkbox = Decoration.mark({ class: 'cm-task-checkbox' })

/** The checkbox box's side and the gap after it, in editor-font units (the theme below). */
const CHECKBOX_BOX_EM = 0.82
const CHECKBOX_GAP_EM = 0.36

/**
 * The width the checkbox occupies on the line — box plus gap — as a CSS length. The content clamp
 * (content-clamp.ts) adds it to a task line's `padding-left`: the checkbox rides in the lifted
 * line prefix, out of the flow, so the padding alone has to carry the text past it.
 */
export const CHECKBOX_SLOT = `calc(var(--editor-font-size, 1rem) * ${CHECKBOX_BOX_EM + CHECKBOX_GAP_EM})`
const checkboxDone = Decoration.mark({ class: 'cm-task-checkbox cm-task-checkbox--done' })

/** The `[x]` span on a line, as absolute document positions, or null when it is not a task. */
function checkboxRange(lineText: string, lineFrom: number): { from: number; to: number } | null {
    const indent = lineIndent(lineText)
    const marker = /^-\s+(\[[ xX]\])/.exec(lineText.slice(indent))
    if (!marker) return null
    const from = lineFrom + indent + marker[0].length - marker[1].length
    return { from, to: from + marker[1].length }
}

function buildCheckboxes(view: EditorView): DecorationSet {
    const { state } = view
    const analysis = analysisFor(state)
    const decos: Range<Decoration>[] = []
    // A line carrying an inline widget can split `visibleRanges`, so the same line is reachable
    // from both — dedupe by line start or the mark would be added twice (bullet-marker.ts).
    const seen = new Set<number>()
    for (const { from, to } of view.visibleRanges) {
        let pos = from
        while (pos <= to) {
            const line = state.doc.lineAt(pos)
            if (!seen.has(line.from)) {
                seen.add(line.from)
                const range = checkboxRange(line.text, line.from)
                // A `- [ ]` inside a fence is sample text, not a task — the derived index
                // excludes it too, so a clickable checkbox there would toggle something the
                // [[Tasks View]] will never show.
                // ...and one inside the [[Frontmatter]] is YAML, for the same reason (ADR 0061).
                if (range && line.from > analysis.frontmatterEnd && !isInCode(analysis.codeRanges, range.from, range.to)) {
                    const done = state.sliceDoc(range.from + 1, range.from + 2).toLowerCase() === 'x'
                    decos.push((done ? checkboxDone : checkbox).range(range.from, range.to))
                }
            }
            pos = line.to + 1
        }
    }
    return Decoration.set(decos, true)
}

export function taskCheckboxAugmentation(): Extension {
    return [
        ViewPlugin.fromClass(
            class {
                decorations: DecorationSet
                constructor(view: EditorView) {
                    this.decorations = buildCheckboxes(view)
                }
                update(update: ViewUpdate) {
                    if (update.docChanged || update.viewportChanged) {
                        this.decorations = buildCheckboxes(update.view)
                    }
                }
            },
            { decorations: (plugin) => plugin.decorations },
        ),
        EditorView.domEventHandlers({
            mousedown(event, view) {
                if (event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey) return false
                // Hit-test by document position rather than by the decoration's DOM node: the
                // mark can be split across elements by other decorations sharing the span.
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
                if (pos === null) return false
                const line = view.state.doc.lineAt(pos)
                const range = checkboxRange(line.text, line.from)
                if (!range || pos < range.from || pos > range.to) return false
                if (isInCode(analysisFor(view.state).codeRanges, range.from, range.to)) return false

                const next = toggleTaskLine(line.text, line.text[range.from - line.from + 1] === ' ')
                if (next === null) return false
                view.dispatch({
                    changes: { from: line.from, to: line.to, insert: next },
                    // Land at the content column, where the caret clamp would push it anyway —
                    // going there directly avoids a visible hop. Setting a selection at all is
                    // what stops the click starting one inside the (hidden) checkbox.
                    selection: { anchor: line.from + lineIndent(next) + markerLength(next) },
                    userEvent: 'input',
                })
                event.preventDefault()
                return true
            },
        }),
        EditorView.baseTheme({
            // The span IS the checkbox: a fixed-size inline-block, so nothing about it depends
            // on a font. Earlier versions hid the `[ ]` glyphs in place and painted over them,
            // which left two things riding on font metrics — the slot's width (a space is
            // narrower than an `x`, so ticking nudged the line; and one device's mono font is
            // not another's) and the box's height above the baseline (a shrunken inline box
            // sits lower). Both showed up as misalignments on a phone that no emulation here
            // reproduced. A fixed box has neither problem, on any device.
            //
            // The three characters are still there — transparent, laid out inside the box,
            // clipped — so `markerLength`, the content column, the caret clamp and every
            // outliner operation see the source unchanged (ADR 0001), and `posAtCoords` still
            // resolves a tap on the box to a position inside `[ ]`.
            //
            // `vertical-align: middle` centres the box on the parent line's baseline plus half
            // its x-height — the optical centre of lowercase text — measured against the LINE's
            // font, which is exactly what it should line up with. No magic offset.
            //
            // No vertical padding: an inline-block's padding would grow the line box. It is not
            // needed for touch either — `posAtCoords` maps a tap anywhere in the line's height
            // at this x to a position in `[ ]`, so the whole row height is already the target.
            '.cm-task-checkbox': {
                display: 'inline-block',
                verticalAlign: 'middle',
                // `middle` sits on the x-height centre, which for this face is ~0.1em below the
                // text's geometric centre (ascent outweighs descent). Nudged by that much, in
                // the editor-font unit so it scales — relative to the LINE's face, not to a
                // shrunken span, which is what made the old offset device-dependent.
                position: 'relative',
                top: 'calc(var(--editor-font-size, 1rem) * -0.1)',
                boxSizing: 'border-box',
                width: `calc(var(--editor-font-size, 1rem) * ${CHECKBOX_BOX_EM})`,
                height: `calc(var(--editor-font-size, 1rem) * ${CHECKBOX_BOX_EM})`,
                // The slot a plain bullet's text would occupy is `[ ] ` — this margin keeps the
                // task's text roughly where it was, and the box's LEFT edge is the span's left,
                // which is the same column a plain bullet's text starts at.
                marginRight: `calc(var(--editor-font-size, 1rem) * ${CHECKBOX_GAP_EM})`,
                overflow: 'hidden',
                color: 'transparent',
                cursor: 'pointer',
                border: '1.5px solid var(--gk-text-subtle, #9ca3af)',
                borderRadius: '3px',
                // The glyphs inside must not wrap or size the box: whatever font the device
                // uses for them, they are clipped to this fixed box.
                whiteSpace: 'nowrap',
                lineHeight: '1',
            },
            // Syntax highlighting wraps the marker in its own span with its own colour, which
            // beats a `color` on the outer mark. The doubled class raises specificity above
            // that single generated class whatever order the stylesheets end up in.
            '.cm-task-checkbox.cm-task-checkbox *': { color: 'transparent' },
            '.cm-task-checkbox:hover': { borderColor: 'var(--gk-accent, #2563eb)' },
            '.cm-task-checkbox--done': {
                background: 'var(--gk-accent, #2563eb)',
                borderColor: 'var(--gk-accent, #2563eb)',
            },
            // The tick: two borders of an empty box, rotated, centred in the checkbox. Drawn
            // rather than typed so it is crisp at any zoom and needs no font to carry it.
            '.cm-task-checkbox--done::after': {
                content: '""',
                position: 'absolute',
                left: '50%',
                top: '50%',
                boxSizing: 'border-box',
                width: 'calc(var(--editor-font-size, 1rem) * 0.42)',
                height: 'calc(var(--editor-font-size, 1rem) * 0.22)',
                borderLeft: '2px solid #fff',
                borderBottom: '2px solid #fff',
                transform: 'translate(-50%, -70%) rotate(-45deg)',
                pointerEvents: 'none',
            },
        }),
    ]
}
