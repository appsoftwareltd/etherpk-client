import { describe, expect, it, vi } from 'vitest'

import { createPersonSettings } from '../person-settings/person-settings'
import { createCommandRegistry, createContributionRegistry, listContextMenuItems } from '../surface'
import { registerFileEditorCommands } from './file-editor-commands'
import { createFileEditors } from './file-editors'

const shown = vi.hoisted(() => [] as string[])
vi.mock('#lib/activity/notices.js', () => ({ showNotice: (notice: { text: string }) => void shown.push(notice.text) }))

function setUp(activePath: string | null = 'README.md') {
    const held = new Map<string, string>()
    const storage = { getItem: (k: string) => held.get(k) ?? null, setItem: (k: string, v: string) => void held.set(k, v), removeItem: (k: string) => void held.delete(k) } as unknown as Storage
    const editors = createFileEditors({ folderId: 'garden', settings: createPersonSettings(() => storage), storage })
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const off = registerFileEditorCommands(commands, contributions, { editors, activePath: () => activePath })
    const rows = (path: string) => listContextMenuItems(contributions, { kind: 'plain-editor', path })
    return { editors, commands, rows, off }
}

describe('the menu of a file’s editors', () => {
    it('lists the two editors of a markdown file with the one in force ticked, then the default', () => {
        const { rows, editors } = setUp()
        expect(rows('README.md').map((row) => [row.label, row.checked, row.separatorBefore])).toEqual([
            ['Markdown Editor', true, false],
            ['Text Editor', false, false],
            ['Make Text Editor the default for markdown files', undefined, true],
        ])
        editors.choose('README.md', 'text')
        expect(rows('README.md').map((row) => row.checked)).toEqual([false, true, undefined])
        // The default's row names the change it makes.
        editors.setDefault('text')
        expect(rows('README.md').at(-1)?.label).toBe('Make Markdown Editor the default for markdown files')
    })

    it('is empty for a file with one editor', () => {
        expect(setUp().rows('water.yaml')).toEqual([])
    })

    it('a row opens that file in that editor, and the default’s row changes the default', async () => {
        const { rows, commands, editors } = setUp()
        const run = (path: string, label: string) => commands.execute(rows(path).find((row) => row.label === label)!.command, { kind: 'plain-editor', path })
        await run('guide/soil.md', 'Text Editor')
        expect(editors.editorOf('guide/soil.md')).toBe('text')
        expect(editors.editorOf('README.md')).toBe('markdown')
        await run('guide/soil.md', 'Make Text Editor the default for markdown files')
        expect(editors.editorOf('README.md')).toBe('text')
    })
})

describe('the switch Command, which a key runs', () => {
    it('puts the file in front in its other editor, and back', async () => {
        const { commands, editors } = setUp()
        await commands.execute('plain.switchEditor')
        expect(editors.editorOf('README.md')).toBe('text')
        await commands.execute('plain.switchEditor')
        expect(editors.editorOf('README.md')).toBe('markdown')
    })

    it('says why it does nothing on a file with one editor, and is quiet with no file in front', async () => {
        shown.length = 0
        await setUp('water.yaml').commands.execute('plain.switchEditor')
        expect(shown).toEqual(['water.yaml opens in the Text Editor only. A markdown file has a choice of editors.'])
        await setUp(null).commands.execute('plain.switchEditor')
        expect(shown).toHaveLength(1)
    })

    it('takes its Commands and rows out again', () => {
        const { off, rows, commands } = setUp()
        off()
        expect(rows('README.md')).toEqual([])
        expect(commands.has('plain.switchEditor')).toBe(false)
    })
})
