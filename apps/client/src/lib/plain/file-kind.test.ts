import { describe, expect, it } from 'vitest'

import { ICON_PATHS } from '../surface/icons'

import { fileIconOf, fileKindOf, isEditableKind } from './file-kind'

describe('what kind of file a path names', () => {
    it('reads the kind from the extension, whatever its case', () => {
        expect(fileKindOf('guide/watering.md')).toBe('markdown')
        expect(fileKindOf('NOTES.MARKDOWN')).toBe('markdown')
        expect(fileKindOf('images/bed.PNG')).toBe('image')
        expect(fileKindOf('clips/rain.mp4')).toBe('video')
        expect(fileKindOf('clips/rain.mp3')).toBe('audio')
        expect(fileKindOf('manuals/pump.pdf')).toBe('pdf')
        expect(fileKindOf('books/compost.epub')).toBe('ebook')
        expect(fileKindOf('backup.zip')).toBe('binary')
    })

    it('takes anything else for text, with or without an extension', () => {
        for (const path of ['sizes.csv', 'Makefile', '.gitignore', 'src/main.rs', 'notes.txt', 'config.yaml']) expect(fileKindOf(path)).toBe('text')
        expect(isEditableKind('markdown')).toBe(true)
        expect(isEditableKind('text')).toBe(true)
        expect(isEditableKind('pdf')).toBe(false)
    })

    it('draws every file with an icon the table holds', () => {
        for (const path of ['a.md', 'a.txt', 'a.png', 'a.pdf', 'a.epub', 'a.mp4', 'a.zip']) expect(ICON_PATHS[fileIconOf(path)]).toBeDefined()
    })
})
