/**
 * The phrase a person types before a Formatting Scan can start, to say they have exported the
 * graph and checked the export first (ADR 0109).
 */

import { describe, expect, it } from 'vitest'

import { BACKUP_CONFIRMATION_PHRASE, isBackupConfirmation } from './backup-confirmation'

describe('isBackupConfirmation', () => {
    it.each([
        ['the phrase as shown', 'Export completed and checked'],
        ['lower case', 'export completed and checked'],
        ['any mix of case', 'EXPORT Completed AND checked'],
        ['spaces around it', '  Export completed and checked '],
        ['more than one space between words', 'Export  completed and   checked'],
        // The copy shows the phrase in single quotes, so a person may type them too.
        ['the phrase in single quotes, as the copy shows it', "'Export completed and checked'"],
        ['the curly single quotes a phone or a Mac puts in for a typed one', '\u{2018}Export completed and checked\u{2019}'],
        ['one single quote left over', "Export completed and checked'"],
    ])('accepts %s', (_name, typed) => {
        expect(isBackupConfirmation(typed)).toBe(true)
    })

    it.each([
        ['nothing', ''],
        ['single quotes alone', "''"],
        ['part of the phrase', 'Export completed'],
        ['more than the phrase', 'Export completed and checked twice'],
        ['the phrase in double quotes', '"Export completed and checked"'],
        ['a different phrase', 'Export complete and checked'],
    ])('refuses %s', (_name, typed) => {
        expect(isBackupConfirmation(typed)).toBe(false)
    })

    it('accepts the phrase it shows', () => {
        expect(isBackupConfirmation(BACKUP_CONFIRMATION_PHRASE)).toBe(true)
    })
})
