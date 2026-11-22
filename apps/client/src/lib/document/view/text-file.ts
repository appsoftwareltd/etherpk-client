/**
 * What the editor is for a text file that is not markdown: a `.txt`, a script, a configuration
 * file in a [[Plain Folder]] (ADR 0194).
 *
 * The markdown editor would do harm there. Its outliner turns Tab into a `- ` bullet, its guards
 * pad fences and its augmentations draw `*emphasis*`, none of which a YAML file or a shell script
 * means. So such a file gets the plain parts only: the text in a monospaced font, the language's
 * own colours where CodeMirror has a grammar for the file's name, and Tab as an indent. Saving,
 * conflicts and line endings are the store's, the same as for a markdown file.
 */
import { indentWithTab } from '@codemirror/commands'
import { LanguageDescription, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, type Extension, Facet } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap } from '@codemirror/view'

import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, CODE_LINE_HEIGHT_SNAPPED, CODE_ROW_PAD, SUPPORTS_ROUNDED_LINE_HEIGHT } from './augmentations/code-highlight'
import { CODE_TOKEN_STYLES } from './augmentations/code-token-styles'

const tokenColours = HighlightStyle.define(CODE_TOKEN_STYLES)

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
 * Set in an editor over a text file that is not markdown. A Command that would write markdown (a
 * bullet, a task box) reads it and indents the text or does nothing instead.
 */
export const isTextFile = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/**
 * The extensions for a text file named `fileName`. The grammar is loaded after the editor is up:
 * most are a separate chunk, and a file with no grammar (a `.txt`, a `.csv`) is simply uncoloured.
 */
export function textFileExtensions(fileName: string): Extension {
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
    return [isTextFile.of(true), language.of([]), loader, syntaxHighlighting(tokenColours), textFileTheme, keymap.of([indentWithTab])]
}
