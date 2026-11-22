/**
 * An editor over a file that must not be edited (ADR 0196): one that is not UTF-8 text, is too
 * large, or belongs to a graph kept inside a [[Plain Folder]].
 *
 * `EditorState.readOnly` alone stops typing, and nothing else: the outliner's keys, a checkbox and
 * a paste handler each dispatch a change of their own. The store would drop such a change, leaving
 * the editor showing text the file does not hold. So every change is refused here, at the
 * transaction, except the store's own (`EXTERNAL`), which is how the file's text reaches the
 * editor when another program changes it.
 */
import { EditorState, type Extension } from '@codemirror/state'

import { EXTERNAL } from './cm-document'

export function readOnlyFile(): Extension {
    return [EditorState.readOnly.of(true), EditorState.changeFilter.of((tr) => !tr.docChanged || tr.annotation(EXTERNAL) === true)]
}
