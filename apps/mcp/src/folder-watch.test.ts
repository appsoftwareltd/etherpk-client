import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { watchFolder } from './folder-watch'

/**
 * The watcher is wiring, not behaviour: what is asserted is that it starts on a real directory
 * and stops cleanly, and that a directory it cannot watch is reported rather than thrown, since
 * the per-call reconcile carries on without it. Whether an event arrives is timing the suite
 * does not depend on.
 */

const dirs: string[] = []

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('watchFolder', () => {
    it('starts on a directory and stops without complaint', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-watch-'))
        dirs.push(dir)
        const onError = vi.fn()
        const stop = watchFolder(dir, onError)(() => {})
        expect(onError).not.toHaveBeenCalled()
        stop()
        stop() // idempotent
    })

    it('reports a directory it cannot watch and hands back a no-op stop', () => {
        const onError = vi.fn()
        const stop = watchFolder('/definitely/not/here/etherpk', onError)(() => {})
        expect(onError).toHaveBeenCalledTimes(1)
        expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
        expect(() => stop()).not.toThrow()
    })
})
