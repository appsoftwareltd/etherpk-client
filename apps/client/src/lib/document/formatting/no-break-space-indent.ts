/**
 * No-break spaces in indentation (ADR 0109). The editor measures a line's indentation with
 * `trimStart`, which counts every space character, so a bullet indented with no-break spaces (usually
 * pasted from a web page) is a bullet to its keys and its content clamp. The Indent Unit's outline
 * and CommonMark count only spaces and tabs, so to them the same line is a paragraph. The fix makes
 * each such character in a line's indentation a space, which keeps the line's length, so no fence
 * column moves and the editor's reading of the page is unchanged.
 *
 * "Such a character" is anything `\s` matches other than a space, a tab and U+FEFF: U+00A0, U+202F,
 * U+3000 and the rest of Unicode's spaces. U+FEFF is a byte order mark, not a space.
 */

import { type CheckedText, fixFinding, type FormattingCheck } from './finding'
import { isSpecialSpace } from './line-diff'

/**
 * Per line, how many leading characters are indentation rather than content: all of them outside
 * fenced code; inside a block (after its opener, closer included) only those up to the fence column,
 * because what lies past it is the code's own indentation.
 */
function indentationWidths(source: CheckedText): number[] {
    const widths = new Array<number>(source.lines.length).fill(Infinity)
    for (const block of source.fencedBlocks) {
        for (let i = block.start + 1; i <= block.end; i++) widths[i] = Math.min(widths[i], block.fenceColumn)
    }
    return widths
}

function reason(noBreak: boolean, other: boolean): string {
    if (noBreak && other) return 'no-break spaces and other space characters in indentation'
    return noBreak ? 'no-break spaces in indentation' : 'other space characters in indentation'
}

export const noBreakSpaceIndent: FormattingCheck = {
    id: 'no-break-space-indent',
    label: 'No-break spaces in indentation',
    help: "Some lines are indented with no-break spaces or other unusual space characters, usually from text pasted from a web page. The lines look indented, but the outline and published pages don't treat the characters as indentation.",
    find(source) {
        const widths = indentationWidths(source)
        let noBreak = false
        let other = false
        const fixed = source.lines.map((line, i) => {
            if (i < source.frontmatter) return line
            const indentation = /^\s*/.exec(line.text)![0].slice(0, widths[i])
            let written = ''
            for (const ch of indentation) {
                if (!isSpecialSpace(ch)) {
                    written += ch
                    continue
                }
                if (ch === '\u{a0}') noBreak = true
                else other = true
                written += ' '
            }
            return written === indentation ? line : { text: written + line.text.slice(indentation.length), ending: line.ending }
        })
        return fixFinding(source, fixed, () => reason(noBreak, other))
    },
}
