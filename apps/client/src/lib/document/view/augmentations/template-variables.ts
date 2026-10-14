/**
 * Augmentation host: **Template Variables** (CONTEXT.md, ADR 0144). On a [[Template]] page, each
 * `{{name}}` the renderer fills in is marked as it is written, so the author can see which ones a
 * copy will fill. A name the renderer does not know stays plain text, which is how a typo such as
 * `{{dat}}` shows. Nothing is hidden or replaced: the mark is colour only, so there is no source to
 * reveal and the caret moves through it as through any text.
 *
 * Whether the page is a Template is read from its own frontmatter as it stands, so marking starts
 * and stops as `template: true` is written. A journal entry is never a Template.
 */

import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

import { parseFrontmatter } from '../../../storage/fs/frontmatter'
import { isJournalConcept } from '../../journal-concept'
import { isTemplate } from '../../templates/template-page'
import { templateVariableSpans } from '../../templates/template-variables'
import { analysisFor } from '../analysis/editor-analysis'
import { editorDocument } from '../editor-document'

const VARIABLE_CLASS = 'gk-template-variable'
const mark = Decoration.mark({ class: VARIABLE_CLASS })

/** Whether the document in `state` is a Template, read from its own frontmatter as it stands. */
export function isTemplatePage(state: EditorState): boolean {
    const concept = state.facet(editorDocument)?.concept ?? ''
    if (isJournalConcept(concept)) return false
    const end = analysisFor(state).frontmatterEnd
    if (end < 0) return false
    // Only the block is read, so a long document costs no more than a short one per edit, and it
    // is parsed again only when it changed: typing in the body leaves it as it was.
    const block = state.doc.sliceString(0, Math.min(state.doc.length, end + 1))
    if (block !== lastBlock) {
        lastBlock = block
        lastIsTemplate = isTemplate(parseFrontmatter(block).data, 'page')
    }
    return lastIsTemplate
}

/** The last block read, and what it said: one entry, as the editor being typed in asks again and again. */
let lastBlock = ''
let lastIsTemplate = false

function build(state: EditorState): DecorationSet {
    if (!isTemplatePage(state)) return Decoration.none
    const bodyStart = analysisFor(state).frontmatterEnd + 1
    const body = state.doc.sliceString(bodyStart)
    const ranges: Range<Decoration>[] = []
    for (const span of templateVariableSpans(body)) {
        if (span.known) ranges.push(mark.range(bodyStart + span.from, bodyStart + span.to))
    }
    return Decoration.set(ranges)
}

const variables = StateField.define<DecorationSet>({
    create: build,
    update: (decorations, tr) => (tr.docChanged || tr.startState.facet(editorDocument) !== tr.state.facet(editorDocument) ? build(tr.state) : decorations),
    provide: (field) => EditorView.decorations.from(field),
})

/** The marked ranges, for tests. */
export function markedTemplateVariables(state: EditorState): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = []
    state.field(variables, false)?.between(0, state.doc.length, (from, to) => void out.push({ from, to }))
    return out
}

// Colour and a tint, never a smaller size or a fade: the text stays document text (ADR 0106).
const theme = EditorView.baseTheme({
    [`.${VARIABLE_CLASS}`]: {
        color: 'var(--gk-code-prop)',
        backgroundColor: 'var(--gk-info-surface)',
        borderRadius: '3px',
    },
})

export function templateVariablesAugmentation(): Extension {
    return [variables, theme]
}
