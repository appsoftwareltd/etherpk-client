import { describe, expect, it } from 'vitest'

import { createPersonSettings } from '../person-settings/person-settings'
import { MARKDOWN_EDITOR_SETTING, createFileEditors, forgetFileEditors } from './file-editors'

function memoryStorage(): Storage {
    const held = new Map<string, string>()
    return {
        get length() {
            return held.size
        },
        clear: () => held.clear(),
        getItem: (key) => held.get(key) ?? null,
        key: (index) => [...held.keys()][index] ?? null,
        removeItem: (key) => void held.delete(key),
        setItem: (key, value) => void held.set(key, value),
    }
}

function setUp() {
    const storage = memoryStorage()
    const settings = createPersonSettings(() => storage)
    const open = (folderId = 'garden') => createFileEditors({ folderId, settings, storage })
    return { storage, settings, open }
}

describe('which editor a file of a Plain Folder opens in', () => {
    it('opens a markdown file in the Markdown Editor until something says otherwise, and any other text in the Text Editor', () => {
        const editors = setUp().open()
        expect(editors.editorOf('guide/watering.md')).toBe('markdown')
        expect(editors.editorOf('notes.markdown')).toBe('markdown')
        expect(editors.editorOf('water.yaml')).toBe('text')
        expect(editors.editorOf('Makefile')).toBe('text')
        expect(editors.defaultEditor()).toBe('markdown')
    })

    it('offers a choice for a markdown file only', () => {
        const editors = setUp().open()
        expect(editors.choices('README.md')).toEqual(['markdown', 'text'])
        expect(editors.choices('water.yaml')).toEqual(['text'])
    })

    it('remembers the editor chosen for one file on this device, and no other file takes it', () => {
        const { open } = setUp()
        const editors = open()
        editors.choose('README.md', 'text')
        expect(editors.editorOf('README.md')).toBe('text')
        expect(editors.editorOf('guide/watering.md')).toBe('markdown')
        // The next visit, and another folder's file of the same name.
        expect(open().editorOf('README.md')).toBe('text')
        expect(open('kitchen').editorOf('README.md')).toBe('markdown')
    })

    it('a file put back on the default follows the default again', () => {
        const editors = setUp().open()
        editors.choose('README.md', 'text')
        editors.choose('README.md', 'markdown')
        editors.setDefault('text')
        expect(editors.editorOf('README.md')).toBe('text')
    })

    it('the default is the person’s setting: it moves every file without an editor of its own', () => {
        const { open, settings } = setUp()
        const editors = open()
        editors.choose('kept.md', 'text')
        editors.setDefault('text')
        expect(settings.get(MARKDOWN_EDITOR_SETTING)).toBe('text')
        expect(editors.editorOf('README.md')).toBe('text')
        expect(open('kitchen').editorOf('other.md')).toBe('text')
        editors.setDefault('markdown')
        // The default is kept as nothing set, so a device that never chose has nothing to send.
        expect(settings.get(MARKDOWN_EDITOR_SETTING)).toBeUndefined()
        expect(editors.editorOf('README.md')).toBe('markdown')
        expect(editors.editorOf('kept.md')).toBe('text')
    })

    it('cannot be told to open a script in the Markdown Editor', () => {
        const { open, storage } = setUp()
        const editors = open()
        editors.choose('water.sh', 'markdown')
        expect(editors.editorOf('water.sh')).toBe('text')
        expect(storage.length).toBe(0)
    })

    it('a choice follows its file through a move, of the file or of a folder above it', () => {
        const editors = setUp().open()
        editors.choose('guide/watering.md', 'text')
        editors.moved('guide/watering.md', 'guide/hoses.md')
        expect(editors.editorOf('guide/watering.md')).toBe('markdown')
        expect(editors.editorOf('guide/hoses.md')).toBe('text')
        editors.moved('guide', 'handbook')
        expect(editors.editorOf('handbook/hoses.md')).toBe('text')
        // A name that only starts the same is not inside the folder.
        editors.choose('handbook-old.md', 'text')
        editors.moved('handbook', 'book')
        expect(editors.editorOf('handbook-old.md')).toBe('text')
    })

    it('a deleted file’s choice goes with it', () => {
        const editors = setUp().open()
        editors.choose('guide/watering.md', 'text')
        editors.removed('guide')
        expect(editors.editorOf('guide/watering.md')).toBe('markdown')
    })

    it('tells its listeners when an answer may have changed, and not when nothing did', () => {
        const { open, settings } = setUp()
        const editors = open()
        let heard = 0
        const off = editors.subscribe(() => heard++)
        editors.choose('README.md', 'text')
        expect(heard).toBe(1)
        editors.choose('README.md', 'text')
        expect(heard).toBe(1)
        // The person's setting changed elsewhere: in another tab, or on another device.
        settings.set(MARKDOWN_EDITOR_SETTING, 'text')
        expect(heard).toBe(2)
        off()
        editors.setDefault('markdown')
        expect(heard).toBe(2)
        editors.dispose()
    })

    it('takes a stored value it does not understand for nothing stored', () => {
        const { open, storage, settings } = setUp()
        storage.setItem('etherpk-plain-editors:garden', '{"README.md":"preview","notes.md":"text","x":3}')
        settings.set(MARKDOWN_EDITOR_SETTING, 'preview')
        const editors = open()
        expect(editors.editorOf('README.md')).toBe('markdown')
        expect(editors.editorOf('notes.md')).toBe('text')
        storage.setItem('etherpk-plain-editors:garden', 'not json')
        expect(open().editorOf('notes.md')).toBe('markdown')
    })

    it('keeps the choice for the visit where the browser refuses to store it', () => {
        const { settings, storage } = setUp()
        const refusing = { ...storage, getItem: () => null, setItem: () => { throw new Error('full') } } as Storage
        const editors = createFileEditors({ folderId: 'garden', settings, storage: refusing })
        editors.choose('README.md', 'text')
        expect(editors.editorOf('README.md')).toBe('text')
    })

    it('keeps what another tab chose meanwhile', () => {
        const { open } = setUp()
        const here = open()
        const there = open()
        there.choose('notes.md', 'text')
        here.choose('README.md', 'text')
        expect(open().editorOf('notes.md')).toBe('text')
        expect(open().editorOf('README.md')).toBe('text')
    })

    it('forgets a folder’s choices when the folder is forgotten', () => {
        const { open, storage } = setUp()
        open().choose('README.md', 'text')
        forgetFileEditors('garden', storage)
        expect(open().editorOf('README.md')).toBe('markdown')
    })
})
