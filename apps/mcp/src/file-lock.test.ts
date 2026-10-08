import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { withFileLock } from './file-lock'

const dirs: string[] = []
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function lockedPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-lock-'))
    dirs.push(dir)
    return join(dir, 'thing.json')
}

describe('the file lock', () => {
    it('leaves alone a lock that another holder took over from it', async () => {
        const path = await lockedPath()
        await withFileLock(path, async () => {
            // Taken for dead and replaced while it worked: the successor's lock must survive.
            await writeFile(`${path}.lock`, 'someone else')
        })
        await expect(readFile(`${path}.lock`, 'utf8')).resolves.toBe('someone else')
    })

    it('runs one holder at a time', async () => {
        const path = await lockedPath()
        const order: string[] = []
        const slow = withFileLock(path, async () => {
            order.push('first in')
            await new Promise((resolve) => setTimeout(resolve, 150))
            order.push('first out')
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        await withFileLock(path, async () => {
            order.push('second')
        })
        await slow
        expect(order).toEqual(['first in', 'first out', 'second'])
    })

    it('takes over a lock left behind by a process that died holding it', async () => {
        const path = await lockedPath()
        await writeFile(`${path}.lock`, '')
        const old = new Date(Date.now() - 120_000)
        await utimes(`${path}.lock`, old, old)
        await expect(withFileLock(path, async () => 'ran')).resolves.toBe('ran')
    })

    it('lets one of several waiters take over the same stale lock while the others wait', async () => {
        const path = await lockedPath()
        await writeFile(`${path}.lock`, '')
        const old = new Date(Date.now() - 120_000)
        await utimes(`${path}.lock`, old, old)
        // Every waiter finds the lock stale at once. A waiter that removed it unchecked could
        // remove the lock another had just taken, and the two would then hold it together.
        let inside = 0
        let most = 0
        await Promise.all(
            Array.from({ length: 6 }, () =>
                withFileLock(path, async () => {
                    inside++
                    most = Math.max(most, inside)
                    await new Promise((resolve) => setTimeout(resolve, 30))
                    inside--
                }),
            ),
        )
        expect(most).toBe(1)
    })

    it('leaves a stale lock to the waiter already taking it over, and waits for that waiter', async () => {
        const path = await lockedPath()
        await writeFile(`${path}.lock`, '')
        const old = new Date(Date.now() - 120_000)
        await utimes(`${path}.lock`, old, old)
        // Another waiter found the same stale lock first and is part way through taking it over.
        await writeFile(`${path}.lock.break`, '')
        let ran = false
        const waiting = withFileLock(path, async () => {
            ran = true
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        // That waiter finishes: the stale lock is gone and its own lock is in place.
        await writeFile(`${path}.lock`, 'the other waiter')
        await rm(`${path}.lock.break`)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(ran).toBe(false)
        await expect(readFile(`${path}.lock`, 'utf8')).resolves.toBe('the other waiter')

        await rm(`${path}.lock`)
        await waiting
        expect(ran).toBe(true)
    })

    it('clears a takeover left unfinished by a waiter that died during it', async () => {
        const path = await lockedPath()
        const old = new Date(Date.now() - 120_000)
        for (const left of [`${path}.lock`, `${path}.lock.break`]) {
            await writeFile(left, '')
            await utimes(left, old, old)
        }
        await expect(withFileLock(path, async () => 'ran')).resolves.toBe('ran')
    })
})
