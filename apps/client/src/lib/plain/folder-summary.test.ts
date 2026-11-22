import { describe, expect, it } from 'vitest'

import type { FolderProbe } from './classify-folder'
import { folderFound, folderSentence } from './folder-summary'

const probe = (over: Partial<FolderProbe>): FolderProbe => ({
    empty: false,
    hasEtherpkDir: false,
    hasJournalsAndPages: false,
    hasManagedAgentsSection: false,
    format: 'markdown',
    counts: { markdown: 0, images: 0, pdfs: 0, ebooks: 0, other: 0 },
    skipped: [],
    truncated: false,
    ...over,
})

describe('what the folder-choice dialog says a folder holds', () => {
    it('counts what was found, singular and plural, leaving out what there is none of', () => {
        expect(folderFound(probe({ counts: { markdown: 18, images: 6, pdfs: 1, ebooks: 1, other: 0 }, skipped: ['.git', 'node_modules'] }))).toBe(
            'Found 18 markdown files, 6 images, 1 PDF and 1 EBook. Skipped .git and node_modules.',
        )
        expect(folderFound(probe({ counts: { markdown: 1, images: 0, pdfs: 0, ebooks: 0, other: 2 } }))).toBe('Found 1 markdown file and 2 other files.')
        expect(folderFound(probe({ counts: { markdown: 0, images: 0, pdfs: 0, ebooks: 0, other: 0 }, skipped: ['.git'] }))).toBe('Found no files to open. Skipped .git.')
    })

    it('says the count is a floor when the look stopped at its limit', () => {
        expect(folderFound(probe({ counts: { markdown: 4000, images: 0, pdfs: 0, ebooks: 0, other: 0 }, truncated: true }))).toBe('Found at least 4000 markdown files.')
    })

    it('names what the folder is', () => {
        expect(folderSentence(probe({ empty: true }))).toBe('This folder is empty. Choose what to open it as.')
        expect(folderFound(probe({ empty: true }))).toBe('')
        expect(folderSentence(probe({ format: 'obsidian' }))).toBe('This folder looks like Obsidian notes, and is not an EtherPK graph.')
        expect(folderSentence(probe({ format: 'etherpk' }))).toContain('laid out like an EtherPK graph')
        expect(folderSentence(probe({}))).toBe('This folder is not an EtherPK graph.')
    })
})
