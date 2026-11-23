/**
 * The **Text Editor**: what the editor is for a text file that is not markdown (a `.txt`, a
 * script, a configuration file in a [[Plain Folder]], ADR 0194), and for a markdown file there that
 * the person opens as text (ADR 0204).
 *
 * The markdown editor would do harm there. Its outliner turns Tab into a `- ` bullet, its guards
 * pad fences and its augmentations draw `*emphasis*`, none of which a YAML file or a shell script
 * means. So such a file gets the plain parts only: the text in a monospaced font, the language's
 * own colours where CodeMirror has a grammar for the file's name, Tab as an indent, and several
 * carets at once. Saving, conflicts and line endings are the store's, the same as for a markdown
 * file. The line numbers and the bookmarks beside them are features of their own
 * (augmentations/line-numbers.ts, bookmark-gutter.ts).
 */
import { indentWithTab } from '@codemirror/commands'
import { LanguageDescription, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, crosshairCursor, keymap, rectangularSelection } from '@codemirror/view'

import { fileKindOf } from '#lib/plain/file-kind.js'

import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, CODE_LINE_HEIGHT_SNAPPED, CODE_ROW_PAD, SUPPORTS_ROUNDED_LINE_HEIGHT, markdownWithCodeHighlight } from './augmentations/code-highlight'
import { CODE_TOKEN_STYLES, MARKDOWN_SOURCE_STYLES } from './augmentations/code-token-styles'
import { isTextFile } from './text-file-facet'

export { isTextFile } from './text-file-facet'

const tokenColours = HighlightStyle.define(CODE_TOKEN_STYLES)
const markdownColours = HighlightStyle.define([...CODE_TOKEN_STYLES, ...MARKDOWN_SOURCE_STYLES])

/**
 * The whole file is code, so every line of it is set as a row of fenced code is in a document:
 * the same font, size, line height and room above and below (code-highlight.ts), so a script
 * reads the same in its own tab as it does quoted in a note. On the lines, as the fence's rule
 * is, so the size is taken from the document text's and follows the editor zoom. The selector
 * names the content too, to rank above the editor's own `.cm-line` padding (cm-document.ts)
 * whatever order the two sheets are in.
 */
const textFileTheme = EditorView.theme({
    '.cm-content': {
        fontFamily: 'var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        fontVariantLigatures: 'none',
    },
    // The gutter takes the room the padding gives a document's bookmarks and fold controls, so the
    // text starts just after the numbers. It names the scroller to rank above the padding's own rule.
    '.cm-scroller > .cm-content': { paddingLeft: '0.75rem' },
    '.cm-content .cm-line': {
        fontSize: CODE_FONT_SIZE,
        lineHeight: CODE_LINE_HEIGHT,
        paddingTop: CODE_ROW_PAD,
        paddingBottom: CODE_ROW_PAD,
    },
    [SUPPORTS_ROUNDED_LINE_HEIGHT]: {
        '.cm-content .cm-line': { lineHeight: CODE_LINE_HEIGHT_SNAPPED },
    },
})

/**
 * Several carets at once: a drag with Alt held selects a rectangle, as Notepad++ does, with a
 * crosshair while Alt is down; Ctrl (Cmd on a Mac) and a click adds a caret; Mod+Alt+Up and
 * Mod+Alt+Down add one on the line above or below; and Escape goes back to one. The last three are
 * CodeMirror's own. Only here: the outliner's keys and guards read one selection.
 */
const severalCarets: Extension = [
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    // A rectangle can start on selected text. CodeMirror takes a press there for the start of a
    // drag of the text itself, whatever key is held, so the selection goes first.
    EditorView.domEventHandlers({
        mousedown(event, view) {
            if (event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey) return false
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            const { main } = view.state.selection
            if (pos !== null && main.from <= pos && pos <= main.to && !main.empty) view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' })
            return false
        },
    }),
]

/**
 * A markdown file's grammar, its fenced code coloured by each fence's own. The document editor's
 * parser, without the keys `markdown()` binds: in the Text Editor Enter continues no list.
 */
const markdownSource: Extension = [markdownWithCodeHighlight(), syntaxHighlighting(markdownColours)]

/**
 * The extensions for a text file named `fileName`. The grammar is loaded after the editor is up:
 * most are a separate chunk, and a file with no grammar (a `.txt`, a `.csv`) is simply uncoloured.
 */
export function textFileExtensions(fileName: string): Extension {
    const language = fileKindOf(fileName) === 'markdown' ? markdownSource : languageOf(fileName)
    return [isTextFile.of(true), language, textFileTheme, severalCarets, keymap.of([indentWithTab])]
}

/** The colours of the language CodeMirror has for `fileName`, once its grammar has loaded. */
function languageOf(fileName: string): Extension {
    const language = new Compartment()
    const description = LanguageDescription.matchFilename(languages, fileName)
    const loader = ViewPlugin.define((view) => {
        let gone = false
        void description?.load().then(
            (support) => {
                if (!gone) view.dispatch({ effects: language.reconfigure(support) })
            },
            (error: unknown) => console.warn(`[text-file] no grammar could be loaded for ${fileName}`, error),
        )
        return {
            destroy() {
                gone = true
            },
        }
    })
    return [language.of([]), loader, syntaxHighlighting(tokenColours)]
}
