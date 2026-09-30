import { describe, expect, it } from 'vitest'

import { createCommandRegistry } from '../../surface/command-registry'
import { listCommandMenuItems } from '../../surface/command-menu'
import { createContributionRegistry } from '../../surface/contribution-registry'
import { parseTaskReference, taskFingerprint } from '../task-reference'
import { copyTaskReference, registerTaskReferenceCommands, TASK_COPY_REFERENCE, type TaskReferenceCommandDeps } from './task-reference-commands'

// Copy task reference (ADR 0114): a task's words and address on the clipboard, for a person to
// hand to an agent, said in a notice because the clipboard shows nothing of its own.

function deps(options: { refuse?: boolean } = {}) {
    const copied: string[] = []
    const notices: Array<[string, string]> = []
    const value: TaskReferenceCommandDeps = {
        graphId: () => 'g-1',
        origin: () => 'https://app.example.com',
        writeClipboard: async (text) => {
            if (options.refuse) throw new Error('Clipboard access was denied')
            copied.push(text)
        },
        notify: (text, tone) => void notices.push([tone, text]),
    }
    return { value, copied, notices }
}

describe('copying a task reference', () => {
    it('puts the words and the address on the clipboard, and says what it copied', async () => {
        const { value, copied, notices } = deps()
        expect(await copyTaskReference({ document: 'Acme', line: 3, label: '#P1 Send the quote' }, value)).toBe(true)
        expect(copied).toEqual([`Send the quote\nhttps://app.example.com/g/g-1/d/Acme#task=3-${await taskFingerprint('Send the quote')}`])
        expect(parseTaskReference(copied[0])).toMatchObject({ graphId: 'g-1', document: 'Acme', line: 3 })
        expect(notices).toEqual([['info', 'Copied a reference to "Send the quote". Paste it to an agent connected to this graph.']])
    })

    it('says why when the clipboard refuses', async () => {
        const { value, notices } = deps({ refuse: true })
        expect(await copyTaskReference({ document: 'Acme', line: 3, label: 'Send the quote' }, value)).toBe(false)
        expect(notices).toEqual([['error', 'Could not copy the task reference: Clipboard access was denied']])
    })

    it('copies a task named in the Command, as a board card passes it', async () => {
        const commands = createCommandRegistry()
        const { value, copied } = deps()
        registerTaskReferenceCommands(commands, createContributionRegistry(), value)
        await commands.execute(TASK_COPY_REFERENCE, { document: 'Acme', line: 0, label: 'Send the quote' })
        expect(copied).toHaveLength(1)
    })

    it('is a Command Menu row only while the caret is on a task line', () => {
        const contributions = createContributionRegistry()
        registerTaskReferenceCommands(createCommandRegistry(), contributions, deps().value)
        const context = { inTable: false, tableInsertable: true, bodyWritable: true }
        expect(listCommandMenuItems(contributions, { ...context, taskOnLine: true }).map((item) => item.title)).toContain('Copy task reference')
        expect(listCommandMenuItems(contributions, context).map((item) => item.title)).not.toContain('Copy task reference')
    })
})
