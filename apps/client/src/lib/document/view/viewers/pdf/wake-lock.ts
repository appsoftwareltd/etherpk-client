/**
 * Keeps the screen on while a PDF is being read: a phone that locks after thirty seconds interrupts
 * a long page. Taken only while the page is visible, and let go after {@link IDLE_MS} without a
 * touch, so a phone left on a table goes to sleep. The browser drops the lock whenever the page is
 * hidden, so it is asked for again when the page comes back.
 */
export const IDLE_MS = 10 * 60 * 1000

export interface KeepScreenOn {
    setEnabled(enabled: boolean): void
    /** The person did something: the idle clock starts again, and a lock that lapsed returns. */
    touched(): void
    destroy(): void
}

interface Sentinel {
    release(): Promise<void>
}

export interface WakeLockDeps {
    request(): Promise<Sentinel>
    visible(): boolean
    onVisibility(listener: () => void): () => void
    setTimer(run: () => void, ms: number): unknown
    clearTimer(timer: unknown): void
}

export function createKeepScreenOn(deps: WakeLockDeps): KeepScreenOn {
    let enabled = false
    let sentinel: Sentinel | null = null
    let asking = false
    let idleTimer: unknown
    let idle = false

    async function take(): Promise<void> {
        if (!enabled || idle || sentinel || asking || !deps.visible()) return
        asking = true
        try {
            const lock = await deps.request()
            // Turned off, or gone idle, while the browser was answering.
            if (!enabled || idle) void lock.release()
            else sentinel = lock
        } catch {
            // Refused (low battery, no permission). The screen simply locks as it normally does.
        } finally {
            asking = false
        }
    }

    function drop(): void {
        void sentinel?.release().catch(() => {})
        sentinel = null
    }

    function armIdle(): void {
        deps.clearTimer(idleTimer)
        idleTimer = deps.setTimer(() => {
            idle = true
            drop()
        }, IDLE_MS)
    }

    const stopWatching = deps.onVisibility(() => {
        // The browser let the lock go when the page was hidden, so what is held is stale.
        if (!deps.visible()) sentinel = null
        else void take()
    })

    return {
        setEnabled(next) {
            enabled = next
            if (!enabled) {
                deps.clearTimer(idleTimer)
                drop()
                return
            }
            idle = false
            armIdle()
            void take()
        },
        touched() {
            if (!enabled) return
            idle = false
            armIdle()
            void take()
        },
        destroy() {
            enabled = false
            deps.clearTimer(idleTimer)
            stopWatching()
            drop()
        },
    }
}

/** The browser's Wake Lock, where there is one; a phone without it locks as it normally does. */
export function browserKeepScreenOn(): KeepScreenOn {
    const wake = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }).wakeLock
    return createKeepScreenOn({
        request: () => (wake ? wake.request('screen') : Promise.reject(new Error('no wake lock'))),
        visible: () => document.visibilityState === 'visible',
        onVisibility: (listener) => {
            document.addEventListener('visibilitychange', listener)
            return () => document.removeEventListener('visibilitychange', listener)
        },
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
}
