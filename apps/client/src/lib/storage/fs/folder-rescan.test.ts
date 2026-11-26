import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachFolderRescan, type ChangedPaths, POLL_MS, REST_MS, SETTLE_MS, WATCHED_POLL_MS } from './folder-rescan'

let focus: Set<() => void>

beforeEach(() => {
    vi.useFakeTimers()
    focus = new Set()
    vi.stubGlobal('window', {
        addEventListener: (_: string, listener: () => void) => focus.add(listener),
        removeEventListener: (_: string, listener: () => void) => focus.delete(listener),
    })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A watch the test drives, and the passes it led to. */
function watched(pass: (changed: ChangedPaths) => Promise<void> = async () => {}) {
    const passes: ChangedPaths[] = []
    let hear: (paths: readonly string[] | null) => void = () => {}
    let lose: () => void = () => {}
    const stopped = vi.fn()
    const detach = attachFolderRescan(
        async (changed) => {
            passes.push(changed && new Set(changed))
            await pass(changed)
        },
        {
            watch: (changed, lost) => {
                hear = changed
                lose = lost
                return stopped
            },
        },
    )
    return { passes, detach, stopped, hear: (paths: readonly string[] | null) => hear(paths), lose: () => lose() }
}

describe('a folder with no watch', () => {
    it('is looked over on focus and every few seconds', async () => {
        const pass = vi.fn(async () => {})
        const detach = attachFolderRescan(pass)
        for (const listener of focus) listener()
        expect(pass).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(POLL_MS * 2)
        expect(pass).toHaveBeenCalledTimes(3)
        detach()
        await vi.advanceTimersByTimeAsync(POLL_MS * 2)
        expect(pass).toHaveBeenCalledTimes(3)
        expect(focus.size).toBe(0)
    })

    it('never has two passes at once, and goes on after one that fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let release: (() => void) | undefined
        let inFlight = 0
        let most = 0
        const detach = attachFolderRescan(async () => {
            most = Math.max(most, ++inFlight)
            await new Promise<void>((resolve) => (release = resolve))
            inFlight--
            throw new Error('the folder could not be read')
        })
        await vi.advanceTimersByTimeAsync(POLL_MS)
        for (const listener of focus) listener()
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(most).toBe(1)
        release?.()
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(warn).toHaveBeenCalledTimes(1)
        expect(inFlight).toBe(1)
        detach()
        release?.()
        warn.mockRestore()
    })
})

describe('a watched folder', () => {
    it('is looked over soon after a change, once for the changes that come together', async () => {
        const { hear, passes, detach } = watched()
        hear(['a.md'])
        hear(['b.md', 'a.md'])
        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
        expect(passes).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        expect(passes).toEqual([new Set(['a.md', 'b.md'])])
        detach()
    })

    it('looks everything over when the shell cannot say what changed', async () => {
        const { hear, passes, detach } = watched()
        hear(['a.md'])
        hear(null)
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(passes).toEqual([null])
        detach()
    })

    it('looks again after a pass for a change heard of during it', async () => {
        let release: () => void = () => {}
        const { hear, passes, detach } = watched(() => new Promise<void>((resolve) => (release = resolve)))
        hear(['a.md'])
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        hear(['b.md'])
        await vi.advanceTimersByTimeAsync(REST_MS * 5)
        expect(passes).toHaveLength(1)
        release()
        await vi.advanceTimersByTimeAsync(REST_MS)
        expect(passes).toEqual([new Set(['a.md']), new Set(['b.md'])])
        release()
        detach()
    })

    it('rests between passes when the folder never stops changing', async () => {
        const { hear, passes, detach } = watched()
        for (let at = 0; at < 100; at++) {
            hear(['a.md'])
            await vi.advanceTimersByTimeAsync(100)
        }
        expect(passes.length).toBeGreaterThan(5)
        expect(passes.length).toBeLessThanOrEqual(11)
        detach()
    })

    it('keeps a slow timer and the look on focus as a backstop', async () => {
        const { passes, detach } = watched()
        await vi.advanceTimersByTimeAsync(WATCHED_POLL_MS - 1)
        expect(passes).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        for (const listener of focus) listener()
        expect(passes).toEqual([null, null])
        detach()
    })

    it('goes back to the short timer, and looks at once, when the watch is lost', async () => {
        const { lose, passes, detach } = watched()
        lose()
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(passes).toEqual([null])
        await vi.advanceTimersByTimeAsync(POLL_MS)
        expect(passes).toEqual([null, null])
        detach()
    })

    it('ends the watch and everything scheduled', async () => {
        const { hear, passes, stopped, detach } = watched()
        hear(['a.md'])
        detach()
        await vi.advanceTimersByTimeAsync(WATCHED_POLL_MS * 2)
        expect(passes).toEqual([])
        expect(stopped).toHaveBeenCalledTimes(1)
    })
})
