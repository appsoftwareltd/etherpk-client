import fc from 'fast-check'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { Locks } from './locks.ts'

describe('Locks', () => {
    it('runs one task at a time for a key, in order, and goes on after a failure', async () => {
        const locks = new Locks()
        const seen: string[] = []
        const first = locks.run('a', async () => { seen.push('1 in'); await delay(10); seen.push('1 out'); throw new Error('no') })
        const second = locks.run('a', async () => { seen.push('2') })
        await expect(first).rejects.toThrow('no')
        await second
        expect(seen).toEqual(['1 in', '1 out', '2'])
    })

    it('keeps nothing once idle', async () => {
        const locks = new Locks()
        await Promise.all([locks.run('a', async () => {}), locks.runBoth('a', 'b', async () => {})])
        await delay(0)
        expect(locks.size).toBe(0)
    })

    it('property: tasks on overlapping keys never overlap, and all end', async () => {
        const pair = fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.constantFrom('a', 'b', 'c'))
        await fc.assert(fc.asyncProperty(fc.array(pair, { maxLength: 12 }), async (pairs) => {
            const locks = new Locks()
            const held = new Set<string>()
            await Promise.all(pairs.map(([a, b]) => locks.runBoth(a, b, async () => {
                for (const key of new Set([a, b])) {
                    expect(held.has(key)).toBe(false)
                    held.add(key)
                }
                await delay(0)
                for (const key of [a, b]) held.delete(key)
            })))
        }), { seed: 20261125, numRuns: 60 })
    })
})
