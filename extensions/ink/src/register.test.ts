import type { CommandMenuItem, FenceOptions, FenceWidget } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it, vi } from 'vitest'

import { identifyInk, INK_FENCE, strokeLine } from './format'
import { CANNOT_INSERT, inkFile, inkInsertOffered, INSERT_COMMAND, registerInk } from './register'

const header = '{"type":"ink.drawing","version":1,"id":"garden0001","paper":"plain"}'
const stroke = strokeLine({ id: 'aaaaaaaa', tool: 'pen', colour: '#1e1e1e', size: 4, pts: [10, 10, 0.5, 40, 30, 0.5] })

function registered(insertBlock: (text: string, options?: { focus?: boolean }) => boolean = () => true) {
    const fences: { info: string; widget: FenceWidget; options?: FenceOptions }[] = []
    const commands = new Map<string, (arg?: unknown) => unknown>()
    const rows: CommandMenuItem[] = []
    const notify = vi.fn<(text: string) => void>()
    const widget: FenceWidget = { height: () => 120, mount: () => ({ update: () => {}, destroy: () => {} }) }
    registerInk(
        {
            editor: {
                registerFence: (info, w, options) => {
                    fences.push({ info, widget: w, options })
                    return () => {}
                },
                insertBlock,
                openPanel: () => null,
            },
            commands: {
                register: (id, handler) => {
                    commands.set(id, handler)
                    return () => {}
                },
                execute: async () => undefined,
                has: (id) => commands.has(id),
            },
            commandMenu: {
                register: (row) => {
                    rows.push(row)
                    return () => {}
                },
            },
            notify,
        },
        widget,
    )
    return { fences, commands, rows, notify, widget }
}

describe('what Ink registers', () => {
    it('draws its widget over ink.drawing fences in the editor frame, found by the header id, with the editor’s own undo', () => {
        const { fences, widget } = registered()
        expect(fences).toHaveLength(1)
        const [fence] = fences
        expect(fence.info).toBe(INK_FENCE)
        expect(fence.widget).toBe(widget)
        expect(fence.options?.frame).toBe('editor')
        expect(fence.options?.title).toBe('Ink drawing')
        expect(fence.options?.keepsHistory).toBeFalsy()
        expect(fence.options?.identify).toBe(identifyInk)
    })

    it('offers /ink in the Insert group after Excalidraw’s drawing', () => {
        const [row] = registered().rows
        expect(row).toMatchObject({ id: INSERT_COMMAND, title: 'Ink (drawing)', detail: 'Insert an ink drawing for a pen or stylus', group: 'Insert', order: 118, command: INSERT_COMMAND })
        expect(row.keywords).toEqual(expect.arrayContaining(['ink', 'draw', 'pen', 'stylus', 'handwriting', 'whiteboard']))
        expect(row.when).toBe(inkInsertOffered)
    })

    it('offers /ink in a writable body, outside tables and Protected Documents', () => {
        const menu = { inTable: false, tableInsertable: true, bodyWritable: true, protectedDocument: false }
        expect(inkInsertOffered(menu)).toBe(true)
        expect(inkInsertOffered({ ...menu, protectedDocument: undefined })).toBe(true)
        expect(inkInsertOffered({ ...menu, bodyWritable: false })).toBe(false)
        expect(inkInsertOffered({ ...menu, inTable: true })).toBe(false)
        expect(inkInsertOffered({ ...menu, protectedDocument: true })).toBe(false)
    })

    it('puts a new drawing at the caret with the keyboard, and says so when it cannot', () => {
        const insertBlock = vi.fn<(text: string, options?: { focus?: boolean }) => boolean>(() => true)
        const { commands, notify } = registered(insertBlock)
        commands.get(INSERT_COMMAND)!()
        const [text, options] = insertBlock.mock.calls[0]
        expect(text).toMatch(/^```ink\.drawing\n\{"type":"ink\.drawing","version":1,"id":"[0-9a-z]{10}","paper":"plain"\}\n```$/)
        expect(options).toEqual({ focus: true })
        expect(notify).not.toHaveBeenCalled()

        const refused = registered(() => false)
        refused.commands.get(INSERT_COMMAND)!()
        expect(refused.notify).toHaveBeenCalledWith(CANNOT_INSERT)
    })
})

describe('the picture a published site and a quote show', () => {
    it('is an SVG file on white paper, sized to the ink, with alt text', async () => {
        const file = inkFile([header, stroke])!
        expect(file.kind).toBe('picture')
        if (file.kind !== 'picture') return
        expect(file.type).toBe('image/svg+xml')
        const text = new TextDecoder().decode(file.bytes)
        expect(text).toContain('fill="#ffffff"')
        expect(file.width).toBeGreaterThan(30)
        expect(file.alt).toBe('Ink drawing, 1 stroke')
        const { fences } = registered()
        const quoted = await fences[0].options!.quote!({ info: INK_FENCE, body: [header, stroke], document: 'Garden', dark: true })
        expect(quoted).toEqual(file)
    })

    it('is nothing for an empty drawing or one made by a newer version', () => {
        expect(inkFile([header])).toBeNull()
        expect(inkFile(['{"type":"ink.drawing","version":9,"id":"garden0001"}', stroke])).toBeNull()
    })
})
