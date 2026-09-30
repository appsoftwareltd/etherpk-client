/**
 * Unclosed code blocks (ADR 0109). A backtick fence the editor pairs with nothing (ADR 0020): an
 * opener with no closer, or a bare fence left behind when its partner was deleted. The editor shows
 * the lines after it as plain text, while CommonMark, and so a published page, reads them as code to
 * the end of their container. Where the block was meant to end cannot be known, so this check only
 * reports: it has no fix.
 */

import { fenceLineInfo } from '../fenced-code'
import type { FormattingCheck } from './finding'

export const unclosedFence: FormattingCheck = {
    id: 'unclosed-fence',
    label: 'Unclosed code blocks',
    help: 'The page has a ``` line with no matching fence. The editor shows the lines after it as plain text, and a published page shows them as code, so close or remove the fence by hand.',
    find(source) {
        const paired = new Uint8Array(source.lines.length)
        for (const block of source.fencedBlocks) paired.fill(1, block.start, block.end + 1)
        const lines: number[] = []
        const sentences: string[] = []
        for (let i = source.frontmatter; i < source.lines.length; i++) {
            if (paired[i]) continue
            const fence = fenceLineInfo(source.texts[i])
            if (!fence) continue
            lines.push(i)
            // A fence with a language, or on a bullet, can only open a block; a bare one might have been either.
            sentences.push(
                fence.info !== '' || fence.bullet ? `Line ${i + 1} opens a code block that is never closed.` : `Line ${i + 1} has a code fence with no matching fence.`,
            )
        }
        return lines.length === 0 ? null : { lines, fixed: null, reason: sentences.join(' ') }
    },
}
