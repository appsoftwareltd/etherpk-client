import { afterEach, describe, expect, it, vi } from 'vitest'

import { editorContext } from './editor-context.svelte'
import { activeFile, fileTypeOf, noteFileInFront, registerFileSelection } from './file-in-front'

// The context is reactive state, which this tier does not compile: the plain record stands in for it.
vi.mock('./editor-context.svelte', () => ({ editorContext: { fileInFront: null } }))

describe('the file in front', () => {
    afterEach(() => noteFileInFront(null))

    it('reads a type from the tab target', () => {
        expect(fileTypeOf('garden-guide.a1b2c3d4.pdf')).toBe('pdf')
        expect(fileTypeOf('0d9c1f5e-7c3a-4f00-9b8e-2e3a4b5c6d7e.PDF')).toBe('pdf')
        expect(fileTypeOf('notes')).toBe('')
    })

    it('is nothing while a document or no tab is in front', () => {
        noteFileInFront(null)
        expect(activeFile()).toBeNull()
        expect(editorContext.fileInFront).toBeNull()
    })

    it('answers for a file nothing can read a selection from', () => {
        noteFileInFront('chart.a1b2c3d4.png')
        expect(editorContext.fileInFront).toBe('png')
        expect(activeFile()).toMatchObject({ type: 'png', selectedText: '' })
    })

    it('asks the viewer of the file in front, at that moment', () => {
        const restoreSelection = vi.fn()
        let selectedText = 'beans'
        const stop = registerFileSelection('garden-guide.pdf', () => ({ selectedText, restoreSelection }))
        noteFileInFront('garden-guide.pdf')
        expect(activeFile()?.selectedText).toBe('beans')
        selectedText = 'peas'
        expect(activeFile()?.selectedText).toBe('peas')
        activeFile()?.restoreSelection()
        expect(restoreSelection).toHaveBeenCalled()
        stop()
        expect(activeFile()?.selectedText).toBe('')
    })

    it('does not ask the viewer of a file behind another', () => {
        const stop = registerFileSelection('garden-guide.pdf', () => ({ selectedText: 'beans', restoreSelection() {} }))
        noteFileInFront('seed-plan.pdf')
        expect(activeFile()?.selectedText).toBe('')
        stop()
    })
})
