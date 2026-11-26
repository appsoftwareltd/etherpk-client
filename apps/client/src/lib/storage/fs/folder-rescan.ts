/**
 * When a folder other programs also write is looked over: on window focus, on a timer, and, in an
 * installed app whose shell can watch the folder, as changes happen.
 *
 * A browser has no watcher, so its timer is short. Where there is a watch the timer is a backstop for
 * what a watch misses (a network drive that reports nothing, say) and is long. A watch that ends
 * goes back to the short timer at once.
 *
 * Every decision about what a change means belongs to the pass. This only says when one runs, and that
 * two never overlap: a change heard of during a pass runs another after it, since that pass may have
 * read the file before it changed.
 */
import type { FolderWatch } from '../../native/folder-watch'

/** How often a folder with no watch is looked over. */
export const POLL_MS = 4000
/** The same for a folder with one: only what the watch missed is left to find. */
export const WATCHED_POLL_MS = 60_000
/** How long after a change the pass waits for the ones that come with it. */
export const SETTLE_MS = 250
/** The least time between two passes for changes heard of, so that a program writing without pause costs a pass a second. */
export const REST_MS = 1000

export interface FolderRescanOptions {
    /** How often to look the folder over when nothing watches it. */
    pollMs?: number
    watch?: FolderWatch | null
}

/**
 * The paths that changed, or null for a pass that is to look everything over: one on focus or the
 * timer, or one after a change the shell could not place.
 */
export type ChangedPaths = ReadonlySet<string> | null

/** Run `pass` whenever the folder should be looked over. Returns what stops it. */
export function attachFolderRescan(pass: (changed: ChangedPaths) => Promise<void>, { pollMs = POLL_MS, watch = null }: FolderRescanOptions = {}): () => void {
    let running = false
    let stopped = false
    let lastEnded = -Infinity
    let timer: ReturnType<typeof setInterval>
    let soon: ReturnType<typeof setTimeout> | null = null
    /** What has been heard of and not looked over, or null when nothing has. */
    let heard: { paths: Set<string>; everything: boolean } | null = null

    async function run(changed: ChangedPaths): Promise<void> {
        if (running || stopped) return
        running = true
        try {
            await pass(changed)
        } catch (error) {
            // Nothing awaits a pass, so a failed one is logged here rather than left as an unhandled
            // rejection. The next focus, change or tick runs another.
            console.warn('[rescan] a pass over the folder failed; the next one tries again', error)
        } finally {
            running = false
            lastEnded = Date.now()
            if (heard) scheduleHeard()
        }
    }

    function scheduleHeard(): void {
        if (soon !== null || running || stopped) return
        soon = setTimeout(
            () => {
                soon = null
                const now = heard
                heard = null
                if (now) void run(now.everything ? null : now.paths)
            },
            Math.max(SETTLE_MS, lastEnded + REST_MS - Date.now()),
        )
    }

    function hear(paths: readonly string[] | null): void {
        heard ??= { paths: new Set(), everything: false }
        if (paths === null) heard.everything = true
        else for (const path of paths) heard.paths.add(path)
        scheduleHeard()
    }

    function every(ms: number): void {
        clearInterval(timer)
        timer = setInterval(() => void run(null), ms)
    }

    const onFocus = () => void run(null)
    window.addEventListener('focus', onFocus)
    every(watch ? WATCHED_POLL_MS : pollMs)
    const unwatch = watch?.(hear, () => {
        every(pollMs)
        hear(null)
    })

    return () => {
        stopped = true
        window.removeEventListener('focus', onFocus)
        clearInterval(timer)
        if (soon !== null) clearTimeout(soon)
        unwatch?.()
    }
}
