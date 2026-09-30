/**
 * The order an editor sends its own changes to the store and applies the text the store tells it.
 *
 * A transaction with several changes goes to the store one change at a time, and the store tells the
 * document's other editors after each one (ADR 0113). Nothing should write back before the last
 * change is sent, and a held reveal's tidy once did. Its text then reached this editor mid-send and
 * rewound the changes not yet sent, and those went on to the store while this editor never showed
 * them. So text heard while sending waits, and once the last change is out this editor takes the
 * store's text as it is then: the text it heard predates the changes it sent after hearing it.
 */

import type { TextChange } from '../types'

export interface SendAndHear {
    /** Send one transaction's changes, in order. Text heard meanwhile is applied once the last is sent. */
    send(changes: Iterable<TextChange>, onChange: (change: TextChange) => void): void
    /** Text the store tells this editor: applied now, or after the send in progress. */
    hear(text: string): void
}

/**
 * `apply` puts text in the editor without sending it back; `currentText` reads the store's text now,
 * for the editor that heard something while it was sending.
 */
export function createSendAndHear(apply: (text: string) => void, currentText: () => string): SendAndHear {
    let sending = false
    let heardWhileSending = false
    return {
        send(changes, onChange) {
            sending = true
            try {
                for (const change of changes) onChange(change)
            } finally {
                sending = false
            }
            if (heardWhileSending) {
                heardWhileSending = false
                apply(currentText())
            }
        },
        hear(text) {
            if (sending) heardWhileSending = true
            else apply(text)
        },
    }
}
