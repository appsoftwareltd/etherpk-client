/**
 * Line endings (ADR 0112). EtherPK writes `\n`, and an editor's buffer holds `\n` only.
 * CodeMirror splits a document on `\r\n`, `\r` or `\n` and joins it with `\n`, so a buffer that
 * kept a `\r` disagreed with the editor's offsets by one character for every line ending above
 * an edit, and the edit was written that far before where it was typed.
 */

import type { TextChange } from './types'

/** `text` with every `\r\n` and every lone `\r` written as `\n`; `text` itself when it holds no `\r`. */
export function lineFeedsOnly(text: string): string {
    return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * The changes that turn `text` into {@link lineFeedsOnly}`(text)`, in document order and each
 * against `text` as it is: one per `\r`, deleting it before a `\n` and replacing it with `\n`
 * anywhere else. For a writer that must change a shared text in place rather than replace it,
 * applying them from the last to the first.
 */
export function lineFeedChanges(text: string): TextChange[] {
    const changes: TextChange[] = []
    for (let at = text.indexOf('\r'); at !== -1; at = text.indexOf('\r', at + 1)) {
        changes.push({ from: at, to: at + 1, insert: text[at + 1] === '\n' ? '' : '\n' })
    }
    return changes
}
