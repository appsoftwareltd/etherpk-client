import { markdown } from '@codemirror/lang-markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'

import { clearActiveEditorView, setActiveEditorView } from '../active-editor'
import { LINK_COPY_PATH } from '../link-affordances'
import { editorMarkdownExtensions } from '../view/augmentations/scheme-url-autolink'
import { editorFixture as bareFixture } from '../view/testing/editor-state-fixture'
import { registerLinkCommands } from './link-commands'

/** The fixture with the editor's markdown language loaded: the caret fallback reads the syntax tree. */
const editorFixture = (text: string) => bareFixture(text, { extensions: [markdown({ extensions: editorMarkdownExtensions, addKeymap: false })] })

function setup(deps: { onError?: (text: string) => void } = {}) {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const detach = registerLinkCommands(commands, contributions, deps)
    return { commands, contributions, detach }
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
    vi.stubGlobal('navigator', { clipboard: { writeText } })
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('link.copyPath', () => {
    it('writes the native path it is handed and reports success', async () => {
        const writeText = vi.fn(async () => {})
        stubClipboard(writeText)
        const { commands } = setup()
        expect(await commands.execute(LINK_COPY_PATH, { kind: 'file-link', path: '/home/g/My Doc.pdf' })).toBe(true)
        expect(writeText).toHaveBeenCalledWith('/home/g/My Doc.pdf')
    })

    it('reports a failed write and returns false, so no tick shows', async () => {
        stubClipboard(async () => {
            throw new Error('Write permission denied.')
        })
        const onError = vi.fn()
        const { commands } = setup({ onError })
        expect(await commands.execute(LINK_COPY_PATH, { kind: 'file-link', path: '/x' })).toBe(false)
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Write permission denied.'))
        expect(onError.mock.calls[0][0]).toContain('/x')
    })

    it('says why when the origin has no clipboard at all', async () => {
        vi.stubGlobal('navigator', {})
        const onError = vi.fn()
        const { commands } = setup({ onError })
        expect(await commands.execute(LINK_COPY_PATH, { kind: 'file-link', path: '/x' })).toBe(false)
        expect(onError.mock.calls[0][0]).toContain('https or localhost')
    })

    it('with no target, copies the file link the active editor caret means', async () => {
        const writeText = vi.fn(async () => {})
        stubClipboard(writeText)
        const { commands } = setup()
        const editor = editorFixture('- see file:///home/g/x.pdf| now')
        // The fixture is state-only; the Command reads only `.state` off the view it is given.
        setActiveEditorView(editor as never)
        try {
            expect(await commands.execute(LINK_COPY_PATH)).toBe(true)
            expect(writeText).toHaveBeenCalledWith('/home/g/x.pdf')
        } finally {
            clearActiveEditorView(editor as never)
        }
    })

    it('with no target and no file link on the caret line, does nothing', async () => {
        const writeText = vi.fn(async () => {})
        stubClipboard(writeText)
        const { commands } = setup()
        const editor = editorFixture('- plain| text')
        setActiveEditorView(editor as never)
        try {
            expect(await commands.execute(LINK_COPY_PATH)).toBe(false)
            expect(writeText).not.toHaveBeenCalled()
        } finally {
            clearActiveEditorView(editor as never)
        }
    })

    it('offers its menu row only on a line that holds a file link', () => {
        const { contributions } = setup()
        const ids = (fileLinkOnLine: boolean) =>
            listCommandMenuItems(contributions, { inTable: false, tableInsertable: true, bodyWritable: true, fileLinkOnLine }).map((i) => i.id)
        expect(ids(true)).toEqual([LINK_COPY_PATH])
        expect(ids(false)).toEqual([])
    })
})
