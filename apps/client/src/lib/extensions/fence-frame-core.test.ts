import { describe, expect, it, vi } from 'vitest'

import { createEditingRegistry, deletedNotice, frameActions, frameKey, imageCopiedNotice, imageFailedNotice, keepsMenuFocus } from './fence-frame-core'

// The editor frame (`frame: 'editor'`): the toolbar and menu the Client draws round a fence that is a
// picture until it is edited in the document, such as a drawing.

describe('which fence is edited', () => {
    it('is one at a time: starting another stops the one before, which writes first', () => {
        const editing = createEditingRegistry()
        const order: string[] = []
        editing.start('Garden\nk1', () => {
            order.push('stop k1')
            editing.end('Garden\nk1')
        })
        editing.start('Kitchen\nk2', () => {})
        expect(order).toEqual(['stop k1'])
        expect(editing.isEditing('Garden\nk1')).toBe(false)
        expect(editing.isEditing('Kitchen\nk2')).toBe(true)
    })

    it('starts the next fence even when the one before throws as it stops', () => {
        const editing = createEditingRegistry()
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        editing.start('a', () => {
            throw new Error('no')
        })
        editing.start('b', () => {})
        expect(editing.isEditing('b')).toBe(true)
        error.mockRestore()
    })

    it('ends only the fence edited now, and tells every listener', () => {
        const editing = createEditingRegistry()
        const heard = vi.fn()
        editing.subscribe(heard)
        editing.start('a', () => {})
        editing.end('b')
        expect(editing.isEditing('a')).toBe(true)
        editing.end('a')
        expect(editing.isEditing('a')).toBe(false)
        expect(heard).toHaveBeenCalledTimes(2)
    })

    it('keys a fence by its document and its own id, and a fence with no id by nothing', () => {
        expect(frameKey('Garden', 'k1')).not.toBe(frameKey('Kitchen', 'k1'))
        expect(frameKey('Garden', null)).toBeNull()
        expect(frameKey('Garden', '')).toBeNull()
    })
})

describe('which actions the frame shows', () => {
    const inline = { presentation: 'inline' as const, writable: true, identified: true, image: false, copies: false }

    it('offers Edit as text and Delete in a menu over the picture', () => {
        expect(frameActions({ ...inline, editing: false })).toEqual({ toolbar: [], apart: [], menu: ['edit-as-text', 'delete'] })
    })

    it('offers Done, Full window and Open in tab while editing, with Edit as text and Delete apart', () => {
        expect(frameActions({ ...inline, editing: true })).toEqual({ toolbar: ['done', 'full-window', 'open-tab'], apart: ['edit-as-text', 'delete'], menu: [] })
    })

    it('offers neither a tab nor the window for a fence with no id', () => {
        expect(frameActions({ ...inline, identified: false, editing: true }).toolbar).toEqual(['done'])
    })

    it('shows nothing where the document cannot be written, nor in a tab or a window', () => {
        const nothing = { toolbar: [], apart: [], menu: [] }
        expect(frameActions({ ...inline, writable: false, editing: false })).toEqual(nothing)
        expect(frameActions({ ...inline, presentation: 'tab', editing: false })).toEqual(nothing)
        expect(frameActions({ ...inline, presentation: 'window', editing: true })).toEqual(nothing)
    })

    describe('for a fence that can be drawn as an image', () => {
        const drawn = { ...inline, image: true, copies: true }

        it('offers Copy as image and Save as image first in the menu over the picture', () => {
            expect(frameActions({ ...drawn, editing: false }).menu).toEqual(['copy-image', 'save-image', 'edit-as-text', 'delete'])
        })

        it('offers only those two where the document cannot be written', () => {
            expect(frameActions({ ...drawn, writable: false, editing: false })).toEqual({ toolbar: [], apart: [], menu: ['copy-image', 'save-image'] })
        })

        it('leaves out Copy as image where the browser cannot put an image on the clipboard', () => {
            expect(frameActions({ ...drawn, copies: false, editing: false }).menu).toEqual(['save-image', 'edit-as-text', 'delete'])
            expect(frameActions({ ...drawn, copies: false, writable: false, editing: false }).menu).toEqual(['save-image'])
        })

        it('adds neither to the toolbar while editing, where the widget has its own', () => {
            expect(frameActions({ ...drawn, editing: true })).toEqual({ toolbar: ['done', 'full-window', 'open-tab'], apart: ['edit-as-text', 'delete'], menu: [] })
        })

        it('offers nothing in a tab or a window', () => {
            expect(frameActions({ ...drawn, presentation: 'tab', editing: false }).menu).toEqual([])
            expect(frameActions({ ...drawn, presentation: 'window', writable: false, editing: false }).menu).toEqual([])
        })
    })
})

describe('after a menu item', () => {
    it('keeps the keyboard on the menu button where the fence stays as it was', () => {
        expect(keepsMenuFocus('copy-image')).toBe(true)
        expect(keepsMenuFocus('save-image')).toBe(true)
        expect(keepsMenuFocus('edit-as-text')).toBe(false)
        expect(keepsMenuFocus('delete')).toBe(false)
    })
})

describe('a fence as an image', () => {
    it('says it was copied, since the clipboard cannot be seen', () => {
        expect(imageCopiedNotice('Drawing')).toBe('Drawing copied as an image.')
        expect(imageCopiedNotice(undefined)).toBe('Block copied as an image.')
    })

    it('says what could not be done and why', () => {
        expect(imageFailedNotice('Drawing', 'save', "There's nothing in it yet.")).toBe("The drawing couldn't be saved as an image. There's nothing in it yet.")
        expect(imageFailedNotice('Drawing', 'copy', "It couldn't be drawn.")).toBe("The drawing couldn't be copied as an image. It couldn't be drawn.")
        expect(imageFailedNotice(undefined, 'save', "It couldn't be drawn.")).toBe("The block couldn't be saved as an image. It couldn't be drawn.")
    })
})

describe('after Delete', () => {
    it('says what went and how to bring it back', () => {
        expect(deletedNotice('Drawing')).toBe('Drawing deleted. Press Ctrl+Z (Cmd+Z on a Mac) in the document to bring it back.')
    })
})
