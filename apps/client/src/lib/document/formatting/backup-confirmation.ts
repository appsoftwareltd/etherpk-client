/**
 * The phrase a person types before a [[Formatting Scan]] can start (ADR 0109). Fixes rewrite
 * pages and cannot be undone from Settings, so the scan waits until the person says, in their
 * own words, that they have exported the graph and checked the export.
 */

export const BACKUP_CONFIRMATION_PHRASE = 'Export completed and checked'

/**
 * Single quotes, straight or curly. The copy shows the phrase in single quotes, so a person may
 * type them as well, and a phone or a Mac can turn a typed ' into a curly one.
 */
const SINGLE_QUOTES = /['\u{2018}\u{2019}]/gu

/** Single quotes dropped, letters compared without case, and any run of spaces read as one, so only the words count. */
function normalise(text: string): string {
    return text.replace(SINGLE_QUOTES, '').trim().replace(/\s+/g, ' ').toLowerCase()
}

const EXPECTED = normalise(BACKUP_CONFIRMATION_PHRASE)

/** Whether `typed` is the confirmation phrase, in any case, with any spacing between words and with or without single quotes. */
export function isBackupConfirmation(typed: string): boolean {
    return normalise(typed) === EXPECTED
}
