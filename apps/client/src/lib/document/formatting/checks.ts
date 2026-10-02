/**
 * The registry of [[Formatting Check]]s (ADR 0109), in the order a page's issues are shown and
 * approved. The order follows what the fixes do to each other: fixing no-break spaces and `*` or `+`
 * markers can make new bullets, which the indentation check then puts on the grid, and indenting a
 * line can move it under or out from a bullet, which decides where a list needs a blank line after
 * it. The line-endings fix touches nothing the others read, and the check that only reports comes
 * last.
 *
 * Core only: not an extension Contribution Point, and not a Headless Client tool, until something
 * needs one.
 */

import { blankLineAfterList } from './blank-line-after-list'
import { bulletMarker } from './bullet-marker'
import { checkedText, type FormattingCheck, type FormattingCheckId, type FormattingFinding } from './finding'
import { indentation } from './indentation'
import { lineEndings } from './line-endings'
import { noBreakSpaceIndent } from './no-break-space-indent'
import { unclosedFence } from './unclosed-fence'

export type { FormattingCheck, FormattingCheckId, FormattingFinding } from './finding'

export const FORMATTING_CHECKS: readonly FormattingCheck[] = [noBreakSpaceIndent, bulletMarker, indentation, blankLineAfterList, lineEndings, unclosedFence]

const BY_ID = new Map(FORMATTING_CHECKS.map((check) => [check.id, check]))

export function formattingCheck(id: FormattingCheckId): FormattingCheck {
    return BY_ID.get(id)!
}

/** One check's finding on a text. */
export interface CheckFinding {
    check: FormattingCheckId
    finding: FormattingFinding
}

/** Every check's finding on a document's whole text, in registry order. */
export function findIssues(text: string): CheckFinding[] {
    const source = checkedText(text)
    const found: CheckFinding[] = []
    for (const check of FORMATTING_CHECKS) {
        const finding = check.find(source)
        if (finding) found.push({ check: check.id, finding })
    }
    return found
}
