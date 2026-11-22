import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { readPlainSettings, writePastedFiles } from './plain-settings'
import { createPlainStateFolder } from './plain-state-folder'

describe('the settings a Plain Folder keeps for everyone who opens it', () => {
    it('takes the defaults, and writes nothing, until one is changed', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1 })
        const folder = createPlainStateFolder(tree)
        expect(await readPlainSettings(folder)).toEqual({ pastedFiles: 'assets' })
        await writePastedFiles(folder, 'assets')
        expect(await tree.stat('.etherpk')).toBeNull()
    })

    it('keeps a changed setting as a file of its own, and removes it when the default is chosen again', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1 })
        const folder = createPlainStateFolder(tree)
        await writePastedFiles(folder, 'named')
        expect(new TextDecoder().decode((await tree.read('.etherpk/settings/pasted-files.json')).bytes)).toBe('{\n  "placement": "named"\n}\n')
        expect(await readPlainSettings(createPlainStateFolder(tree))).toEqual({ pastedFiles: 'named' })
        await writePastedFiles(folder, 'assets')
        expect(await tree.stat('.etherpk/settings/pasted-files.json')).toBeNull()
    })

    it('takes the default for a value it does not understand', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { '.etherpk/settings/pasted-files.json': '{"placement":"elsewhere"}', '.etherpk/settings/later.json': '{"x":1}' } })
        expect(await readPlainSettings(createPlainStateFolder(tree))).toEqual({ pastedFiles: 'assets' })
    })
})
