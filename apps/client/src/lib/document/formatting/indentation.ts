/**
 * Indentation off the two-space grid (ADR 0109, ADR 0067). Flags every document the import
 * boundary's normaliser would change, and fixes it with that normaliser, so a fixed page is exactly
 * what a fresh import of the same text writes. It finds tab-indented pages from imports made before
 * the normaliser existed, four-space vault pages, over-nested bullets, which CommonMark reads as
 * lazy continuations of their parent's paragraph, and bullets indented under a heading with no
 * bullet above them.
 *
 * `normaliseIndentUnit` rewrites only each line's leading spaces and tabs, never adds or removes a
 * line, and leaves frontmatter alone. It is given the lines joined by `\n`, and each line keeps its
 * own ending.
 */

import { movesHeadingSection, normaliseIndentUnit } from '../indent-unit'
import { type CheckedText, fixFinding, type FormattingCheck } from './finding'

/** A line whose leading whitespace holds a tab. */
const TAB_IN_INDENTATION = /^[ \t]*\t/

/** Why the page was flagged: tabs first, then a heading's indented section, then any other grid. */
function reason(source: CheckedText, changed: readonly number[]): string {
    if (changed.some((i) => TAB_IN_INDENTATION.test(source.texts[i]))) return 'tabs in indentation'
    // The normaliser's own first step, so the reason names what the fix does.
    if (movesHeadingSection(source.texts.join('\n'))) return 'bullets indented under a heading, with no bullet above them'
    return 'off the two-space grid'
}

export const indentation: FormattingCheck = {
    id: 'indentation',
    label: 'Indentation off the two-space grid',
    help: 'The page is indented with tabs or by uneven amounts, often from an older import or another editor, or bullets under a heading are indented with no bullet above them. The editor draws bullets and code blocks indented with tabs in the wrong place, and a bullet indented too far publishes wrongly.',
    find(source) {
        const joined = source.texts.join('\n')
        const normalised = normaliseIndentUnit(joined)
        if (normalised === joined) return null
        const texts = normalised.split('\n')
        const fixed = source.lines.map((line, i) => (texts[i] === line.text ? line : { text: texts[i], ending: line.ending }))
        return fixFinding(source, fixed, (changed) => reason(source, changed))
    },
}
