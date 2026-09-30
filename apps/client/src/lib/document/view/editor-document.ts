/**
 * Which document an editor shows and the panel it sits in, as a facet of the editor's own state,
 * for a [[Command]] that holds only the view: `/kanban` names the page's concept from it and
 * opens the board beside the editor (ADR 0113). Read from the view rather than from the active
 * document, which follows tab activation and can name another document than the editor focused.
 */
import { Facet } from '@codemirror/state'

export interface EditorDocumentInfo {
    /** The document's concept: the store's document id. */
    concept: string
    /** The panel the editor is in: its tab's, or the View that embeds it. */
    panelId?: string
}

export const editorDocument = Facet.define<EditorDocumentInfo, EditorDocumentInfo | null>({
    combine: (values) => values[0] ?? null,
})
