/**
 * The name a saved copy of a PDF is offered under. It says what is different about the copy, which
 * a version number could not, and storage needs nothing from it: a stored name holds a hash or id.
 * A new description replaces an earlier one, so a copy of a copy never reads `(annotated) (signed)`.
 */
export type CopyDescription = 'signed' | 'annotated' | 'no password' | 'password changed' | 'copy'

const EARLIER = /\s*\((?:signed|annotated|flattened|no password|password changed|copy)\)$/i
const KEBAB_EARLIER = /-(?:signed|annotated|flattened|no-password|password-changed|copy)$/i

export interface CopyContents {
    signed: boolean
    annotated: boolean
    password: 'keep' | 'remove' | 'change'
}

/** What a copy with these contents is: a signature matters most, then what the password did. */
export function describeCopy({ signed, annotated, password }: CopyContents): CopyDescription {
    if (signed) return 'signed'
    if (password === 'remove') return 'no password'
    if (password === 'change') return 'password changed'
    return annotated ? 'annotated' : 'copy'
}

/** `garden-guide.pdf` to `garden-guide (signed).pdf`. */
export function copyFileName(fileName: string, description: CopyDescription): string {
    const dot = fileName.toLowerCase().endsWith('.pdf') ? fileName.length - 4 : fileName.length
    const stem = fileName.slice(0, dot).replace(EARLIER, '').replace(KEBAB_EARLIER, '') || 'document'
    return `${stem} (${description}).pdf`
}

/** A name a person typed, made safe as a file name, always ending `.pdf`; `null` when nothing is left. */
export function cleanCopyName(typed: string): string | null {
    // eslint-disable-next-line no-control-regex -- control characters are what is being removed
    const stem = typed.trim().replace(/\.pdf$/i, '').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim()
    return stem === '' ? null : `${stem}.pdf`
}
