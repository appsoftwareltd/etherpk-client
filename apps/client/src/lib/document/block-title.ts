/**
 * What a [[Block View]]'s tab is called after `Block: `: its Block's first line as it reads on
 * screen, not as it is written. The marker, a [[Task]]'s checkbox and its [[Task Tag]]s go, a
 * [[Wikilink]] reads as the name it links (nested ones too: `[[[[Garden]] Beds]]` is `Garden
 * Beds`), a link as its text, an image as its [[Asset]]'s file name without the id the graph adds,
 * and emphasis, highlight, strike and code markers are dropped. Cut to {@link BLOCK_TITLE_LIMIT}
 * characters, an ellipsis included, as the tab's hover shows the whole.
 *
 * Framework-free, so it runs in Node.
 */
import { assetNameAsNamed } from '../storage/fs/asset-store'
import { bulletContent, taskDone } from './outliner'
import { parseTaskTags } from './task-tags'

/** The most characters a title's text has, its ellipsis counted. */
export const BLOCK_TITLE_LIMIT = 80

/** A placeholder no line of text holds, standing in for an image's name while markers are dropped. */
const HELD = '\u0000'

/** The file name an image's address ends with, read as a person would name it. */
function imageName(address: string): string {
    const file = address.split(/[?#]/)[0].split('/').pop() ?? address
    let decoded = file
    try {
        decoded = decodeURIComponent(file)
    } catch {
        // Not an escaped name: shown as written.
    }
    return assetNameAsNamed(decoded)
}

/** A bullet line's words as they read, uncut. */
export function blockReadText(line: string): string {
    let text = bulletContent(line)
    if (taskDone(line) !== undefined) text = parseTaskTags(text).text
    // Images first, held aside so a file name's own underscores are not read as emphasis.
    const held: string[] = []
    text = text.replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (_match, address: string) => {
        held.push(imageName(address))
        return `${HELD}${held.length - 1}${HELD}`
    })
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Innermost wikilinks first, until none is left: `[[[[Garden]] Beds]]` takes two passes.
    for (let before = ''; before !== text; ) {
        before = text
        text = text.replace(/\[\[([^[\]]*)\]\]/g, '$1')
    }
    text = text
        .replace(/\*\*|__|~~|==|`/g, '')
        // A single `*` or `_` is emphasis only where it opens or closes a word.
        .replace(/(^|[\s(])[*_]+(?=\S)/g, '$1')
        .replace(/(?<=\S)[*_]+(?=$|[\s).,:;!?])/g, '')
    text = text.replace(new RegExp(`${HELD}(\\d+)${HELD}`, 'g'), (_match, index: string) => held[Number(index)] ?? '')
    return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** A bullet line's words as a [[Block View]]'s title shows them: read, then cut to the limit. */
export function blockTitleText(line: string): string {
    const text = blockReadText(line)
    return text.length > BLOCK_TITLE_LIMIT ? `${text.slice(0, BLOCK_TITLE_LIMIT - 1)}…` : text
}
