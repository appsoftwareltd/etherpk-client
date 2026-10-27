import { beforeEach, describe, expect, it } from 'vitest'

import { createFindSession, type DeviceStorage } from './find-session'

/** A device's storage as a map, which can be told to refuse every read and write. */
function storage(refuse = false): DeviceStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem(key) {
            if (refuse) throw new Error('blocked')
            return data.get(key) ?? null
        },
        setItem(key, value) {
            if (refuse) throw new Error('blocked')
            data.set(key, value)
        },
    }
}

describe('the queries of this session', () => {
    let session: ReturnType<typeof createFindSession>
    beforeEach(() => {
        session = createFindSession(storage())
    })

    it('starts with no query', () => {
        expect(session.lastQuery()).toBe('')
        expect(session.history()).toEqual([])
    })

    it('keeps the last query used, for the next box to open with', () => {
        session.remember('Garden')
        session.remember('Kitchen')
        expect(session.lastQuery()).toBe('Kitchen')
    })

    it('keeps each query once, the latest last, and at most twenty', () => {
        for (let i = 0; i < 25; i++) session.remember(`beans ${i}`)
        session.remember('beans 10')
        expect(session.history()).toHaveLength(20)
        expect(session.history().at(-1)).toBe('beans 10')
        expect(session.history().filter((query) => query === 'beans 10')).toHaveLength(1)
    })

    it('ignores an empty query', () => {
        session.remember('Garden')
        session.remember('')
        expect(session.lastQuery()).toBe('Garden')
        expect(session.history()).toEqual(['Garden'])
    })

    it('steps back and forward through the history from what the box holds', () => {
        session.remember('Garden')
        session.remember('Kitchen')
        session.remember('Yard')
        expect(session.step('Yard', -1)).toBe('Kitchen')
        expect(session.step('Kitchen', -1)).toBe('Garden')
        expect(session.step('Garden', -1)).toBe('Garden')
        expect(session.step('Garden', 1)).toBe('Kitchen')
        expect(session.step('Yard', 1)).toBe('Yard')
        // A query typed but not yet used steps back to the latest.
        expect(session.step('bea', -1)).toBe('Yard')
    })

    it('never writes a query to the device, where a secret could stay', () => {
        const device = storage()
        const own = createFindSession(device)
        own.remember('router password')
        own.setOptions({ caseSensitive: true, wholeWord: false, regexp: false })
        expect([...device.data.values()].join()).not.toContain('router')
    })
})

describe("the device's choices", () => {
    it('defaults every match option off and the list to the layout', () => {
        const session = createFindSession(storage())
        expect(session.options()).toEqual({ caseSensitive: false, wholeWord: false, regexp: false })
        expect(session.listShown('desktop')).toBe(true)
        expect(session.listShown('phone')).toBe(false)
    })

    it('keeps the options and the list choice across sessions on one device', () => {
        const device = storage()
        const first = createFindSession(device)
        first.setOptions({ caseSensitive: true, wholeWord: false, regexp: true })
        first.setListShown('desktop', false)
        first.setListShown('phone', true)
        const next = createFindSession(device)
        expect(next.options()).toEqual({ caseSensitive: true, wholeWord: false, regexp: true })
        expect(next.listShown('desktop')).toBe(false)
        expect(next.listShown('phone')).toBe(true)
    })

    it('works for the session when the device refuses its storage', () => {
        const session = createFindSession(storage(true))
        session.setOptions({ caseSensitive: true, wholeWord: true, regexp: false })
        expect(session.options()).toEqual({ caseSensitive: true, wholeWord: true, regexp: false })
    })

    it('reads stored choices it does not understand as the defaults', () => {
        const device = storage()
        device.data.set('etherpk:find', '{"caseSensitive": "yes", "list": 4')
        expect(createFindSession(device).options()).toEqual({ caseSensitive: false, wholeWord: false, regexp: false })
    })
})
