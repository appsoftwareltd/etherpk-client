import { describe, expect, it } from 'vitest'

import { createCommandRegistry, isRegisterableCommandId } from './command-registry'

describe('command registry', () => {
    it('registers and executes, always returning a Promise', async () => {
        const reg = createCommandRegistry()
        reg.register('layout.toggleSidebar', () => 'done')
        const result = reg.execute('layout.toggleSidebar')
        expect(result).toBeInstanceOf(Promise)
        expect(await result).toBe('done')
    })

    it('passes the argument and awaits async handlers', async () => {
        const reg = createCommandRegistry()
        reg.register('document.open', async (arg) => `opened ${arg}`)
        expect(await reg.execute('document.open', 'Physics')).toBe('opened Physics')
    })

    it('throws on a duplicate id (never last-wins)', () => {
        const reg = createCommandRegistry()
        reg.register('a.b', () => {})
        expect(() => reg.register('a.b', () => {})).toThrow(/already registered/)
    })

    it('throws executing an unknown command', async () => {
        const reg = createCommandRegistry()
        await expect(reg.execute('nope.missing')).rejects.toThrow(/No command/)
    })

    it('unregister withdraws exactly its handler', () => {
        const reg = createCommandRegistry()
        const off = reg.register('a.b', () => {})
        expect(reg.has('a.b')).toBe(true)
        off()
        expect(reg.has('a.b')).toBe(false)
    })

    it('rejects ids containing the reserved : separator', () => {
        const reg = createCommandRegistry()
        expect(isRegisterableCommandId('layout.toggleSidebar')).toBe(true)
        expect(isRegisterableCommandId('acme.flow')).toBe(true)
        expect(isRegisterableCommandId('bad:id')).toBe(false)
        expect(isRegisterableCommandId('')).toBe(false)
        expect(() => reg.register('bad:id', () => {})).toThrow(/not registerable/)
    })

    it('isolates a throwing handler to its own execute (rejects, no corruption)', async () => {
        const reg = createCommandRegistry()
        reg.register('boom', () => {
            throw new Error('kaboom')
        })
        reg.register('fine', () => 'ok')
        await expect(reg.execute('boom')).rejects.toThrow('kaboom')
        expect(await reg.execute('fine')).toBe('ok')
    })
})
