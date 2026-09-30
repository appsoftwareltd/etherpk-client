/**
 * Windows line endings (ADR 0109). Flags a document holding a carriage return, from a file saved on
 * Windows, a git checkout, or an import of either. The fix writes every line ending as `\n`,
 * frontmatter included: line endings belong to the file, and the frontmatter delimiters read the
 * same either way. An editor's buffer already holds line feeds only (ADR 0112); this repairs the
 * files nobody has opened.
 */

import { fixFinding, type FormattingCheck } from './finding'

function reason(windows: boolean, oldMac: boolean): string {
    if (windows && oldMac) return 'Windows and old Mac line endings'
    return windows ? 'Windows line endings' : 'old Mac line endings'
}

export const lineEndings: FormattingCheck = {
    id: 'line-endings',
    label: 'Windows line endings',
    help: "The page's lines end in a carriage return, which usually means the file was saved on Windows.",
    find(source) {
        if (!source.text.includes('\r')) return null
        const windows = source.lines.some((line) => line.ending === '\r\n')
        const oldMac = source.lines.some((line) => line.ending === '\r')
        const fixed = source.lines.map((line) => (line.ending.startsWith('\r') ? { text: line.text, ending: '\n' as const } : line))
        return fixFinding(source, fixed, () => reason(windows, oldMac))
    },
}
