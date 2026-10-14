/**
 * `/Template` (ADR 0144): the Command Menu row that opens a list of the graph's [[Template]]s at
 * the caret, and the Command a pick runs, which copies the Template's body into the editor with
 * its [[Template Variable]]s filled in for the document it lands in.
 *
 * The Template is read when it is picked, never before: the list comes from the index, which
 * holds each Template's name and first line, so opening it reads no document.
 */

import type { EditorView } from '@codemirror/view'

import { showNotice } from '$lib/activity/notices'
import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '$lib/surface'

import { getActiveEditorView } from '../active-editor'
import { conceptKey } from '../backlinks/backlink-index'
import type { TemplateEntry } from '../index-db'
import { insertTemplate } from '../view/template-insert'
import { renderTemplate, templateContextFor } from '../templates/template-variables'
import { type ConceptPickerRequest, showConceptPicker } from '../view/augmentations/concept-picker'
import { isTemplatePage } from '../view/augmentations/template-variables'
import { bodyWritable } from '../view/body-writable'
import { fencedBlockAt, lineInFrontmatter } from '../view/outliner-context'
import { editorDocument } from '../view/editor-document'

export const TEMPLATE_PICK = 'template.pick'
export const TEMPLATE_INSERT = 'template.insert'

/** The user doc a person is pointed at when the graph has no Template yet. */
export const TEMPLATES_DOC_URL = 'https://docs.etherpk.com/templates'

const NOTICE_ID = 'templates'

export interface TemplateCommandDeps {
    /** The graph's Templates by name, from the index. */
    templates(): Promise<readonly TemplateEntry[]>
    /** The body a copy of `concept` takes, or null when it is not a Template or cannot be read. */
    readTemplate(concept: string): Promise<string | null>
    /** The graph's [[Journal Template]], as Graph Settings name it, or null. */
    journalTemplate(): string | null
    /** Test seam: opening the picker. */
    showPicker?: (view: EditorView, request: ConceptPickerRequest) => void
    /** Test seam: the moment of the copy. */
    now?: () => Date
}

export function registerTemplateCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: TemplateCommandDeps): () => void {
    const showPicker = deps.showPicker ?? showConceptPicker
    const now = deps.now ?? (() => new Date())

    const pick = async () => {
        const view = getActiveEditorView()
        if (!view || !bodyWritable(view.state)) return
        const templates = await deps.templates()
        if (!view.dom.isConnected) return
        if (templates.length === 0) {
            showNotice({
                id: NOTICE_ID,
                tone: 'info',
                text: 'This graph has no Templates yet. A page becomes a Template when its frontmatter says template: true.',
                actions: [{ label: 'Read about Templates', run: () => void window.open(TEMPLATES_DOC_URL, '_blank', 'noopener') }],
            })
            return
        }
        const journal = deps.journalTemplate()
        const journalKey = journal ? conceptKey(journal) : null
        showPicker(view, {
            pos: view.state.selection.main.head,
            rows: templates.map((entry) => ({
                concept: entry.concept,
                detail: conceptKey(entry.concept) === journalKey ? 'Journal Template' : entry.firstLine,
            })),
            command: TEMPLATE_INSERT,
            label: 'Insert a Template',
            icon: 'template',
        })
    }

    const insert = async (arg?: unknown) => {
        const concept = (arg as { concept?: unknown } | undefined)?.concept
        if (typeof concept !== 'string') return
        const view = getActiveEditorView()
        if (!view) return
        const body = await deps.readTemplate(concept)
        // The read is a round trip, so the editor it was asked for may have closed, or been locked.
        if (!view.dom.isConnected || !bodyWritable(view.state)) return
        if (body === null) {
            showNotice({
                id: NOTICE_ID,
                tone: 'error',
                text: `"${concept}" could not be inserted, because it is no longer a Template or could not be read.`,
            })
            return
        }
        // The `/` menu is never offered in the frontmatter or in code, but the caret may have moved
        // there while the Template was read, and an outline there would be YAML or code.
        const { head } = view.state.selection.main
        if (lineInFrontmatter(view.state, head) || fencedBlockAt(view.state, head)) {
            showNotice({
                id: NOTICE_ID,
                tone: 'info',
                text: `"${concept}" was not inserted, because the cursor is in the frontmatter or a code block. Move it out and try again.`,
            })
            return
        }
        // The variables are filled in for the document the copy lands in: a journal entry's own
        // day, or today in any other document (ADR 0144). An editor that names no document (a
        // dev harness) is treated as a page. Into a page that is itself a Template the body is
        // copied as written, so one Template can be built from another without freezing its dates.
        const into = view.state.facet(editorDocument)?.concept ?? ''
        insertTemplate(view, isTemplatePage(view.state) ? { text: body, cursor: null } : renderTemplate(body, templateContextFor(into, now())))
        view.focus?.()
    }

    const offs = [
        commands.register(TEMPLATE_PICK, () => pick()),
        commands.register(TEMPLATE_INSERT, (arg) => insert(arg)),
        registerCommandMenuItem(contributions, {
            id: TEMPLATE_PICK,
            title: 'Template',
            detail: 'Insert one of this graph’s Templates',
            icon: 'template',
            group: 'Insert',
            order: 105,
            keywords: ['template', 'snippet', 'boilerplate', 'pattern'],
            when: (ctx) => ctx.bodyWritable,
            command: TEMPLATE_PICK,
        }),
    ]
    return () => {
        for (const off of offs) off()
    }
}
