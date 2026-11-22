import { describe, expect, it } from 'vitest'

import { createCommandRegistry } from '../../surface'

import { registerFindCommands } from './find-commands'

describe('the Find and Replace Commands', () => {
    it('registers all six, and takes them out again', () => {
        const commands = createCommandRegistry()
        const detach = registerFindCommands(commands)
        const ids = ['document.find', 'document.findReplace', 'document.findNext', 'document.findPrevious', 'document.findNextLine', 'document.findPreviousLine']
        for (const id of ids) expect(commands.has(id)).toBe(true)
        detach()
        for (const id of ids) expect(commands.has(id)).toBe(false)
    })
})
