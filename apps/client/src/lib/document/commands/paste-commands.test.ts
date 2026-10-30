import { EditorState, type Extension } from '@codemirror/state'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '../../surface'
import { resetBookmarks } from '../bookmarks/bookmarks'
import { BookmarkSync, bookmarksAugmentation } from '../view/augmentations/bookmarks'
import { isProtectedDocumentFacet } from '../view/augmentations/protected-document'
import { editorDocument } from '../view/editor-document'
import { pasteInto, registerPasteCommands } from './paste-commands'

/** Editors open over Garden for a test, each as the line menu finds one. */
const open: BookmarkSync[] = []

function editorOverGarden(panelId: string, extensions: Extension[] = []): void {
    const state = EditorState.create({ doc: '- water the beans', extensions: [editorDocument.of({ concept: 'Garden', panelId }), bookmarksAugmentation(), ...extensions] })
    open.push(new BookmarkSync({ state, dispatch: () => {}, focus: () => {} } as never))
}

function pasteLabels(target: object): string[] {
    const contributions = createContributionRegistry()
    registerPasteCommands(createCommandRegistry(), contributions)
    return listContextMenuItems(contributions, target as never).map((i) => i.label)
}

afterEach(() => {
    for (const sync of open.splice(0)) sync.destroy()
    resetBookmarks()
    vi.unstubAllGlobals()
})

describe('Paste on the line menu', () => {
    it('is offered only where a paste can land: not for a line no editor is showing', () => {
        expect(pasteLabels({ kind: 'line', concept: 'Garden', line: 1 })).toEqual([])
        expect(pasteLabels({ kind: 'wikilink', concept: 'Garden' })).toEqual([])
    })

    it('is offered on a line of an editor that takes text', () => {
        editorOverGarden('left')
        expect(pasteLabels({ kind: 'line', concept: 'Garden', panelId: 'left', line: 1 })).toEqual(['Paste'])
    })

    it('is not offered in a read-only editor, nor on a locked Protected Document', () => {
        editorOverGarden('read-only', [EditorState.readOnly.of(true)])
        editorOverGarden('locked', [isProtectedDocumentFacet.of(() => true)])
        expect(pasteLabels({ kind: 'line', concept: 'Garden', panelId: 'read-only', line: 1 })).toEqual([])
        expect(pasteLabels({ kind: 'line', concept: 'Garden', panelId: 'locked', line: 1 })).toEqual([])
    })
})

/** Just enough of a DataTransfer for a paste of text. */
class FakeDataTransfer {
    readonly #data = new Map<string, string>()
    readonly items = { add: () => {} }
    setData(type: string, value: string): void {
        this.#data.set(type, value)
    }
    getData(type: string): string {
        return this.#data.get(type) ?? ''
    }
}

/** Firefox's ClipboardEvent: it ignores the `clipboardData` it is given and carries none. */
class FirefoxClipboardEvent extends Event {
    readonly clipboardData: FakeDataTransfer | null = null
}

describe('Paste from the line menu', () => {
    it('hands the editor the clipboard text where the browser drops the data given to a paste event (Firefox)', async () => {
        vi.stubGlobal('DataTransfer', FakeDataTransfer)
        vi.stubGlobal('ClipboardEvent', FirefoxClipboardEvent)
        vi.stubGlobal('navigator', { clipboard: { readText: async () => ' today' } })
        const pasted: string[] = []
        const contentDOM = new EventTarget()
        contentDOM.addEventListener('paste', (event) => {
            pasted.push((event as unknown as { clipboardData: FakeDataTransfer | null }).clipboardData?.getData('text/plain') ?? '(none)')
        })

        await pasteInto({ focus: () => {}, contentDOM } as never)

        expect(pasted).toEqual([' today'])
    })
})
