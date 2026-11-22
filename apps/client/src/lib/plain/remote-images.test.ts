import { describe, expect, it } from 'vitest'

import { createRemoteImageTrust, forgetRemoteImageTrust } from './remote-images'

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    return {
        values,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
    }
}

describe('remote pictures in a Plain Folder', () => {
    it('wait until the person says to load them, and are then remembered for that folder only', () => {
        const storage = memoryStorage()
        const trust = createRemoteImageTrust('garden', storage)
        const told: string[] = []
        trust.onChange(() => told.push('changed'))
        expect(trust.allowed()).toBe(false)

        trust.allow()
        trust.allow()
        expect(trust.allowed()).toBe(true)
        expect(told).toEqual(['changed'])
        expect(createRemoteImageTrust('garden', storage).allowed()).toBe(true)
        expect(createRemoteImageTrust('recipes', storage).allowed()).toBe(false)
    })

    it('are forgotten with the folder', () => {
        const storage = memoryStorage()
        createRemoteImageTrust('garden', storage).allow()
        forgetRemoteImageTrust('garden', storage)
        expect(createRemoteImageTrust('garden', storage).allowed()).toBe(false)
    })

    it('still answer for the visit when storage refuses', () => {
        const refusing = {
            getItem: () => {
                throw new Error('blocked')
            },
            setItem: () => {
                throw new Error('blocked')
            },
            removeItem: () => {},
        }
        const trust = createRemoteImageTrust('garden', refusing)
        expect(trust.allowed()).toBe(false)
        trust.allow()
        expect(trust.allowed()).toBe(true)
    })
})
