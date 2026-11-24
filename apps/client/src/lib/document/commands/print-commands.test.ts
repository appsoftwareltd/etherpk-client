import { afterEach, describe, expect, it, vi } from 'vitest'

import { dismissNotice, getNotices } from '#lib/activity/notices.js'
import { createCommandRegistry, createContributionRegistry, CONTEXT_MENU_KIND, type ContextMenuItem, type ContextMenuTarget } from '#lib/surface/index.js'

import { ProtectedPrintError } from '../print/print-text'
import { PRINT_UNKNOWN } from '../print/print-window'
import { DOCUMENT_PRINT, printKeyAvailable, printSubjectOf, PROTECTED_NOT_PRINTED, registerPrintCommands, type Printable, type PrintCommandDeps, type PrintSubject } from './print-commands'

vi.mock('../print/print.css', () => ({}))

const GARDEN: PrintSubject = { kind: 'document', target: 'Garden' }
const TAB: ContextMenuTarget = { kind: 'document-tab', concept: 'Garden', panelId: 'p1' }

function rig(over: Partial<PrintCommandDeps> = {}, printable: Printable = 'yes') {
    const commands = createCommandRegistry()
    const contributions = createContributionRegistry()
    const print = vi.fn<PrintCommandDeps['print']>(async (_subject, onReady) => {
        onReady()
        return 'printed'
    })
    const deps: PrintCommandDeps = { printable: () => printable, nameOf: (subject) => subject.target, active: () => GARDEN, print, ...over }
    const stop = registerPrintCommands(commands, contributions, deps)
    const rows = (target: ContextMenuTarget) => contributions.list(CONTEXT_MENU_KIND).map((entry) => entry.value as ContextMenuItem).filter((item) => item.when?.(target) ?? true).map((item) => item.label)
    return { run: (arg?: unknown) => commands.execute(DOCUMENT_PRINT, arg), print, rows, stop }
}

afterEach(() => {
    for (const notice of getNotices()) dismissNotice(notice.id)
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('what a menu would print', () => {
    it('is a document, a drawing in its own tab, or a file of a Plain Folder', () => {
        expect(printSubjectOf(TAB)).toEqual(GARDEN)
        expect(printSubjectOf({ kind: 'tab', panelId: 'p', view: { kind: 'fence', target: '["Garden","a.b","1"]' } })).toEqual({ kind: 'fence', target: '["Garden","a.b","1"]' })
        expect(printSubjectOf({ kind: 'tab', panelId: 'p', view: { kind: 'document', target: 'notes/a.md' } })).toEqual({ kind: 'document', target: 'notes/a.md' })
        expect(printSubjectOf({ kind: 'tab', panelId: 'p', view: { kind: 'kanban.board', target: 'Garden' } })).toBeNull()
        expect(printSubjectOf({ kind: 'tab', panelId: 'p' })).toBeNull()
    })
})

describe('Print or save as PDF…', () => {
    it('is offered where the subject prints, and nowhere else', () => {
        expect(rig().rows(TAB)).toEqual(['Print or save as PDF…'])
        expect(rig({}, 'protected').rows(TAB)).toEqual([])
        expect(rig({}, 'no').rows(TAB)).toEqual([])
    })

    it('prints the menu’s document, and what is in front when there is no menu', async () => {
        const { run, print } = rig({ active: () => ({ kind: 'document', target: 'Kitchen' }) })
        await run(TAB)
        await run()
        // The Command Menu hands its editor's context, which names no target.
        await run({ inTable: false })
        expect(print.mock.calls.map(([subject]) => subject.target)).toEqual(['Garden', 'Kitchen', 'Kitchen'])
    })

    it('prints nothing of a Protected Document, and says so', async () => {
        const { run, print } = rig({}, 'protected')
        await run()
        expect(print).not.toHaveBeenCalled()
        expect(getNotices().map((notice) => notice.text)).toEqual([PROTECTED_NOT_PRINTED])
    })

    it('says the same where the document was protected as the print was prepared', async () => {
        await rig({ print: () => Promise.reject(new ProtectedPrintError('x')) }).run()
        expect(getNotices().map((notice) => [notice.tone, notice.text])).toEqual([['info', PROTECTED_NOT_PRINTED]])
    })

    it('says it is preparing only where that takes a moment, and stops saying so as the dialog opens', async () => {
        vi.useFakeTimers()
        let ready = () => {}
        let close: (outcome: 'printed') => void = () => {}
        const { run } = rig({ print: (_subject, onReady) => ((ready = onReady), new Promise((resolve) => (close = resolve))) })
        void run()
        await vi.advanceTimersByTimeAsync(200)
        expect(getNotices()).toEqual([])
        await vi.advanceTimersByTimeAsync(200)
        expect(getNotices().map((notice) => notice.text)).toEqual(['Preparing "Garden" to print…'])
        ready()
        expect(getNotices()).toEqual([])
        close('printed')
        await vi.advanceTimersByTimeAsync(1000)
        expect(getNotices()).toEqual([])
    })

    it('starts one print for two presses', async () => {
        let close: (outcome: 'printed') => void = () => {}
        const print = vi.fn<PrintCommandDeps['print']>(() => new Promise((resolve) => (close = resolve)))
        const { run } = rig({ print })
        const first = run()
        await run()
        expect(print).toHaveBeenCalledTimes(1)
        close('printed')
        await first
        void run()
        expect(print).toHaveBeenCalledTimes(2)
    })

    it('says why it could not print, and that it could not tell', async () => {
        await rig({ print: () => Promise.reject(new Error('Its extension is switched off or not installed')) }).run()
        expect(getNotices().map((notice) => [notice.tone, notice.text])).toEqual([['error', '"Garden" could not be printed. Its extension is switched off or not installed.']])
        await rig({ print: async () => 'unknown' }).run()
        expect(getNotices().at(-1)?.text).toBe(PRINT_UNKNOWN)
    })

    it('takes the key only while something in front prints or is protected, and no dialog is open', () => {
        vi.stubGlobal('document', { querySelector: () => null })
        const { stop } = rig({}, 'protected')
        expect(printKeyAvailable()).toBe(true)
        vi.stubGlobal('document', { querySelector: () => ({}) })
        expect(printKeyAvailable()).toBe(false)
        vi.stubGlobal('document', { querySelector: () => null })
        stop()
        expect(printKeyAvailable()).toBe(false)
        const none = rig({ active: () => null })
        expect(printKeyAvailable()).toBe(false)
        none.stop()
        const map = rig({}, 'no')
        expect(printKeyAvailable()).toBe(false)
        map.stop()
    })
})
