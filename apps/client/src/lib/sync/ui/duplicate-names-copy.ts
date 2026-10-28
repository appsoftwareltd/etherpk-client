/**
 * What the [[Duplicate Name]] review says (ADR 0157): the dialog at graph open and the Maintenance
 * section. Plain functions, so the wording and the rule for when the dialog shows are tested
 * without a component.
 */
import type { MergeDuplicatesOutcome } from '$lib/storage/server/server-document-store'

/**
 * Whether the dialog at graph open offers the review. Only once the registry has been confirmed
 * against the relay (offline, a partial cached registry could show a pair that is not one, or
 * miss one), never over another dialog such as an unlock, and not again after Not now.
 */
export function offersDuplicateReview(state: {
    registryConfirmed: boolean
    names: number
    dismissed: boolean
    otherDialogOpen: boolean
}): boolean {
    return state.registryConfirmed && state.names > 0 && !state.dismissed && !state.otherDialogOpen
}

/** The dialog's message. */
export function duplicateNoticeMessage(names: number): string {
    if (names === 1) {
        return '1 name in this graph belongs to more than one document. The name opens only one of them, so the text in the others is hidden.'
    }
    return `${names} names in this graph belong to more than one document. Each name opens only one of them, so the text in the others is hidden.`
}

/** "48 and 20", "40, 12 and 1". */
function listOf(counts: readonly number[]): string {
    if (counts.length <= 1) return String(counts[0] ?? 0)
    return `${counts.slice(0, -1).join(', ')} and ${counts.at(-1)}`
}

/** The inline confirmation before a Merge: what is merged, how big each is, and what is deleted. */
export function mergeConfirmation(concept: string, lines: readonly number[]): string {
    const others = lines.length > 2 ? 'others' : 'second'
    const are = lines.length > 2 ? 'are' : 'is'
    return `Merge ${lines.length} documents named ${concept} (${listOf(lines)} lines)? The text of the ${others} is added to the first, then the ${others} ${are} deleted.`
}

/** What the section says after a Merge that did not finish; null after one that did. */
export function mergeOutcomeMessage(outcome: MergeDuplicatesOutcome): string | null {
    switch (outcome) {
        case 'merged':
            return null
        case 'gone':
            return 'These documents were renamed or deleted after they were shown. The list now shows them as they are.'
        case 'offline':
            return 'You are offline. A merge deletes a document only after the server has its text, so connect and merge again.'
        case 'unconfirmed':
            return 'A document could not be loaded from the server. Check your connection, then merge again.'
        case 'protected':
            return 'One of these pages is protected. Remove its protection, then merge.'
        case 'changed':
            return 'A document changed after it was shown. Check the texts again, then merge.'
        case 'not-acknowledged':
            return 'The text was added to the first document, but the server has not confirmed it yet. Nothing was deleted. Merge again when you are online.'
        case 'changed-after-append':
            return 'The text was added to the first document. Another document changed at the same time, so it was kept. Check it, then merge again.'
    }
}
