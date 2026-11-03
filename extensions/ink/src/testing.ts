/**
 * Helpers the Node tests share: fence edits applied to a body as the Client applies them, each
 * against the body the ones before it left. Never imported by the extension itself.
 */
import type { FenceEdit } from '@appsoftwareltd/etherpk-extension-api'

/** The body after the edits, or null when any no longer applies (then none is made). */
export function applyEdits(body: readonly string[], edits: readonly FenceEdit[]): string[] | null {
    let next = [...body]
    for (const edit of edits) {
        if (edit.kind === 'insert') {
            if (edit.line < 0 || edit.line > next.length) return null
            next.splice(edit.line, 0, edit.text)
            continue
        }
        if (next[edit.line] !== edit.expect) return null
        if (edit.kind === 'replace') next[edit.line] = edit.text
        else next = next.filter((_, i) => i !== edit.line)
    }
    return next
}
